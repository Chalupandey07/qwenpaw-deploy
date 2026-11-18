#!/usr/bin/env bash
# run-checks.sh — run every mechanical check in scripts/checks/.
#
# Each check is an executable that exits 0 (pass) or 1 (fail). This runner
# runs all of them, prints PASS/FAIL per check, and exits 0 only if every
# check passes. Run it before pushing (AGENTS.md §5) and on every PR.
#
# Usage: run-checks.sh [ROOT]
#   ROOT defaults to the repo root (parent of scripts/).
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DIR="$ROOT/scripts/checks"

fail=0
for check in "$DIR"/check-*.sh; do
    name="$(basename "$check")"
    if output="$("$check" "$ROOT" 2>&1)"; then
        printf '%s\n' "$output"
    else
        printf '%s\n' "$output"
        fail=1
    fi
done

if [ "$fail" -eq 0 ]; then
    echo "ALL CHECKS PASS"
    exit 0
fi

echo "CHECKS FAILED — fix the failures above, or add an allowlist entry with"
echo "a comment explaining why (do not weaken the check)."
exit 1
