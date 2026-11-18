#!/usr/bin/env bash
# check-no-polling.sh — no polling as the main path in server code.
#
# Rule (AGENTS.md §3, Rakazo's convention): no queues/polling as the main
# path. Work starts at once in the process that has it; clients re-read on
# a server signal over the one live stream. A poll loop that runs whether
# or not anything changed burns quota against wall-clock time — the KV
# incident (a preview upload every 15s, ~11,500 writes/day against a 1,000
# budget) is what this rule exists to stop.
#
# What it checks: `setInterval` in the server-side JS — the Pages proxy
# (pages/public/_worker.js), the keep-alive Worker (worker/src/), and the
# feature Workers (features/*/worker/). A `setInterval` there is a poll
# loop in the coordination path.
#
# What it does NOT check (documented, deliberate):
#   - UI refresh loops in pages the user is actively looking at
#     (pages/public/computer/ui.html: 10s refresh, 15s lease heartbeat,
#     1s countdown; pages/public/status-page.html: 30s refresh). These
#     are UI timers for a visible page, not the data/coordination path.
#   - `setTimeout` one-shot delays (toast auto-dismiss, reconnect backoff,
#     terminal session renewal). A delay is not a poll.
#   - Python `while True` in server processes (preview-uploader,
#     terminal-server, groupchat relay, vault redact). Those block on I/O
#     (accepting connections, reading a socket); a blocking server loop is
#     not a poll loop.
#
# Allowlist (one entry, with the reason):
#   getElementById('elapsed') — the waking page served by _worker.js. Its
#     inline script updates the displayed elapsed time (and polls /status
#     for progress) while the machine wakes. This is the documented
#     waking-page progress mechanism: a page whose whole purpose is to show
#     live progress while the user waits. It is a UI timer inside a served
#     page, not a poll in the proxy itself.
#   UI-TIMER-ALLOWLIST: sidebar-ellipsis re-apply timer — the console
#     sidebar truncation re-applied every 1.5 s in the user's browser
#     (2026-11-18 QA rounds 5–13: React reverts the truncated title text
#     between MutationObserver firings, so the observer alone never
#     sticks). Client-side only, runs only while the user has the console
#     open, makes no network calls and writes no data — it only
#     re-truncates sidebar title text nodes. Not a server poll loop.
#   UI-TIMER-ALLOWLIST: waking page progress tick (Smart Sleep/Wake Part 2,
#     2026-11-19) — the waking page served by _worker.js updates the
#     displayed elapsed time and the determinate bar every 1 s while the
#     user watches the machine wake. Same documented mechanism as the
#     getElementById('elapsed') entry above; the 5 s console poll is a
#     setTimeout chain, not an interval. A UI timer inside a served page,
#     not a poll in the proxy itself.
#   UI-TIMER-ALLOWLIST: cooldown bar and countdown tick (Smart Sleep/Wake
#     Part 2, 2026-11-19) — the cooldown page served by _worker.js updates
#     the determinate bar and the remaining-minutes text every 1 s while
#     the user watches the cooldown end, and reloads once at the end
#     (guarded to one auto-reload per 30 s per tab). A UI timer inside a
#     served page, not a poll in the proxy itself.
#
# Usage: check-no-polling.sh [ROOT]
#   ROOT defaults to the repo root (parent of scripts/). Exits 0 if no
#   setInterval is found in server code outside the allowlist, 1 if any is
#   found (prints file:line for each).
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

hits="$(grep -rn 'setInterval' \
    pages/public/_worker.js worker/src/ features/*/worker/src/ features/*/worker/*.js \
    2>/dev/null \
    | grep -v "getElementById('elapsed')" \
    | grep -v "UI-TIMER-ALLOWLIST" \
    || true)"

if [ -z "$hits" ]; then
    echo "PASS check-no-polling: no setInterval in server code (outside the waking-page allowlist)"
    exit 0
fi

echo "FAIL check-no-polling: setInterval found in server code:"
printf '%s\n' "$hits" | cut -c1-160
echo "If this is a UI timer for a page the user is actively watching, add it"
echo "to the allowlist with a comment explaining why — do not weaken the check."
exit 1
