#!/usr/bin/env python3
"""Read the exact two release packages in one explicitly selected Android profile."""
import argparse
import hmac
import json
import os
import re
import stat
import subprocess
import sys

PACKAGES = {
    "staff": "rw.ikanisa.burimunsi.staff.cloud",
    "admin_sync": "rw.ikanisa.burimunsi.gateway.cloud",
}
PLAY = "com.android.vending"
POSITIVE_NUMBER = re.compile(r"[1-9][0-9]{0,17}")
SERIAL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
RESULT_LIMIT = 32_768
LIMIT = (
    "Installer of record is corroboration only. This does not prove an actual Play "
    "update, managed organization targeting, signing lineage, continuity, or operator acceptance."
)


class ReadbackError(Exception):
    """A bounded failure reason that never includes raw input."""


def package_readback(output, package, expected_version):
    if len(output) > RESULT_LIMIT:
        raise ReadbackError("package response exceeded bound")
    lines = [line.split() for line in output.splitlines() if line.strip()]
    if any(not row[0].startswith("package:") for row in lines):
        raise ReadbackError("unexpected Android package response")
    # pm accepts a substring filter. Never conflate sandbox or other package IDs.
    exact = [row for row in lines if row[0] == f"package:{package}"]
    if not exact:
        return {"installed": False, "evidence": "not_installed_in_profile"}
    if len(exact) != 1:
        raise ReadbackError("ambiguous exact package response")
    rest = exact[0][1:]
    versions = [token[12:] for token in rest if token.startswith("versionCode:")]
    installers = [token[10:] for token in rest if token.startswith("installer=")]
    if len(rest) != 2 or len(versions) != 1 or len(installers) != 1:
        raise ReadbackError("missing or ambiguous package metadata")
    version, installer = versions[0], installers[0]
    if not POSITIVE_NUMBER.fullmatch(version) or not re.fullmatch(r"[A-Za-z0-9_.]{1,255}", installer):
        raise ReadbackError("invalid package metadata")
    installer_kind = ("play" if installer == PLAY else
                      "none_reported" if installer == "null" else "other")
    version_matches = int(version) == expected_version
    if not version_matches:
        evidence = "different_version"
    elif installer_kind == "play":
        evidence = "expected_version_play_installer_reported"
    else:
        evidence = "expected_version_without_play_installer_evidence"
    return {"installed": True, "version_code": int(version), "version_matches": version_matches,
            "installer_kind": installer_kind, "evidence": evidence}


def read_device(shell, profile, expected_version):
    if type(profile) is not int or not 0 <= profile <= 21_474_835:
        raise ReadbackError("profile must be a nonnegative Android user ID")
    if type(expected_version) is not int or not POSITIVE_NUMBER.fullmatch(str(expected_version)):
        raise ReadbackError("expected version must be a positive version code")
    api = shell("getprop", "ro.build.version.sdk").strip()
    qemu = shell("getprop", "ro.kernel.qemu").strip()
    if not api.isascii() or not api.isdecimal() or len(api) > 3 or int(api) < 30:
        raise ReadbackError("use Android 11 or later for this Play qualification check")
    if qemu not in {"", "0"}:
        raise ReadbackError("Play field evidence requires a physical device")
    # Distinguish a wrong profile or missing Play client from both apps being absent.
    play_list = shell("pm", "list", "packages", "--user", str(profile), PLAY)
    if f"package:{PLAY}" not in play_list.splitlines():
        raise ReadbackError("Play Store package not visible in the selected Android profile")
    roles = {}
    for role, package in PACKAGES.items():
        output = shell("pm", "list", "packages", "-i", "--show-versioncode", "--user", str(profile), package)
        roles[role] = package_readback(output, package, expected_version)
    return {"schema_version": 1, "android_api": int(api), "expected_version_code": expected_version,
            "roles": roles, "managed_play_update_proven": False, "interpretation": LIMIT}


def adb_shell(adb, serial):
    if not SERIAL.fullmatch(serial) or serial.startswith("emulator-"):
        raise ReadbackError("specify the exact physical-device ADB serial")

    def shell(*args):
        try:
            result = subprocess.run([adb, "-s", serial, "shell", *args], capture_output=True,
                                    check=False, timeout=15)
            if result.returncode or result.stderr or len(result.stdout) > RESULT_LIMIT:
                raise ReadbackError("ADB read failed for the selected physical device/profile")
            return result.stdout.decode("utf-8", errors="strict")
        except (OSError, subprocess.SubprocessError, UnicodeError):
            raise ReadbackError("ADB read unavailable for the selected physical device/profile") from None
    return shell


def read_private(path, limit):
    """Read one owned regular file without following links."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        metadata = os.fstat(source.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > limit):
            raise ReadbackError("use an owned private regular evidence file (mode 0600)")
        raw = source.read(limit + 1)
        if len(raw) > limit:
            raise ReadbackError("private evidence exceeded bound")
        return raw


def bind_profile(result, key, serial, profile, phase):
    if len(key) != 32:
        raise ReadbackError("comparison key must contain exactly 32 random bytes")
    subject = f"burimunsi-play-v2\x00{serial}\x00{profile}".encode("ascii")
    return {**result, "schema_version": 2, "phase": phase,
            "profile_binding": hmac.digest(key, subject, "sha256").hex()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--profile", required=True, type=int, help="explicit Android user ID")
    parser.add_argument("--expected-version", required=True, type=int)
    parser.add_argument("--pair-key-file", help="private 32-byte key reused for one before/after pair")
    parser.add_argument("--phase", choices=["before", "after"])
    args = parser.parse_args()
    if bool(args.pair_key_file) != bool(args.phase):
        parser.error("--pair-key-file and --phase must be supplied together")
    try:
        key = read_private(args.pair_key_file, 32) if args.pair_key_file else None
        result = read_device(adb_shell(args.adb, args.serial), args.profile, args.expected_version)
        if key is not None:
            result = bind_profile(result, key, args.serial, args.profile, args.phase)
    except OSError:
        print(json.dumps({"status": "blocked", "reason": "cannot read private comparison key"}))
        return 2
    except ReadbackError as e:
        print(json.dumps({"status": "blocked", "reason": str(e)}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
