#!/usr/bin/env bash
# Run only in an SDK-equipped, dependency-resolved full checkout. No deployment.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
FLUTTER_BIN="${FLUTTER_BIN:-flutter}"
DART_BIN="${DART_BIN:-dart}"
blocked() { printf 'BLOCKED: %s; application checks did not complete.\n' "$1" >&2; exit 2; }
flutter_runner_helper=scripts/qa/flutter_runner_checks.sh
[[ -f "$flutter_runner_helper" ]] || blocked "Required checkout file is missing: $flutter_runner_helper"
source "$ROOT/$flutter_runner_helper"
require_runner_command "$FLUTTER_BIN" 'Flutter executable is unavailable'
require_runner_command "$DART_BIN" 'Dart executable is unavailable'
require_runner_command python3 'Python 3 is required to verify the SDK pin'
TARGETS=(
  lib/features/status/connection_recovery_screens.dart
  test/connection_recovery_screen_test.dart
  test/collect_disabled_action_regression_test.dart
)
require_runner_files pubspec.yaml pubspec.lock .fvmrc .dart_tool/package_config.json "${TARGETS[@]}"
VERSION_JSON="$("$FLUTTER_BIN" --version --machine)"
if ! verify_runner_sdk_pins "$VERSION_JSON"; then
  blocked 'Flutter SDK does not match the checkout pin'
fi
check_runner_format "$DART_BIN" "${TARGETS[@]}"
"$FLUTTER_BIN" analyze --no-pub "${TARGETS[@]}"
"$FLUTTER_BIN" test --no-pub \
  test/connection_recovery_screen_test.dart \
  test/collect_disabled_action_regression_test.dart
printf 'PASS: recovery formatting, targeted analysis and widget tests completed.\n'
