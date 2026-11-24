#!/usr/bin/env bash
# Emit only declared check labels and a fixed interpretation of runner outcomes.
set -euo pipefail
if (( $# < 3 || $# % 2 != 1 )); then
  printf '%s\n' 'Expected a title followed by check/outcome pairs.' >&2
  exit 2
fi
: "${GITHUB_STEP_SUMMARY:?GitHub step summary path required}"
title=$1
shift
{
  printf '### %s\n\n| Check | Result |\n| --- | --- |\n' "$title"
  while (( $# )); do
    case "$2" in
      success) result='PASS' ;;
      failure) result='FAIL' ;;
      skipped) result='SKIPPED (prerequisite or workflow condition)' ;;
      cancelled) result='BLOCKED (runner cancelled)' ;;
      '') result='NOT RUN (no step outcome)' ;;
      *) result='UNVERIFIED (unrecognized runner outcome)' ;;
    esac
    printf '| %s | %s |\n' "$1" "$result"
    shift 2
  done
} >> "$GITHUB_STEP_SUMMARY"
