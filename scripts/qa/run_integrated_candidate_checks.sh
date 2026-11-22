#!/usr/bin/env bash
# Full-checkout validation only. Never deploys, installs packages, or rewrites code.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
FLUTTER_BIN="${FLUTTER_BIN:-flutter}"
DART_BIN="${DART_BIN:-dart}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
blocked() { printf 'BLOCKED: %s; full application checks did not complete.\n' "$1" >&2; exit 2; }
flutter_runner_helper=scripts/qa/flutter_runner_checks.sh
[[ -f "$flutter_runner_helper" ]] || blocked "Required checkout file is missing: $flutter_runner_helper"
source "$ROOT/$flutter_runner_helper"
require_runner_command "$FLUTTER_BIN" 'Flutter executable is unavailable'
require_runner_command "$DART_BIN" 'Dart executable is unavailable'
require_runner_command "$NODE_BIN" 'Node.js is unavailable'
require_runner_command "$NPM_BIN" 'npm is unavailable'
require_runner_command python3 'Python 3 is required for SDK verification'
TARGETS=(
  lib/features/payments/contribute_entry_screen.dart
  lib/features/payments/contribution_flow_screen.dart
  lib/features/status/connection_recovery_screens.dart
  lib/shared/widgets/collect_foundation.dart
  lib/shared/widgets/collect_group_cards.dart
  lib/shared/widgets/collect_form_viewport.dart
  test/connection_recovery_screen_test.dart
  test/connection_recovery_screens_test.dart
  test/collect_disabled_action_regression_test.dart
  test/collect_lazy_group_list_test.dart
  test/form_viewport_namespace_test.dart
  test/collect_form_viewport_test.dart
  test/features/member_roster_screen_test.dart
  test/features/contribution_amount_accessibility_test.dart
  test/features/contribution_command_recovery_test.dart
  test/actual_member_history_sql_receipts_test.dart
)
require_runner_files pubspec.yaml pubspec.lock .fvmrc .dart_tool/package_config.json \
  admin-web/package.json admin-web/package-lock.json "${TARGETS[@]}"
VERSION_JSON="$("$FLUTTER_BIN" --version --machine)" || blocked 'Flutter version query failed'
DART_VERSION="$("$DART_BIN" --version 2>&1)" || blocked 'Dart version query failed'
if ! verify_runner_sdk_pins "$VERSION_JSON" "$DART_VERSION"; then
  blocked 'SDK identity verification failed'
fi
check_runner_format "$DART_BIN" "${TARGETS[@]}"
# Whole-checkout analysis catches import conflicts outside the partial overlay.
"$FLUTTER_BIN" analyze --no-pub --fatal-infos
"$FLUTTER_BIN" test --no-pub --concurrency=1 --exclude-tags=integration --reporter=expanded
FLUTTER_BIN="$FLUTTER_BIN" python3 scripts/qa/retained_member_history.py
"$NPM_BIN" --prefix admin-web run typecheck
"$NPM_BIN" --prefix admin-web run lint
"$NPM_BIN" --prefix admin-web test
"$NODE_BIN" --test admin-web/tests/pwa/package-pwa.test.mjs
"$NODE_BIN" scripts/tests/admin_pwa_worker_cache_test.mjs
printf 'PASS: Flutter formatting, analysis, member unit/widget and Chrome tests, and React Admin and PWA checks finished.\n'
