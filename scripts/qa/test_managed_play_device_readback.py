import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import managed_play_device_readback as probe

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


if __name__ == "__main__":
    unittest.main()
