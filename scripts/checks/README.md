# scripts/checks/ — mechanical checks

A convention that lives only in prose gets violated within a week; a rule +
a check survives. Each check here is a bash script that exits 0 (pass) or 1
(fail). Run them all before pushing:

```bash
bash scripts/checks/run-checks.sh
```

Invoke every check with `bash`, never by direct execution: files pushed via
the GitHub Contents API (`scripts/gh-push.py`) are stored as mode 100644,
so the executable bit does not survive a push (the whole repo is 100644
except `features/memory/install-ripwire.sh`). The runner and the T121 test
both invoke the checks with `bash` for this reason.

AGENTS.md §5 makes this part of the change protocol (run the checks before
committing, alongside the machine-free suite).

## The checks

| Check | Rule it enforces | What it scans |
|---|---|---|
| `check-no-china-endpoints.sh` | No China endpoints/data (AGENTS.md §3) | Endpoint hosts/URLs in code files (js, py, ts, toml, json, sh). Bare provider names in comments or in the rebrand hide-list are NOT endpoints and do not fail. |
| `check-no-secrets.sh` | Never commit secrets (AGENTS.md §3) | Secret-shaped strings: `ghp_` + 20, `github_pat_` + 20, `sk-` + 20, `AKIA` + 16. Stricter than the AGENTS.md §5 scan (which matches bare `ghp_` / `github_pat_` prefixes) so documentation and regex-pattern definitions do not fail. |
| `check-agents-budget.sh` | AGENTS.md under 20,000 chars | `AGENTS.md` byte count. OpenClaw's model: the always-loaded file is budgeted; long rules live in the owning guide with a one-line pointer. |
| `check-no-polling.sh` | No polling as the main path | `setInterval` in server-side JS (Pages proxy, keep-alive Worker, feature Workers). UI refresh loops, one-shot `setTimeout` delays, and blocking Python server loops are documented exceptions, not failures. |

## Allowlists

Each check has an explicit allowlist in its header comment, one entry per
exception, each with the reason. The allowlist is the list of things that
look like a violation but are not. If you add a new exception, add it to the
check's header with a comment explaining why — do not weaken the pattern.

Current allowlisted items (all verified, none a real violation):

- **China endpoints:** `features/bloat-winwin/src/pristine/telemetry.py`
  (the upstream telemetry file, kept as a fail-first fixture — never
  deployed) and `features/bloat-winwin/test_bloat_winwin.py` (the test's
  forbidden-host constant). `pages/public/vendor/` (minified third-party
  bundles) is excluded by path.
- **Secrets:** the documented fake fixture `ghp_abc123XYZ`; constructed
  fakes (`"a" * 36`); redaction regex definitions (`re.compile`); the
  synthetic PAT fixture `11ABCDEFG0123456789`; and five redaction-test
  inputs (`Remember the key sk-`, `token: ghp_`, `aws_akid`, `openai_sk`,
  `The key is sk-`). These exist only to prove the redactor hides them.
- **Polling:** the waking page's elapsed-time timer
  (`getElementById('elapsed')` in `pages/public/_worker.js`) — a UI timer
  inside a served page, the documented waking-page progress mechanism.

## Adding a check

1. Write `check-<name>.sh` in this directory. It takes an optional ROOT
   argument (default: the repo root), prints `PASS <name>: ...` or
   `FAIL <name>: ...`, and exits 0/1.
2. Make it fail-first: it must fail on a file that violates the rule.
   Prove it with a temp directory containing a violating file.
3. Add it to the table above and to the T121 test
   (`features/test-project/test_checks.py`), then run the suite.
4. If the check needs an allowlist, put it in the script's header comment
   with a reason per entry. Never silently exclude a whole directory.
