#!/usr/bin/env bash
# check-rebrand-syntax.sh — the rebrand script inside pages/public/_worker.js
# lives in a JS TEMPLATE LITERAL, so `node --check` on _worker.js does NOT
# validate it (a template literal's content is just a string to Node).
# A syntax error there silently kills the WHOLE injected script in the
# browser — every rebrand rule stops at once (2026-11-18 QA rounds 15–16:
# a `/\/settings(\/|$)/` regex lost its backslashes to the template
# literal, became `//settings...` — a line comment — and the entire
# rebrand script failed to parse, regressing grammar, banner gap, pills
# and sidebar in one deploy).
#
# What it checks: extracts every <script>...</script> block from the HTML
# that _worker.js builds (the console page + the rebrand script) and runs
# `node --check` on each. A template-literal escape that breaks the
# injected JS fails here, before push.
#
# NO-INJECTION STATE (2026-11-21): the injection was removed from
# _worker.js — the AgentX look now ships in the console source itself and
# the Worker only forwards. When no AGENTX_RULES template literal exists
# there is no injected script to validate, and this check PASSES with a
# note. If injection ever reappears, the full validation below runs
# again — the check is fail-closed for regressions, not deleted.
#
# Usage: check-rebrand-syntax.sh [ROOT]
#   ROOT defaults to the repo root (parent of scripts/). Exits 0 if every
#   extracted inline script parses (or no injected script exists), 1 otherwise.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"
rm -f /tmp/rebrand-check-*.js /tmp/rebrand-check-err.txt

# No injected rebrand script: nothing to syntax-check. PASS.
if ! grep -q "AGENTX_RULES" pages/public/_worker.js; then
  echo "PASS check-rebrand-syntax: no injected rebrand script in _worker.js — nothing to syntax-check"
  exit 0
fi

# The rebrand script is the template literal assigned in _worker.js that
# contains AGENTX_RULES. Extract it by evaluating the literal's content:
# find the backtick-delimited block that holds AGENTX_RULES.
node -e '
const fs = require("fs");
const src = fs.readFileSync("pages/public/_worker.js", "utf8");
// Find the template literal containing AGENTX_RULES by scanning for
// backtick spans. The rebrand script is the largest backtick span that
// contains "AGENTX_RULES".
let best = "";
let i = 0;
while (true) {
  const start = src.indexOf("`", i);
  if (start === -1) break;
  // Find the matching close backtick, honouring \-escapes.
  let j = start + 1;
  while (j < src.length) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === "`") break;
    j++;
  }
  if (j >= src.length) break;
  const span = src.slice(start + 1, j);
  if (span.includes("AGENTX_RULES") && span.length > best.length) best = span;
  i = j + 1;
}
if (!best) { console.error("check-rebrand-syntax: no template literal containing AGENTX_RULES found"); process.exit(2); }
// The span is the RAW template literal text (escapes still present).
// Evaluate it the way the runtime does: as a template literal, so
// \-escapes resolve exactly as they will in the deployed HTML.
// Interpolations (${...}) must evaluate too — define the variables the
// template references (they are build-time flags in _worker.js) so the
// eval produces the same JS the browser will see. Values are dummies;
// only the SYNTAX of the evaluated JS is being checked here.
let evaluated;
try {
  const rebrandEnabled = true;
  const UPSTREAM_DOC_ORIGIN = "https://example.com";
  const UPSTREAM_GITHUB_URL = "https://example.com";
  const PINNED_QWENPAW_VERSION = "2.3.0";
  const PYPI_QWENPAW_URL = "https://example.com";
  const mins = 5;
  const retryAfter = 60;
  const untilText = "";
  const code = "";
  evaluated = eval("`" + best.replace(/`/g, "\\`") + "`");
} catch (e) {
  console.error("check-rebrand-syntax: template literal itself does not evaluate: " + e.message);
  process.exit(2);
}
// The evaluated string is HTML containing <script> blocks. Extract the
// inline scripts and syntax-check each with node --check.
const scripts = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(evaluated)) !== null) scripts.push(m[1]);
if (scripts.length === 0) { console.error("check-rebrand-syntax: no <script> block in evaluated template"); process.exit(2); }
scripts.forEach((s, idx) => fs.writeFileSync("/tmp/rebrand-check-" + idx + ".js", s));
console.log("check-rebrand-syntax: extracted " + scripts.length + " inline script(s)");
' || exit 1

fail=0
for f in /tmp/rebrand-check-*.js; do
  if ! node --check "$f" 2>/tmp/rebrand-check-err.txt; then
    echo "FAIL check-rebrand-syntax: $f does not parse:"
    cat /tmp/rebrand-check-err.txt
    fail=1
  fi
done
rm -f /tmp/rebrand-check-*.js /tmp/rebrand-check-err.txt
if [ "$fail" -ne 0 ]; then
  echo "The injected rebrand script has a syntax error. Fix it in pages/public/_worker.js —"
  echo "remember the script lives in a template literal: backslashes in regexes must be"
  echo "DOUBLED (\\\\s not \\s), and a regex starting with /\\/ becomes a // comment."
  exit 1
fi
echo "PASS check-rebrand-syntax: injected rebrand script parses"
exit 0
