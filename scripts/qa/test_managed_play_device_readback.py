from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import managed_play_device_readback as probe
import managed_play_device_compare as reviewer

STAFF = probe.PACKAGES["staff"]
ADMIN = probe.PACKAGES["admin_sync"]


def record(package, version=74, installer=probe.PLAY):
    return f"package:{package} versionCode:{version}  installer={installer}\n"


def device(*args):
    replies = {
        ("getprop", "ro.build.version.sdk"): "33\n",
        ("getprop", "ro.kernel.qemu"): "\n",
        ("pm", "list", "packages", "--user", "10", probe.PLAY): "package:com.android.vending\n",
        ("pm", "list", "packages", "-i", "--show-versioncode", "--user", "10", STAFF): record(STAFF),
        ("pm", "list", "packages", "-i", "--show-versioncode", "--user", "10", ADMIN): record(ADMIN, 74, "null"),
    }
    return replies[args]


class PlayReadbackTest(unittest.TestCase):
    def test_mixed_install_evidence_does_not_certify_managed_play(self):
        result = probe.read_device(device, 10, 74)
        self.assertFalse(result["managed_play_update_proven"])
        self.assertEqual(result["roles"]["staff"]["evidence"], "expected_version_play_installer_reported")
        self.assertEqual(result["roles"]["admin_sync"]["evidence"], "expected_version_without_play_installer_evidence")

    def test_exact_app_id_not_an_offline_or_predecessor_package(self):
        output = record(STAFF + ".nativeTest") + record(STAFF + ".debug")
        self.assertEqual(probe.package_readback(output, STAFF, 74)["evidence"], "not_installed_in_profile")

    def test_mismatched_version_not_masked_by_play_installer(self):
        result = probe.package_readback(record(STAFF, 73), STAFF, 74)
        self.assertEqual(result["evidence"], "different_version")
        self.assertFalse(result["version_matches"])

    def test_third_party_installer_not_retained(self):
        result = probe.package_readback(record(STAFF, installer="com.private.mdm"), STAFF, 74)
        self.assertEqual(result["installer_kind"], "other")
        self.assertNotIn("com.private", json.dumps(result))

    def test_duplicate_or_malformed_response_rejected(self):
        for line in (record(STAFF) * 2, f"package:{STAFF} installer=null\n",
                     record(STAFF, version="0"), record(STAFF, installer=""),
                     f"package:{STAFF} versionCode:74 installer=hello secret=oops",
                     "Error: Unknown user: 10\n", "x" * 33_000):
            with self.subTest(line=line[:120]), self.assertRaises(probe.ReadbackError):
                probe.package_readback(line, STAFF, 74)

    def test_reject_emulator_even_if_package_data_exists(self):
        def emulator(*args):
            return "1\n" if args[-1] == "ro.kernel.qemu" else device(*args)
        with self.assertRaisesRegex(probe.ReadbackError, "physical"):
            probe.read_device(emulator, 10, 74)

    def test_reject_missing_play_in_selected_profile(self):
        def no_play(*args):
            return "package:com.android.vending.helper\n" if args[-1] == probe.PLAY else device(*args)
        with self.assertRaisesRegex(probe.ReadbackError, "not visible"):
            probe.read_device(no_play, 10, 74)

    def test_explicit_device_and_read_only_allowance(self):
        with patch.object(probe.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stdout=b"33\n", stderr=b"")) as cmd:
            shell = probe.adb_shell("adb", "example-device")
            self.assertEqual(shell("getprop", "ro.build.version.sdk"), "33\n")
            self.assertEqual(cmd.call_args[0][0], ["adb", "-s", "example-device", "shell", "getprop",
                                                  "ro.build.version.sdk"])
        for bad in ("", "bad serial", "--one", "emulator-5554"):
            with self.assertRaises(probe.ReadbackError):
                probe.adb_shell("adb", bad)

    def test_adb_error_has_no_raw_output_or_device_identifiers(self):
        with patch.object(probe.subprocess, "run", return_value=SimpleNamespace(
                returncode=1, stdout=b"private", stderr=b"secret")):
            with self.assertRaisesRegex(probe.ReadbackError, "^ADB read failed for the selected physical device/profile$"):
                probe.adb_shell("adb", "example-device")("getprop", "x")

    def test_invalid_profile_and_expected_version_rejected_before_reads(self):
        with self.assertRaisesRegex(probe.ReadbackError, "profile"):
            probe.read_device(None, -1, 74)
        with self.assertRaisesRegex(probe.ReadbackError, "version"):
            probe.read_device(None, 10, 0)

