#!/usr/bin/env python3
"""Compare private package readbacks; never certifies managed Play acceptance."""
import argparse
import hmac
import json
import re
import sys

from managed_play_device_readback import PACKAGES, POSITIVE_NUMBER, ReadbackError, read_private

LIMIT = 4096


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def positive(value):
    return type(value) is int and POSITIVE_NUMBER.fullmatch(str(value)) is not None


def validate(data, phase):
    if (not isinstance(data, dict) or type(data.get("schema_version")) is not int
            or data["schema_version"] != 2 or data.get("phase") != phase
            or data.get("managed_play_update_proven") is not False
            or type(data.get("android_api")) is not int or not 30 <= data["android_api"] <= 999
            or not positive(data.get("expected_version_code"))
            or not isinstance(data.get("profile_binding"), str)
            or re.fullmatch(r"[0-9a-f]{64}", data["profile_binding"]) is None
            or not isinstance(data.get("roles"), dict) or set(data["roles"]) != set(PACKAGES)):
        raise ValueError("incomplete, reversed, or unbound readback")
    for item in data["roles"].values():
        if not isinstance(item, dict) or type(item.get("installed")) is not bool:
            raise ValueError("incorrect role status")
        if not item["installed"]:
            if item != {"installed": False, "evidence": "not_installed_in_profile"}:
                raise ValueError("inconsistent absent package")
        else:
            version = item.get("version_code")
            installer = item.get("installer_kind")
            match = version == data["expected_version_code"]
            evidence = ("different_version" if not match else
                        "expected_version_play_installer_reported" if installer == "play" else
                        "expected_version_without_play_installer_evidence")
            if (not positive(version) or installer not in ("play", "other", "none_reported")
                    or item.get("version_matches") is not match or item.get("evidence") != evidence):
                raise ValueError("inconsistent package version or installer")


def compare(before, after):
    validate(before, "before")
    validate(after, "after")
    if not hmac.compare_digest(before["profile_binding"], after["profile_binding"]):
        raise ValueError("readbacks are not bound to the same selected device/profile and comparison key")
    target = before["expected_version_code"]
    if target != after["expected_version_code"]:
        raise ValueError("release target changed")
    if before["android_api"] != after["android_api"]:
        raise ValueError("Android API changed during comparison")
    outcomes = {}
    for role in PACKAGES:
        old, new = before["roles"][role], after["roles"][role]
        if not new["installed"] or not new["version_matches"]:
            status = "target_not_observed"
        elif new["installer_kind"] != "play":
            status = "target_without_play_installer"
        elif not old["installed"]:
            status = "new_install_consistent"
        elif old["version_code"] == target:
            status = "already_at_target_no_upgrade_evidence"
        elif old["version_code"] > target:
            status = "downgrade_not_qualifying"
        elif old["installer_kind"] != "play":
            status = "non_play_baseline_not_a_managed_play_upgrade"
        else:
            status = "play_upgrade_consistent"
        outcomes[role] = status
    return {"target_version": target, "roles": outcomes, "managed_play_update_proven": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before")
    parser.add_argument("after")
    try:
        args = parser.parse_args()
        before, after = (json.loads(read_private(path, LIMIT), object_pairs_hook=unique)
                         for path in (args.before, args.after))
        result = compare(before, after)
    except (OSError, ReadbackError, ValueError, RecursionError):
        print(json.dumps({"status": "blocked", "reason": "missing, private-file, invalid, or mismatched readbacks"}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if all(status == "play_upgrade_consistent" for status in result["roles"].values()) else 3


if __name__ == "__main__":
    sys.exit(main())
