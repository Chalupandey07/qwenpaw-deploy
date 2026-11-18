#!/usr/bin/env bash
# check-agents-budget.sh — AGENTS.md stays under its character budget.
#
# Rule (AGENTS.md header, OpenClaw's model): keep AGENTS.md under 20,000
# characters — the size an agent loads whole. Put long rules in the owning
# feature guide and leave a one-line pointer in AGENTS.md. A file that grows
# without a cap stops being read.
#
# Usage: check-agents-budget.sh [ROOT] [MAX]
#   ROOT defaults to the repo root (parent of scripts/). MAX defaults to
#   20000. Exits 0 if AGENTS.md is under the cap, 1 if it is over (prints
#   the size and the cap).
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MAX="${2:-20000}"
FILE="$ROOT/AGENTS.md"

if [ ! -f "$FILE" ]; then
    echo "FAIL check-agents-budget: $FILE does not exist"
    exit 1
fi

size="$(wc -c < "$FILE" | tr -d ' ')"
if [ "$size" -le "$MAX" ]; then
    echo "PASS check-agents-budget: AGENTS.md is $size chars (cap $MAX)"
    exit 0
fi

echo "FAIL check-agents-budget: AGENTS.md is $size chars, over the $MAX cap"
echo "Move long rules to the owning feature guide and leave a one-line pointer."
exit 1