class PlayPairTest(unittest.TestCase):
    key = bytes(range(32))
    device_token = "synthetic-device"

    def snapshots(self, before, after, *, serial=None, profile=10, key=None, target=74):
        def snapshot(phase, installed):
            roles = {r: probe.package_readback(record(p, *installed), p, target) if installed
                     else probe.package_readback("", p, target) for r, p in probe.PACKAGES.items()}
            return probe.bind_profile(
                {"android_api": 33, "expected_version_code": target, "roles": roles,
                 "managed_play_update_proven": False},
                key or self.key, serial or self.device_token, profile, phase)
        return snapshot("before", before), snapshot("after", after)

    def test_consistent_upgrade_is_not_managed_play_attestation(self):
        before, after = self.snapshots((73, probe.PLAY), (74, probe.PLAY))
        for record_json in (before, after):
            self.assertNotIn(self.device_token, json.dumps(record_json))
        result = reviewer.compare(before, after)
        self.assertFalse(result["managed_play_update_proven"])
        self.assertNotIn("profile_binding", result)
        self.assertEqual(set(result["roles"].values()), {"play_upgrade_consistent"})

    def test_classifies_new_install_same_version_sideload_downgrade_and_missing_target(self):
        for old, new, label in (
            (None, (74, probe.PLAY), "new_install_consistent"),
            ((74, probe.PLAY), (74, probe.PLAY), "already_at_target_no_upgrade_evidence"),
            ((75, probe.PLAY), (74, probe.PLAY), "downgrade_not_qualifying"),
            ((73, "null"), (74, probe.PLAY), "non_play_baseline_not_a_managed_play_upgrade"),
            ((73, probe.PLAY), (74, "null"), "target_without_play_installer"),
            ((73, probe.PLAY), (73, probe.PLAY), "target_not_observed"),
            ((73, probe.PLAY), None, "target_not_observed"),
        ):
            with self.subTest(label=label):
                self.assertEqual(set(reviewer.compare(*self.snapshots(old, new))["roles"].values()), {label})

    def test_same_profile_same_key_same_target_and_correct_phase_required(self):
        before, after = self.snapshots((73, probe.PLAY), (74, probe.PLAY))
        for change in ({"serial":"different"}, {"profile":11}, {"key":bytes(32)}, {"target":75}):
            with self.subTest(change=list(change)), self.assertRaises(ValueError):
                reviewer.compare(before, self.snapshots((73, probe.PLAY), (74, probe.PLAY), **change)[1])
        with self.assertRaises(ValueError):
            reviewer.compare(after, before)
        for field, value in (("android_api", 34), ("managed_play_update_proven", True), ("schema_version", 1)):
            changed = {**after, field: value}
            with self.assertRaises(ValueError):
                reviewer.compare(before, changed)

    def test_inconsistent_role_or_duplicate_json_not_accepted(self):
        before, after = self.snapshots((73, probe.PLAY), (74, probe.PLAY))
        broken = deepcopy(after)
        broken["roles"]["staff"]["version_matches"] = False
        with self.assertRaises(ValueError):
            reviewer.compare(before, broken)
        with self.assertRaises(ValueError):
            reviewer.compare(before, {**after, "roles": {}})
        with self.assertRaises(ValueError):
            json.loads('{"phase":"before","phase":"after"}', object_pairs_hook=reviewer.unique)

    def test_bounded_owned_evidence_does_not_follow_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "key"
            path.write_bytes(self.key)
            path.chmod(0o600)
            self.assertEqual(probe.read_private(path, 32), self.key)
            with self.assertRaises(probe.ReadbackError):
                probe.read_private(path, 31)
            alias = Path(directory) / "alias"
            alias.symlink_to(path)
            with self.assertRaises(OSError):
                probe.read_private(alias, 32)
            path.chmod(0o644)
            with self.assertRaises(probe.ReadbackError):
                probe.read_private(path, 32)


if __name__ == "__main__":
    unittest.main()
