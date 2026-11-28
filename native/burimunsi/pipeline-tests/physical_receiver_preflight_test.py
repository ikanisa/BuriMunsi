import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import physical_receiver_preflight as receiver


class PhysicalReceiverPreflight(unittest.TestCase):
    def test_no_physical_device_or_ambiguous_selection_never_queries_a_handset(self):
        for inventory, selected, expected in [
            ('emulator-5574\tdevice\nusb1\tunauthorized', None, 'no_authorized_physical_handset'),
            ('usb1\tdevice\nusb2\tdevice', None, 'select_one_authorized_handset'),
            ('usb1\tdevice', 'emulator-5574', 'selected_handset_unavailable'),
        ]:
            with patch.object(receiver, 'adb', return_value='List of devices attached\n' + inventory) as adb:
                self.assertEqual(receiver.inspect(selected)['state'], expected)
                adb.assert_called_once_with('devices')

    def test_metadata_only_rejects_network_emulator_and_supports_api26_package_metadata(self):
        def run(virtual):
            def adb(*args):
                if args == ('devices',):
                    return 'List of devices attached\nusb1\tdevice'
                self.assertEqual(args[:3], ('-s', 'usb1', 'shell'))
                command = args[3:]
                if command[:1] == ('getprop',):
                    return '26' if command[-1].endswith('sdk') else str(int(virtual))
                if command == ('am', 'get-current-user'):
                    return '10'
                if command == ('pm', 'list', 'packages', '--user', '10', 'android'):
                    return 'package:android\npackage:android.ext'
                package = command[-1]
                self.assertIn(package, (receiver.STAFF, receiver.RECEIVER))
                if command[:-1] == ('cmd', 'package', 'list', 'packages', '--user', '10', '--show-versioncode'):
                    raise subprocess.CalledProcessError(1, 'cmd')
                if command[:-1] == ('pm', 'list', 'packages', '--user', '10'):
                    return 'package:' + package if package == receiver.RECEIVER else ''
                self.assertEqual(command, ('dumpsys', 'package', receiver.RECEIVER))
                return 'Packages:\n  Package [' + package + '] (123):\n    versionCode=70 minSdk=26\n'
            with patch.object(receiver, 'adb', side_effect=adb):
                return receiver.inspect('usb1')
        self.assertEqual(run(True)['state'], 'selected_device_is_an_emulator')
        result = run(False)
        self.assertEqual(result['package_versions'], {receiver.RECEIVER: 70, receiver.STAFF: None})
        self.assertEqual(result['state'], 'receiver_installed')
        self.assertFalse(result['carrier_journey_observed'])
        self.assertNotIn('usb1', str(result))

    def fixture(self, *, explicit=None, missing_profile=False, swapped=False, duplicate=False):
        queries = []
        def adb(*args):
            queries.append(args)
            if args == ('devices',):
                return 'List of devices attached\nusb1\tdevice'
            command = args[3:]
            if command == ('am', 'get-current-user'):
                return '11' if swapped and queries.count(args) > 1 else '10'
            if command[:1] == ('getprop',):
                return '33' if command[-1].endswith('sdk') else '0'
            user = str(explicit if explicit is not None else 10)
            if command == ('pm', 'list', 'packages', '--user', user, 'android'):
                return 'Error: Unknown user' if missing_profile else 'package:android'
            self.assertEqual(command[:-1], ('cmd', 'package', 'list', 'packages', '--user', user, '--show-versioncode'))
            row = 'package:' + command[-1] + ' versionCode:74'
            return row + '\n' + row if duplicate else row
        with patch.object(receiver, 'adb', side_effect=adb):
            return receiver.inspect('usb1', explicit), queries

    def test_select_explicit_work_profile_never_queries_foreground_or_leaks_profile(self):
        result, calls = self.fixture(explicit=12)
        self.assertEqual(result['selection'], 'explicit_profile')
        self.assertEqual(set(result['package_versions'].values()), {74})
        self.assertFalse(any(call[-1] == 'get-current-user' for call in calls))
        self.assertNotIn('android_user', result)
        self.assertNotIn('usb1', str(result))

    def test_unavailable_profile_not_reported_as_missing_packages(self):
        result, calls = self.fixture(explicit=12, missing_profile=True)
        self.assertEqual(result['state'], 'android_profile_unavailable')
        self.assertNotIn('package_versions', result)
        self.assertFalse(any(call[-1] == receiver.RECEIVER for call in calls))

    def test_switched_foreground_and_ambiguous_package_suppress_versions(self):
        for flags, state in (({'swapped': True}, 'foreground_profile_changed'),
                             ({'duplicate': True}, 'package_metadata_unavailable')):
            result, _ = self.fixture(**flags)
            self.assertEqual(result['state'], state)
            self.assertNotIn('package_versions', result)

    def test_invalid_profile_is_rejected_without_adb(self):
        with patch.object(receiver, 'adb') as adb:
            for value in (-1, 21_474_836, True, '10'):
                self.assertEqual(receiver.inspect(None, value)['state'], 'invalid_android_profile')
            adb.assert_not_called()


if __name__ == '__main__':
    unittest.main()
