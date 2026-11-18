#!/usr/bin/env bash
# check-no-china-endpoints.sh — no China endpoint hosts/URLs in the code.
#
# Rule (AGENTS.md §3): English only, no China endpoints or data. No
# ModelScope, Alibaba Cloud/ACR, DashScope defaults, Chinese CDNs or fonts.
#
# What it checks: endpoint hosts and URLs (not bare provider names) in code
# files — js, py, ts, toml, json, sh. A bare name like "Aliyun" in a comment
# or in the rebrand hide-list is NOT an endpoint and does not fail; a host
# like `modelscope.cn`, `dashscope.aliyuncs.com`, or any `.fcapp.run` /
# `.aliyuncs.com` / `.aliyun.com` host DOES fail.
#
# Allowlist (each entry is a deliberate exception, with the reason):
#   features/bloat-winwin/src/pristine/telemetry.py — the UPSTREAM telemetry
#     file, kept as a fail-first fixture so test_bloat_winwin.py can prove
#     it fails on pristine. It is never deployed; the deployed stub has no
#     endpoint. Do not delete it (the test needs it).
#   features/bloat-winwin/test_bloat_winwin.py — the test's forbidden-host
#     constant (ENDPOINT_HOST). The test asserts the stub does NOT contain
#     it; the constant itself is the thing being tested against.
#   pages/public/vendor/ — minified third-party bundles (xterm etc.), not
#     our code. Excluded by path.
#   features/model-identity/src/pristine/agents.py and
#     features/model-identity/src/patched/agents.py — the UPSTREAM
#     v2.3.0 file, kept as a patch fixture (pristine) and as the
#     patched copy the .patch is diffed from. The flagged strings are
#     upstream's _ALLOWED_MAIL_DOMAINS set ("aliyun.com",
#     "qiye.aliyun.com" beside gmail.com / qq.com): mail domains whose
#     auth codes are accepted, NOT endpoints the code calls — no URL,
#     no fetch, no data sent. The deployed image already contains them
#     (they are upstream code, not ours); this patch does not touch
#     those lines. Do not delete the copies (the patch needs them).
#   pages/public/_worker.js AGENTX_UPSTREAM_HOSTS blocklist (one line) —
#     the rebrand's upstream-host list, matched ONLY to preventDefault /
#     block navigation and fetch to those hosts (block-links-v2). The
#     code never fetches, posts, or sends data to them; the strings ARE
#     the blocklist, not endpoints the code calls. The filter matches
#     only the definition line (`AGENTX_UPSTREAM_HOSTS = [`), so any
#     other China endpoint string anywhere else in _worker.js still fails.
#   scripts/checks/check-no-china-endpoints.sh — this file itself. Its
#     header documents the endpoint examples and its PATTERN variable
#     contains the host patterns; those are the check's own definitions,
#     not endpoints in the code.
#
# Usage: check-no-china-endpoints.sh [ROOT]
#   ROOT defaults to the repo root (parent of scripts/). Exits 0 if no
#   endpoint is found, 1 if any is found (prints file:line for each).
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

PATTERN='https?://[^"'"'"'[:space:]]*(modelscope|dashscope|aliyun|alibaba|fcapp|aliyuncs)|(modelscope|dashscope)\.(cn|com|net)|\.fcapp\.run|\.aliyuncs\.com|\.aliyun\.com|api\.qwen|cn-hangzhou'

# grep returns 1 when nothing matches; we need that to mean PASS, so
# capture the output first and test whether it is empty.
hits="$(grep -rniE "$PATTERN" \
    --include='*.js' --include='*.py' --include='*.ts' \
    --include='*.toml' --include='*.json' --include='*.sh' \
    . 2>/dev/null \
    | grep -v '/\.git/' | grep -v '/vendor/' \
    | grep -v 'features/bloat-winwin/src/pristine/telemetry.py' \
    | grep -v 'features/bloat-winwin/test_bloat_winwin.py' \
    | grep -v 'features/model-identity/src/pristine/agents.py' \
    | grep -v 'features/model-identity/src/patched/agents.py' \
    | grep -v 'scripts/checks/check-no-china-endpoints.sh' \
    | grep -v 'AGENTX_UPSTREAM_HOSTS = \[' \
    || true)"

if [ -z "$hits" ]; then
    echo "PASS check-no-china-endpoints: no China endpoint host/URL in code"
    exit 0
fi

echo "FAIL check-no-china-endpoints: China endpoint host/URL found:"
printf '%s\n' "$hits" | cut -c1-160
exit 1
