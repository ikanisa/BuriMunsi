# Shared steps for the local Flutter check runners. Each runner supplies blocked().

require_runner_command() {
  command -v "$1" >/dev/null 2>&1 || blocked "$2"
}

require_runner_files() {
  local path
  for path in "$@"; do
    [[ -f "$path" ]] || blocked "Required checkout file is missing: $path"
  done
}

verify_runner_sdk_pins() {
  python3 - .fvmrc "$@" <<'PY'
import json
import re
import sys

try:
    with open(sys.argv[1], encoding='utf-8') as stream:
        expected = json.load(stream)['flutter']
    versions = json.loads(sys.argv[2])
    actual = versions['frameworkVersion']
    check_dart = len(sys.argv) == 4
    if not isinstance(expected, str) or not expected or actual != expected:
        if check_dart:
            raise ValueError('Flutter does not match the checked-in SDK pin')
        raise ValueError(f'Flutter pin mismatch: expected {expected}, found {actual}')

    if check_dart:
        bundled = versions['dartSdkVersion']
        if not isinstance(bundled, str) or not bundled.strip():
            raise ValueError('Flutter did not report its bundled Dart version')
        executable = re.search(r'Dart SDK version:\s+(\S+)', sys.argv[3])
        if executable is None or executable.group(1) != bundled.split()[0]:
            raise ValueError('Dart executable does not match Flutter bundled Dart')
        print(f'SDK pins verified: Flutter {actual}, Dart {executable.group(1)}')
    else:
        print(f'Flutter pin verified: {actual}')
except (OSError, TypeError, ValueError, KeyError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
PY
}

check_runner_format() {
  local dart="$1"
  shift
  "$dart" format --output=none --set-exit-if-changed "$@"
}
