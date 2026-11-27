#!/usr/bin/env python3
"""Read only device type, Android API level and the two production package versions."""
import argparse
import datetime
import json
import re
import subprocess
import sys


RECEIVER = 'rw.ikanisa.burimunsi.gateway.cloud'
STAFF = 'rw.ikanisa.burimunsi.staff.cloud'


def adb(*arguments):
    return subprocess.run(['adb', *arguments], check=True, capture_output=True,
                          text=True, timeout=15).stdout.strip()


def inspect(serial):
    result = {'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'scope': 'handset_preflight_only', 'carrier_journey_observed': False}
    devices = [line.split() for line in adb('devices').splitlines()[1:] if line.strip()]
    authorized = [row[0] for row in devices if len(row) >= 2 and row[1] == 'device'
                  and not row[0].startswith('emulator-')]
    if not authorized:
        return dict(result, state='no_authorized_physical_handset')
    if serial is None and len(authorized) != 1:
        return dict(result, state='select_one_authorized_handset')
    selected = serial if serial is not None else authorized[0]
    if selected not in authorized:
        return dict(result, state='selected_handset_unavailable')

    def shell(*arguments):
        return adb('-s', selected, 'shell', *arguments)

    if any(shell('getprop', prop) == '1' for prop in ('ro.kernel.qemu', 'ro.boot.qemu')):
        return dict(result, state='selected_device_is_an_emulator')
    user = shell('am', 'get-current-user')
    sdk = shell('getprop', 'ro.build.version.sdk')
    if not user.isdecimal() or not sdk.isdecimal():
        return dict(result, state='device_metadata_unavailable')
    versions = {}
    for package in (RECEIVER, STAFF):
        try:
            listed = shell('cmd', 'package', 'list', 'packages', '--user', user, '--show-versioncode', package)
        except subprocess.CalledProcessError:
            listed = ''
        entry = re.search(r'^package:' + re.escape(package) + r'\s+versionCode:(\d+)\s*$', listed, re.MULTILINE)
        if entry:
            versions[package] = int(entry.group(1))
        else:
            # Some API 26 devices lack --show-versioncode. Bind the fallback to
            # the foreground user's exact package before reading its metadata.
            exact = shell('pm', 'list', 'packages', '--user', user, package).splitlines()
            if 'package:' + package not in exact:
                versions[package] = None
                continue
            info = shell('dumpsys', 'package', package)
            block = re.search(r'^  Package \[' + re.escape(package) + r'\][^\n]*:\n(.*?)(?=^  \S|\Z)', info,
                              re.MULTILINE | re.DOTALL)
            version = re.search(r'^\s+versionCode=(\d+)\b', block.group(1), re.MULTILINE) if block else None
            if not version:
                return dict(result, state='package_metadata_unavailable')
            versions[package] = int(version.group(1))
    state = 'receiver_installed' if versions[RECEIVER] is not None else 'production_receiver_missing'
    return dict(result, state=state, android_api=int(sdk), package_versions=versions)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', help='Select one authorized physical ADB connection.')
    args = parser.parse_args()
    try:
        result = inspect(args.serial)
    except (OSError, subprocess.SubprocessError):
        result = {'scope': 'handset_preflight_only', 'state': 'adb_metadata_unavailable',
                  'carrier_journey_observed': False}
    print(json.dumps(result, indent=2))
    return 0 if result['state'] == 'receiver_installed' else 2


if __name__ == '__main__':
    sys.exit(main())
