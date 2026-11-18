#!/usr/bin/env bash
# check-no-secrets.sh — no secret-shaped strings in the repo.
#
# Rule (AGENTS.md §3): never commit secrets. No token, key, password or
# cookie in code, docs, tests, commit messages, or memory.
#
# What it checks: secret-shaped strings — a GitHub PAT (`ghp_` + 20 or more
# alphanumerics), a fine-grained PAT (`github_pat_` + 20 or more), an OpenAI
# key (`sk-` + 20 or more alphanumerics), an AWS key (`AKIA` + 16 alphanumerics).
# This is STRICTER than the AGENTS.md §5 scan (which matches the bare
# `ghp_` / `github_pat_` prefixes): the length qualifier keeps bare prefixes
# in documentation and regex-pattern definitions from failing, while still
# catching every real-shaped key (a real ghp_ key is 36 chars, a real
# github_pat_ is 80+, a real sk- key is 48, a real AKIA key is 20).
#
# Allowlist (each marker is a known-safe fixture, with the reason). A line
# matching any marker is excluded; anything else that matches the pattern
# FAILS the check. If you add a new redaction-test input, add its marker
# here with a comment — do not weaken the pattern.
#   abc123XYZ              — the documented fake fixture (ghp_abc123XYZ),
#                            used by the vault broker's redaction self-test.
#   "a" * 36               — a fake key constructed in tests
#                            (consolidate.py, test_lessons.py).
#   re.compile             — a redaction regex definition, not a key
#                            (features/memory/recall.py).
#   11ABCDEFG0123456789    — the synthetic PAT fixture in test_recall.py:79
#                            (a sequential/patterned fake, not a real key).
#   Remember the key sk-   — redaction-test input (test_lessons.py:226).
#   token: ghp_            — redaction-test input (test_recall.py:279).
#   token ghp_             — redaction-test input
#                            (features/botpages/routine-loop/test_routine_loop.py:273,
#                            "refuses a secret-shaped value" — a fake ghp_
#                            fixture; added 2026-11-18 with T132, whose
#                            checks were blocked by it).
#   aws_akid               — redaction-test input (test_recall.py:281).
#   openai_sk              — redaction-test input (test_recall.py:282).
#   The key is sk-         — redaction-test input (test_facts.py:322).
#
# Usage: check-no-secrets.sh [ROOT]
#   ROOT defaults to the repo root (parent of scripts/). Exits 0 if no
#   secret-shaped string is found outside the allowlist, 1 if any is found
#   (prints file:line for each).
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

PATTERN='ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}'

hits="$(grep -rniE "$PATTERN" \
    --include='*.js' --include='*.py' --include='*.md' \
    --include='*.toml' --include='*.json' \
    . 2>/dev/null \
    | grep -v '/\.git/' \
    | grep -v 'abc123XYZ' \
    | grep -v '"a" \* 36' \
    | grep -v 're\.compile' \
    | grep -v '11ABCDEFG0123456789' \
    | grep -v 'Remember the key sk-' \
    | grep -v 'token: ghp_' \
    | grep -v 'token ghp_' \
    | grep -v 'aws_akid' \
    | grep -v 'openai_sk' \
    | grep -v 'The key is sk-' \
    || true)"

if [ -z "$hits" ]; then
    echo "PASS check-no-secrets: no secret-shaped string outside the allowlist"
    exit 0
fi

echo "FAIL check-no-secrets: secret-shaped string found (not in the allowlist):"
printf '%s\n' "$hits" | cut -c1-160
exit 1
