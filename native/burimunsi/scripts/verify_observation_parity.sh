#!/usr/bin/env bash
# Platform-neutral qualification only; these are not verified carrier formats.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TEST="$HERE/observation-parity-tests"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CORE=()
while IFS= read -r -d '' source; do CORE+=("$source"); done < <(find "$HERE/core/src/main/kotlin" -name '*.kt' -print0)
kotlinc "${CORE[@]}" "$TEST/JointChecks.kt" -include-runtime -d "$TMP/checks.jar"
java -jar "$TMP/checks.jar" "$TEST/synthetic-receipts.tsv" > "$TMP/android.tsv"
node "$TEST/verify.mjs" "$TMP/android.tsv"
