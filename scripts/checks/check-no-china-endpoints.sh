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
    | grep -v 'scripts/checks/check-no-china-endpoints.sh' \
    || true)"

if [ -z "$hits" ]; then
    echo "PASS check-no-china-endpoints: no China endpoint host/URL in code"
    exit 0
fi

echo "FAIL check-no-china-endpoints: China endpoint host/URL found:"
printf '%s\n' "$hits" | cut -c1-160
exit 1
