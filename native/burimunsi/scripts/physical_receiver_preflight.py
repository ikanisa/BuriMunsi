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
USER_ID = re.compile(r'(?:0|[1-9][0-9]{0,8})')
POSITIVE = re.compile(r'[1-9][0-9]{0,17}')


def exact_rows(output, package):
    lines = [line.split() for line in output.splitlines() if line.strip()]
    if any(not line[0].startswith('package:') for line in lines):
        return None
    return [row for row in lines if row[0] == 'package:' + package]


def adb(*arguments):
    return subprocess.run(['adb', *arguments], check=True, capture_output=True,
                          text=True, timeout=15).stdout.strip()


def inspect(serial, profile=None):
    result = {'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'scope': 'handset_preflight_only', 'carrier_journey_observed': False}
    if profile is not None and (type(profile) is not int or not 0 <= profile <= 21_474_835):
        return dict(result, state='invalid_android_profile')
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
    user = str(profile) if profile is not None else shell('am', 'get-current-user')
    sdk = shell('getprop', 'ro.build.version.sdk')
    if (not USER_ID.fullmatch(user) or int(user) > 21_474_835
            or len(sdk) > 3 or not sdk.isascii() or not sdk.isdecimal() or not 26 <= int(sdk) <= 999):
        return dict(result, state='device_metadata_unavailable')
    # Presence of Android's framework package distinguishes a valid profile
    # with neither app installed from an unavailable/unreadable profile.
    try:
        android = exact_rows(shell('pm', 'list', 'packages', '--user', user, 'android'), 'android')
    except subprocess.CalledProcessError:
        android = None
    if android != [['package:android']]:
        return dict(result, state='android_profile_unavailable')
    versions = {}
    for package in (RECEIVER, STAFF):
        try:
            listed = shell('cmd', 'package', 'list', 'packages', '--user', user, '--show-versioncode', package)
        except subprocess.CalledProcessError:
            listed = ''
        rows = exact_rows(listed, package)
        if rows is None or len(rows) > 1:
            return dict(result, state='package_metadata_unavailable')
        if rows:
            tokens = rows[0]
            if len(tokens) != 2 or not tokens[1].startswith('versionCode:') or not POSITIVE.fullmatch(tokens[1][12:]):
                return dict(result, state='package_metadata_unavailable')
            versions[package] = int(tokens[1][12:])
            continue
        # Some API 26 devices lack --show-versioncode. Confirm the exact package
        # is available in the selected user before reading its shared metadata.
        rows = exact_rows(shell('pm', 'list', 'packages', '--user', user, package), package)
        if rows is None or len(rows) > 1 or (rows and len(rows[0]) != 1):
            return dict(result, state='package_metadata_unavailable')
        if not rows:
            versions[package] = None
            continue
        info = shell('dumpsys', 'package', package)
        blocks = re.findall(r'^  Package \[' + re.escape(package) + r'\][^\n]*:\n(.*?)(?=^  \S|\Z)', info,
                            re.MULTILINE | re.DOTALL)
        codes = re.findall(r'^\s+versionCode=(\d+)\b', blocks[0], re.MULTILINE) if len(blocks) == 1 else []
        if len(codes) != 1 or not POSITIVE.fullmatch(codes[0]):
            return dict(result, state='package_metadata_unavailable')
        versions[package] = int(codes[0])
    if profile is None and shell('am', 'get-current-user') != user:
        return dict(result, state='foreground_profile_changed')
    state = 'receiver_installed' if versions[RECEIVER] is not None else 'production_receiver_missing'
    return dict(result, state=state, android_api=int(sdk), package_versions=versions,
                selection='explicit_profile' if profile is not None else 'stable_foreground_profile')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', help='Select one authorized physical ADB connection.')
    parser.add_argument('--profile', type=int, help='Read an explicit Android user ID instead of the foreground user.')
    args = parser.parse_args()
    try:
        result = inspect(args.serial, args.profile)
    except (OSError, subprocess.SubprocessError, UnicodeError):
        result = {'scope': 'handset_preflight_only', 'state': 'adb_metadata_unavailable',
                  'carrier_journey_observed': False}
    print(json.dumps(result, indent=2))
    return 0 if result['state'] == 'receiver_installed' else 2


if __name__ == '__main__':
    sys.exit(main())
