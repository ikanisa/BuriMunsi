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


if __name__ == '__main__':
    unittest.main()
