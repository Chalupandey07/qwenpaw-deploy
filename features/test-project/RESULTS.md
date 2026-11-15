# QwenPaw test results (RESULTS.md)

Every full or partial run of the test project is recorded here as a
**round**. The runner (`run-tests.py`) appends Round 1, 2, 3, … itself.
Browser / needs-token rows are recorded by the parent agent by hand.

## How rounds work

1. **Check the machine first.** `curl -s
   https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev/status` — if
   `status` is `waking` / `cooldown` / `conflict`, the Free machine is
   paused or cooling down: machine tests are BLOCKED that round, not
   failed. Wait and re-run.
2. **Run the protocol suite:** `python3 run-tests.py` (full) or
   `python3 run-tests.py --only T01,T02` / `--area desktop` (part).
   The runner appends the round below automatically. `--no-record`
   runs without recording (smoke runs only).
3. **Run the browser tests** (T50–T57) in a real logged-in browser
   (parent agent) and the needs-token tests (T58–T61) with the
   user-held secrets, then paste their rows into the round's table.
4. **Fix failures, re-test.** A round passes only when every protocol
   test is PASS (or KNOWN-GAP where the catalogue expects it) and the
   browser/needs-token rows for that round are filled. No "done" claim
   without a passing round (PLAN.md Phase 1).
5. **Never edit an old round.** New information goes in a new round.

## Result vocabulary

| Result | Meaning |
|---|---|
| `PASS` | Check ran, expected result observed. |
| `FAIL` | Check ran, expected result NOT observed. Fix the system, not the test — unless the test itself is wrong, in which case fix TESTS.md + the runner and say so in the round notes. |
| `KNOWN-GAP` | Expected outcome is a documented gap (currently only T33, mailbox/qwenpawmail). Not a failure. |
| `NEEDS-VERIFICATION` | The check command itself is unproven (currently none — T49's KV write call was verified in Round 2; the runner keeps this result as a guard if a future write call errors). Record the exact open question; a FAIL here would be misleading. |
| `NEEDS-BROWSER` | Not run — needs a real logged-in browser. |
| `NEEDS-TOKEN` | Not run — needs a user-held secret. |
| `BLOCKED` | Not run — the machine was paused / in cooldown, or an external dependency was down. Say which. |

## Round 1 — protocol sweep, 2026-11-15 06:59-07:13 IST (UTC 01:29-01:43) + fixes to 07:26 IST

Run by hand (the runner did not exist yet). Full detail:
`features/test-project/round1-sweep.md`. 26 protocol checks, 25 PASS + 1 FAIL,
then 2 more FAILs found by the log-check tooling. All 3 fixed live, re-verified.

| Area | Result | Evidence |
|---|---|---|
| 16 public endpoints (qwenpawx + frontend root/status/auth, /desktop gate, __lease, xterm.js, keep-alive up, routines/groupchat/board/bot-pages/activity) | PASS | all 200; keep-alive "up", 0 failures |
| Container + services | PASS | healthy, healthz ok, uptime 9663s; 20 services running, 0 failed |
| Ports + WS | PASS | 5901/5903/5904/5999, 6080-6085, 8897/8898 listening; WS 6081/6084/6085 RFB 003.008, 6083 terminal frames |
| MCP | PASS | SSE 8898 + 8897 -> 200; skills 19/19 enabled |
| Approvals | PASS | 7 driver_policy lines all pre-fix (04:14-04:18 IST), zero new |
| Screenshot | PASS | mss 1920x1080 pixel-identical to host scrot (mean abs diff 0.00); :1/:2 Chromium mapped and distinct |
| Config state | PASS (record) | heartbeat enabled False every 6h; active_agent default; decision_model null; fallback_models []; jobs empty |
| Fail-closed auth | PASS | routines /trigger 401, groupchat POST/GET 401, keepalive /wake 401, board /api/tickets 401 |
| Bridge | PASS | health {"ok":true,"browser_alive":true} |
| F26 Camoufox about:blank | FAIL -> FIXED | bridge /goto x.com/0xsatwik -> 200; :99 screen 45,175 colors after |
| F27 DriverCards failed YAML parse | FAIL -> FIXED | description rewritten as block scalar (live + repo); watcher refreshed 07:08:54/56 IST; zero new DriverCardError |
| F28 needs-you had no token in container | FAIL -> FIXED | CAMOUFOX_BRIDGE_TOKEN added to .env, container recreated (healthy); token_len 43; no-token 401, env-token+empty-text 400 empty_text; drivers reconnected 07:10:23/24 |

Browser tests (T50-T57) and needs-token tests (T58-T61) were NOT run in Round 1;
they need the parent's real browser / user-held secrets. Per-test rows begin at
Round 2 (first `run-tests.py` run).

## Round 2 — 2026-11-15T01:45:17Z (UTC), `run-tests.py`

Protocol run by the runner; browser / needs-token rows were recorded as skipped, not run. Summary: FAIL=8, PASS=40, KNOWN-GAP=1, NEEDS-BROWSER=8, NEEDS-TOKEN=4.

| Test | Area | Method | Result | Evidence |
|---|---|---|---|---|
| T01 | console | protocol | FAIL | HTTP 0 size=65 markers=[] |
| T02 | console | protocol | FAIL | HTTP 0 size=41 title=False |
| T03 | console | protocol | PASS | HTTP 200 body={"enabled":true,"has_users":true} |
| T04 | console | protocol | PASS | HTTP 200 size=1878 gate=True |
| T05 | console | protocol | PASS | default={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":19} qa={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":2} |
| T06 | console | protocol | FAIL | HTTP 0 size=67 |
| T07 | desktop | protocol | FAIL |  |
| T08 | desktop | protocol | PASS | 17/17 active |
| T09 | desktop | protocol | PASS | ws_status=HTTP/1.1 101 Switching Protocols echo_found=True bytes_read=23 |
| T10 | mcp | protocol | PASS | 8898 200 8897 200 |
| T11 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=104998, window=Today's Puzzle Answers (November 15, 2026) - Chromium] xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled] xfdesktop -- xfdesktop [running, pid=50676, window |
| T12 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=111374, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfwm4 -- xfwm4 [running, pid=109672, window=untitled] |
| T13 | desktop | protocol | PASS | __teach HTTP 200 gate=True; __pending-skills HTTP 401 body={"ok":false,"error":"unauthorized"} |
| T14 | desktop | protocol | PASS | POST __needs-you HTTP 401 body={"ok":false,"error":"unauthorized"}; GET __needs-you HTTP 200 gate=True |
| T15 | desktop | protocol | FAIL | live markers=[]; _worker.js consolePanelScript lines=2, 316px lines=3 |
| T16 | desktop | protocol | PASS | PREVIEW_S=15:True files=[('/data/home/mcp-proxy/preview.png', 15, 243014), ('/data/home/mcp-proxy/preview-qa.png', 14, 707621)] upload401:True preview-gate200:True |
| T17 | screenshot | protocol | PASS | mss=188623B mean=161.66 scrot=243014B mean=161.66 |
| T18 | bridge | protocol | PASS | /health={"ok": true, "browser_alive": true, "title": "Satwik Samanta (@0xSatwik) / X", "url": "https://x.com/0xsatwik"} |
| T19 | bridge | protocol | PASS | url=https://x.com/0xsatwik title=Satwik Samanta (@0xSatwik) / X (token never recorded) |
| T20 | bridge | protocol | PASS | /desktop-open={"ok": true, "url": "https://wordsolverx.com", "display": ":1", "agent": "default", "note": "opened on the InstaBox desktop (display :1)"} (token never recorded) |
| T21 | routines | protocol | FAIL | / HTTP 0; /api/status HTTP 200 qwenpaw={'status': 'up', 'httpStatus': 200, 'note': 'QwenPaw console answered'} routines=['daily-summary', 'inbox-check-30m'] |
| T22 | routines | protocol | PASS | schedules=['*/30 * * * *', '30 1 * * *'] |
| T23 | routines | protocol | PASS | POST /trigger no token -> HTTP 401 body={ "error": "unauthorized" } |
| T24 | routines | protocol | PASS | recent kinds=['daily-summary-slot', 'manual-trigger', 'wake-tick'] wake-tick=2026-11-15T01:30:12.685Z daily=2026-11-15T01:30:27.825Z |
| T25 | groupchat | protocol | PASS | HTTP 200 body={"service":"qwenpaw-groupchat","thread":"one shared thread for QwenPaw agents default + QwenPaw_QA_Agent_0.2","store":"durable-object (sqlite)","auth_required":true,"endpoints":["GET /thread[?since=<s |
| T26 | groupchat | protocol | PASS | POST /thread/message HTTP 401 {"error":"unauthorized"}; GET /thread HTTP 401 {"error":"unauthorized"} |
| T27 | board | protocol | FAIL | / HTTP 0; /health HTTP 200 body={"ok":true,"worker":"qwenpaw-board"} |
| T28 | board | protocol | PASS | GET /api/tickets no key -> HTTP 401 body={"error":"unauthorized — send the board key as ?key= or X-Board-Key header"} |
| T29 | botpages | protocol | PASS | HTTP 200 size=1293 |
| T30 | botpages | protocol | PASS | HTTP 200 size=9831 |
| T31 | skills | protocol | PASS | Showing: 19 of 19 skills, 19 enabled, 0 disabled rows=19 |
| T32 | skills | protocol | PASS | present+enabled: {'delegate': True, 'github': True, 'build-page': True} |
| T33 | mailbox | protocol | KNOWN-GAP | mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured) |
| T34 | heartbeat | protocol | PASS | heartbeat defaults: {'enabled': False, 'every': '6h', 'target': 'main', 'timeoutSeconds': 300, 'activeHours': None} (record only; do NOT enable) |
| T35 | approvals | protocol | PASS | default approval_level=AUTO (SMART patch is NOT applied) |
| T36 | approvals | protocol | FAIL | effect allow occurrences=2 parse=True DriverCardError count=2. DriverCardError lines present in log — see TESTS.md T36 (QA card failed to parse at verification time). |
| T37 | approvals | protocol | PASS | approval-pending count before=7 after list_apps=7 |
| T38 | fleet | protocol | PASS | fleet list exit ok; agents listed: True; head=active agent : default agent order : ['default'] active model : {"provider_id": "mosicn", "model": "nex-n2.6"} heartbeat : {"enabled": false, "every": "6h", "target": "main", "timeoutSeconds": 300, "activeHours": null} I |
| T39 | evals | protocol | PASS | cases v1 ['identity-en', 'english-only', 'no-china-endpoint', 'timezone-awareness', 'destructive-refusal']; prompts/v1=['AGENTS.md', 'HEARTBEAT.md', 'PROFILE.md', 'README.md', 'SOUL.md'] |
| T40 | evals | protocol | PASS | exit=0 dry-run=True tail=POST {BASE}/api/console/chat/task, then poll GET {BASE}/api/console/chat/task/{task_id}. |
| T41 | import-export | protocol | PASS | exported 12 files (agent=QwenPaw_QA_Agent_0.2) -> /tmp/tp-qa-export.tgz excluded by design: history.db*, sessions/, checkpoints/, state/, memory/, mem_*, media/, resource/, drivers/, digest/ EXPORT_EXIT=0 verify OK: 12 files, agent=QwenPaw_QA_Agent_0.2 VERIFY_EXIT=0 |
| T42 | import-export | protocol | PASS | import=True agent.json hashes match=True files=True raw=imported agent=QwenPaw_QA_Agent_0.2 -> /tmp/tp-qa-restore NOTE: a new workspace is only picked up by QwenPaw at startup; registering it in config.json agents.profiles is a separate, approved step (see 11-fleet-manager.md |
| T43 | keepalive | protocol | PASS | HTTP 200 status=up httpStatus=200 failures=0 source=cron:*/5 * * * * |
| T44 | keepalive | protocol | PASS | HTTP 200 status=up source=manual-ping |
| T45 | keepalive | protocol | PASS | backup root=200 status=200 auth=200 body={"enabled":true,"has_users":true} |
| T46 | harness | protocol | PASS | features/desktop/harness-desktop-gate.mjs: exit=0 tally=105 passed, 0 failed tail=105 passed, 0 failed |
| T47 | harness | protocol | PASS | features/desktop/harness-desktop-chrome.mjs: exit=0 tally=13 passed, 0 failed tail=13 passed, 0 failed |
| T48 | harness | protocol | PASS | features/desktop/harness-desktop-origin.mjs: exit=0 tally=9 passed, 0 failed tail=9 passed, 0 failed |
| T49 | lease | protocol | PASS | lease 1c9f4835… holder=user; control file: human worker-lease 1794707112; deleted below |
| T50 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T51 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T52 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T53 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T54 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T55 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T56 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T57 | screenshot | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T58 | console | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T59 | groupchat | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T60 | board | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T61 | evals | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |

### Notes (non-pass rows)
- **T01** (FAIL): HTTP 0 size=65 markers=[]
- **T02** (FAIL): HTTP 0 size=41 title=False
- **T06** (FAIL): HTTP 0 size=67
- **T07** (FAIL): 
- **T15** (FAIL): live markers=[]; _worker.js consolePanelScript lines=2, 316px lines=3
- **T21** (FAIL): / HTTP 0; /api/status HTTP 200 qwenpaw={'status': 'up', 'httpStatus': 200, 'note': 'QwenPaw console answered'} routines=['daily-summary', 'inbox-check-30m']
- **T27** (FAIL): / HTTP 0; /health HTTP 200 body={"ok":true,"worker":"qwenpaw-board"}
- **T33** (KNOWN-GAP): mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured)
- **T36** (FAIL): effect allow occurrences=2 parse=True DriverCardError count=2. DriverCardError lines present in log — see TESTS.md T36 (QA card failed to parse at verification time).

## Round 3 — 2026-11-15T01:52:25Z (UTC), `run-tests.py`

Protocol run by the runner; browser / needs-token rows were recorded as skipped, not run. Summary: PASS=45, FAIL=3, KNOWN-GAP=1, NEEDS-BROWSER=8, NEEDS-TOKEN=4.

| Test | Area | Method | Result | Evidence |
|---|---|---|---|---|
| T01 | console | protocol | PASS | HTTP 200 size=40445 markers=['qwenpawComputerBtn', 'qwenpawComputerPanel'] |
| T02 | console | protocol | PASS | HTTP 200 size=5587 title=True |
| T03 | console | protocol | PASS | HTTP 200 body={"enabled":true,"has_users":true} |
| T04 | console | protocol | PASS | HTTP 200 size=1878 gate=True |
| T05 | console | protocol | PASS | default={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":19} qa={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":2} |
| T06 | console | protocol | PASS | HTTP 200 size=283218 |
| T07 | desktop | protocol | PASS | 6081 GET 200 WS HTTP/1.1 101 Switching Protocols 6082 GET 200 WS HTTP/1.1 101 Switching Protocols 6083 GET 200 WS HTTP/1.1 101 Switching Protocols 6084 GET 200 WS HTTP/1.1 101 Switching Protocols 6085 GET 200 WS HTTP/1.1 101 Switching Protocols |
| T08 | desktop | protocol | PASS | 17/17 active |
| T09 | desktop | protocol | PASS | ws_status=HTTP/1.1 101 Switching Protocols echo_found=True bytes_read=23 |
| T10 | mcp | protocol | PASS | 8898 200 8897 200 |
| T11 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=104998, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled] xfdesktop -- xfdesktop [running, pid=50676, wind |
| T12 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=111374, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfwm4 -- xfwm4 [running, pid=109672, window=untitled] |
| T13 | desktop | protocol | PASS | __teach HTTP 200 gate=True; __pending-skills HTTP 401 body={"ok":false,"error":"unauthorized"} |
| T14 | desktop | protocol | PASS | POST __needs-you HTTP 401 body={"ok":false,"error":"unauthorized"}; GET __needs-you HTTP 200 gate=True |
| T15 | desktop | protocol | PASS | live markers=['qwenpawComputerBtn', 'qwenpawComputerPanel']; _worker.js consolePanelScript lines=2, 316px lines=3 |
| T16 | desktop | protocol | PASS | PREVIEW_S=15:True files=[('/data/home/mcp-proxy/preview.png', 14, 499604), ('/data/home/mcp-proxy/preview-qa.png', 13, 707632)] upload401:True preview-gate200:True |
| T17 | screenshot | protocol | FAIL | dims1920x1080:True sizes=[598876, 243014] raw=[{'left': 0, 'top': 0, 'width': 1920, 'height': 1080}, {'left': 0, 'top': 0, 'width': 1920, 'height': 1080, 'is_primary': False, 'output': 'VNC-0'}] saved: /tmp/mss-test.png scrot: `/tmp/scrot-test.png` already exists, attempting `/tmp/scrot-test_001 |
| T18 | bridge | protocol | PASS | /health={"ok": true, "browser_alive": true, "title": "Satwik Samanta (@0xSatwik) / X", "url": "https://x.com/0xsatwik"} |
| T19 | bridge | protocol | PASS | url=https://x.com/0xsatwik title=Satwik Samanta (@0xSatwik) / X (token never recorded) |
| T20 | bridge | protocol | PASS | /desktop-open={"ok": true, "url": "https://wordsolverx.com", "display": ":1", "agent": "default", "note": "opened on the InstaBox desktop (display :1)"} (token never recorded) |
| T21 | routines | protocol | PASS | / HTTP 200; /api/status HTTP 200 qwenpaw={'status': 'up', 'httpStatus': 200, 'note': 'QwenPaw console answered'} routines=['daily-summary', 'inbox-check-30m'] |
| T22 | routines | protocol | PASS | schedules=['*/30 * * * *', '30 1 * * *'] |
| T23 | routines | protocol | PASS | POST /trigger no token -> HTTP 401 body={ "error": "unauthorized" } |
| T24 | routines | protocol | PASS | recent kinds=['daily-summary-slot', 'manual-trigger', 'wake-tick'] wake-tick=2026-11-15T01:30:12.685Z daily=2026-11-15T01:30:27.825Z |
| T25 | groupchat | protocol | PASS | HTTP 200 body={"service":"qwenpaw-groupchat","thread":"one shared thread for QwenPaw agents default + QwenPaw_QA_Agent_0.2","store":"durable-object (sqlite)","auth_required":true,"endpoints":["GET /thread[?since=<s |
| T26 | groupchat | protocol | PASS | POST /thread/message HTTP 401 {"error":"unauthorized"}; GET /thread HTTP 401 {"error":"unauthorized"} |
| T27 | board | protocol | PASS | / HTTP 200; /health HTTP 200 body={"ok":true,"worker":"qwenpaw-board"} |
| T28 | board | protocol | PASS | GET /api/tickets no key -> HTTP 401 body={"error":"unauthorized — send the board key as ?key= or X-Board-Key header"} |
| T29 | botpages | protocol | PASS | HTTP 200 size=1293 |
| T30 | botpages | protocol | PASS | HTTP 200 size=9831 |
| T31 | skills | protocol | PASS | Showing: 19 of 19 skills, 19 enabled, 0 disabled rows=19 |
| T32 | skills | protocol | PASS | present+enabled: {'delegate': True, 'github': True, 'build-page': True} |
| T33 | mailbox | protocol | KNOWN-GAP | mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured) |
| T34 | heartbeat | protocol | PASS | heartbeat defaults: {'enabled': False, 'every': '6h', 'target': 'main', 'timeoutSeconds': 300, 'activeHours': None} (record only; do NOT enable) |
| T35 | approvals | protocol | PASS | default approval_level=AUTO (SMART patch is NOT applied) |
| T36 | approvals | protocol | PASS | effect allow occurrences=2 parse=True last_error_line=2577 last_refresh_line=2584. |
| T37 | approvals | protocol | PASS | approval-pending count before=7 after list_apps=7 |
| T38 | fleet | protocol | PASS | fleet list exit ok; agents listed: True; head=active agent : default agent order : ['default'] active model : {"provider_id": "mosicn", "model": "nex-n2.6"} heartbeat : {"enabled": false, "every": "6h", "target": "main", "timeoutSeconds": 300, "activeHours": null} I |
| T39 | evals | protocol | PASS | cases v1 ['identity-en', 'english-only', 'no-china-endpoint', 'timezone-awareness', 'destructive-refusal']; prompts/v1=['AGENTS.md', 'HEARTBEAT.md', 'PROFILE.md', 'README.md', 'SOUL.md'] |
| T40 | evals | protocol | PASS | exit=0 dry-run=True tail=POST {BASE}/api/console/chat/task, then poll GET {BASE}/api/console/chat/task/{task_id}. |
| T41 | import-export | protocol | PASS | exported 12 files (agent=QwenPaw_QA_Agent_0.2) -> /tmp/tp-qa-export.tgz excluded by design: history.db*, sessions/, checkpoints/, state/, memory/, mem_*, media/, resource/, drivers/, digest/ EXPORT_EXIT=0 verify OK: 12 files, agent=QwenPaw_QA_Agent_0.2 VERIFY_EXIT=0 |
| T42 | import-export | protocol | FAIL | import=False agent.json hashes match=True files=True raw=destination exists: /tmp/tp-qa-restore refusing to overwrite. Re-run with --backup-dir DIR to move the existing workspace aside first (it is never deleted). IMPORT_EXIT=1 8819d08ee836928e98d241e0caba05c77bce92af45a8acda3 |
| T43 | keepalive | protocol | PASS | HTTP 200 status=up httpStatus=200 failures=0 source=cron:*/5 * * * * |
| T44 | keepalive | protocol | PASS | HTTP 200 status=up source=manual-ping |
| T45 | keepalive | protocol | PASS | backup root=200 status=200 auth=200 body={"enabled":true,"has_users":true} |
| T46 | harness | protocol | PASS | features/desktop/harness-desktop-gate.mjs: exit=0 tally=105 passed, 0 failed tail=105 passed, 0 failed |
| T47 | harness | protocol | PASS | features/desktop/harness-desktop-chrome.mjs: exit=0 tally=13 passed, 0 failed tail=13 passed, 0 failed |
| T48 | harness | protocol | PASS | features/desktop/harness-desktop-origin.mjs: exit=0 tally=9 passed, 0 failed tail=9 passed, 0 failed |
| T49 | lease | protocol | FAIL | __lease showed holder=user but the QA control file never appeared (watcher should mirror it) |
| T50 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T51 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T52 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T53 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T54 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T55 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T56 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T57 | screenshot | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T58 | console | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T59 | groupchat | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T60 | board | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T61 | evals | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |

### Notes (non-pass rows)
- **T17** (FAIL): dims1920x1080:True sizes=[598876, 243014] raw=[{'left': 0, 'top': 0, 'width': 1920, 'height': 1080}, {'left': 0, 'top': 0, 'width': 1920, 'height': 1080, 'is_primary': False, 'output': 'VNC-0'}] saved: /tmp/mss-test.png scrot: `/tmp/scrot-test.png` already exists, attempting `/tmp/scrot-test_001
- **T33** (KNOWN-GAP): mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured)
- **T42** (FAIL): import=False agent.json hashes match=True files=True raw=destination exists: /tmp/tp-qa-restore refusing to overwrite. Re-run with --backup-dir DIR to move the existing workspace aside first (it is never deleted). IMPORT_EXIT=1 8819d08ee836928e98d241e0caba05c77bce92af45a8acda3
- **T49** (FAIL): __lease showed holder=user but the QA control file never appeared (watcher should mirror it)

## Round 4 — 2026-11-15T01:57:03Z (UTC), `run-tests.py`

Protocol run by the runner; browser / needs-token rows were recorded as skipped, not run. Summary: PASS=48, KNOWN-GAP=1, NEEDS-BROWSER=8, NEEDS-TOKEN=4.

| Test | Area | Method | Result | Evidence |
|---|---|---|---|---|
| T01 | console | protocol | PASS | HTTP 200 size=40445 markers=['qwenpawComputerBtn', 'qwenpawComputerPanel'] |
| T02 | console | protocol | PASS | HTTP 200 size=5587 title=True |
| T03 | console | protocol | PASS | HTTP 200 body={"enabled":true,"has_users":true} |
| T04 | console | protocol | PASS | HTTP 200 size=1878 gate=True |
| T05 | console | protocol | PASS | default={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":19} qa={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":2} |
| T06 | console | protocol | PASS | HTTP 200 size=283218 |
| T07 | desktop | protocol | PASS | 6081 GET 200 WS HTTP/1.1 101 Switching Protocols 6082 GET 200 WS HTTP/1.1 101 Switching Protocols 6083 GET 200 WS HTTP/1.1 101 Switching Protocols 6084 GET 200 WS HTTP/1.1 101 Switching Protocols 6085 GET 200 WS HTTP/1.1 101 Switching Protocols |
| T08 | desktop | protocol | PASS | 17/17 active |
| T09 | desktop | protocol | PASS | ws_status=HTTP/1.1 101 Switching Protocols echo_found=True bytes_read=23 |
| T10 | mcp | protocol | PASS | 8898 200 8897 200 |
| T11 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=104998, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled] xfdesktop -- xfdesktop [running, pid=50676, wind |
| T12 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=111374, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfwm4 -- xfwm4 [running, pid=109672, window=untitled] |
| T13 | desktop | protocol | PASS | __teach HTTP 200 gate=True; __pending-skills HTTP 401 body={"ok":false,"error":"unauthorized"} |
| T14 | desktop | protocol | PASS | POST __needs-you HTTP 401 body={"ok":false,"error":"unauthorized"}; GET __needs-you HTTP 200 gate=True |
| T15 | desktop | protocol | PASS | live markers=['qwenpawComputerBtn', 'qwenpawComputerPanel']; _worker.js consolePanelScript lines=2, 316px lines=3 |
| T16 | desktop | protocol | PASS | PREVIEW_S=15:True files=[('/data/home/mcp-proxy/preview.png', 4, 500339), ('/data/home/mcp-proxy/preview-qa.png', 3, 707635)] upload401:True preview-gate200:True |
| T17 | screenshot | protocol | PASS | mss=599975B mean=72.48 scrot=500289B mean=72.48 |
| T18 | bridge | protocol | PASS | /health={"ok": true, "browser_alive": true, "title": "Satwik Samanta (@0xSatwik) / X", "url": "https://x.com/0xsatwik"} |
| T19 | bridge | protocol | PASS | url=https://x.com/0xsatwik title=Satwik Samanta (@0xSatwik) / X (token never recorded) |
| T20 | bridge | protocol | PASS | /desktop-open={"ok": true, "url": "https://wordsolverx.com", "display": ":1", "agent": "default", "note": "opened on the InstaBox desktop (display :1)"} (token never recorded) |
| T21 | routines | protocol | PASS | / HTTP 200; /api/status HTTP 200 qwenpaw={'status': 'up', 'httpStatus': 200, 'note': 'QwenPaw console answered'} routines=['daily-summary', 'inbox-check-30m'] |
| T22 | routines | protocol | PASS | schedules=['*/30 * * * *', '30 1 * * *'] |
| T23 | routines | protocol | PASS | POST /trigger no token -> HTTP 401 body={ "error": "unauthorized" } |
| T24 | routines | protocol | PASS | recent kinds=['daily-summary-slot', 'manual-trigger', 'wake-tick'] wake-tick=2026-11-15T01:30:12.685Z daily=2026-11-15T01:30:27.825Z |
| T25 | groupchat | protocol | PASS | HTTP 200 body={"service":"qwenpaw-groupchat","thread":"one shared thread for QwenPaw agents default + QwenPaw_QA_Agent_0.2","store":"durable-object (sqlite)","auth_required":true,"endpoints":["GET /thread[?since=<s |
| T26 | groupchat | protocol | PASS | POST /thread/message HTTP 401 {"error":"unauthorized"}; GET /thread HTTP 401 {"error":"unauthorized"} |
| T27 | board | protocol | PASS | / HTTP 200; /health HTTP 200 body={"ok":true,"worker":"qwenpaw-board"} |
| T28 | board | protocol | PASS | GET /api/tickets no key -> HTTP 401 body={"error":"unauthorized — send the board key as ?key= or X-Board-Key header"} |
| T29 | botpages | protocol | PASS | HTTP 200 size=1293 |
| T30 | botpages | protocol | PASS | HTTP 200 size=9831 |
| T31 | skills | protocol | PASS | Showing: 19 of 19 skills, 19 enabled, 0 disabled rows=19 |
| T32 | skills | protocol | PASS | present+enabled: {'delegate': True, 'github': True, 'build-page': True} |
| T33 | mailbox | protocol | KNOWN-GAP | mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured) |
| T34 | heartbeat | protocol | PASS | heartbeat defaults: {'enabled': False, 'every': '6h', 'target': 'main', 'timeoutSeconds': 300, 'activeHours': None} (record only; do NOT enable) |
| T35 | approvals | protocol | PASS | default approval_level=AUTO (SMART patch is NOT applied) |
| T36 | approvals | protocol | PASS | effect allow occurrences=2 parse=True last_error_line=2577 last_refresh_line=2584. |
| T37 | approvals | protocol | PASS | approval-pending count before=7 after list_apps=7 |
| T38 | fleet | protocol | PASS | fleet list exit ok; agents listed: True; head=active agent : default agent order : ['default'] active model : {"provider_id": "mosicn", "model": "nex-n2.6"} heartbeat : {"enabled": false, "every": "6h", "target": "main", "timeoutSeconds": 300, "activeHours": null} I |
| T39 | evals | protocol | PASS | cases v1 ['identity-en', 'english-only', 'no-china-endpoint', 'timezone-awareness', 'destructive-refusal']; prompts/v1=['AGENTS.md', 'HEARTBEAT.md', 'PROFILE.md', 'README.md', 'SOUL.md'] |
| T40 | evals | protocol | PASS | exit=0 dry-run=True tail=POST {BASE}/api/console/chat/task, then poll GET {BASE}/api/console/chat/task/{task_id}. |
| T41 | import-export | protocol | PASS | exported 12 files (agent=QwenPaw_QA_Agent_0.2) -> /tmp/tp-qa-export.tgz excluded by design: history.db*, sessions/, checkpoints/, state/, memory/, mem_*, media/, resource/, drivers/, digest/ EXPORT_EXIT=0 verify OK: 12 files, agent=QwenPaw_QA_Agent_0.2 VERIFY_EXIT=0 |
| T42 | import-export | protocol | PASS | import=True agent.json hashes match=True files=True raw=imported agent=QwenPaw_QA_Agent_0.2 -> /tmp/tp-qa-restore NOTE: a new workspace is only picked up by QwenPaw at startup; registering it in config.json agents.profiles is a separate, approved step (see 11-fleet-manager.md |
| T43 | keepalive | protocol | PASS | HTTP 200 status=up httpStatus=200 failures=0 source=cron:*/5 * * * * |
| T44 | keepalive | protocol | PASS | HTTP 200 status=up source=manual-ping |
| T45 | keepalive | protocol | PASS | backup root=200 status=200 auth=200 body={"enabled":true,"has_users":true} |
| T46 | harness | protocol | PASS | features/desktop/harness-desktop-gate.mjs: exit=0 tally=105 passed, 0 failed tail=105 passed, 0 failed |
| T47 | harness | protocol | PASS | features/desktop/harness-desktop-chrome.mjs: exit=0 tally=13 passed, 0 failed tail=13 passed, 0 failed |
| T48 | harness | protocol | PASS | features/desktop/harness-desktop-origin.mjs: exit=0 tally=9 passed, 0 failed tail=9 passed, 0 failed |
| T49 | lease | protocol | PASS | lease b8a48c09… holder=user; control file: human worker-lease 1794707819; deleted below |
| T50 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T51 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T52 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T53 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T54 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T55 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T56 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T57 | screenshot | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T58 | console | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T59 | groupchat | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T60 | board | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T61 | evals | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |

### Notes (non-pass rows)
- **T33** (KNOWN-GAP): mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured)

## Round 5 — 2026-11-15T08:19:01Z (UTC), `run-tests.py`

Protocol run by the runner; browser / needs-token rows were recorded as skipped, not run. Summary: PASS=44, FAIL=3, KNOWN-GAP=1, NEEDS-VERIFICATION=1, NEEDS-BROWSER=8, NEEDS-TOKEN=4.

| Test | Area | Method | Result | Evidence |
|---|---|---|---|---|
| T01 | console | protocol | PASS | HTTP 200 size=46691 markers=['qwenpawComputerBtn', 'qwenpawComputerPanel'] |
| T02 | console | protocol | PASS | HTTP 200 size=5587 title=True |
| T03 | console | protocol | PASS | HTTP 200 body={"enabled":true,"has_users":true} |
| T04 | console | protocol | PASS | HTTP 200 size=1878 gate=True |
| T05 | console | protocol | PASS | default={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":19} qa={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":2} |
| T06 | console | protocol | PASS | HTTP 200 size=283218 |
| T07 | desktop | protocol | PASS | 6081 GET 200 WS HTTP/1.1 101 Switching Protocols 6082 GET 200 WS HTTP/1.1 101 Switching Protocols 6083 GET 200 WS HTTP/1.1 101 Switching Protocols 6084 GET 200 WS HTTP/1.1 101 Switching Protocols 6085 GET 200 WS HTTP/1.1 101 Switching Protocols |
| T08 | desktop | protocol | PASS | 17/17 active |
| T09 | desktop | protocol | PASS | ws_status=HTTP/1.1 101 Switching Protocols echo_found=True bytes_read=228 |
| T10 | mcp | protocol | PASS | 8898 200 8897 200 |
| T11 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=104998, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled] xfdesktop -- xfdesktop [running, pid=50676, wind |
| T12 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=111374, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfwm4 -- xfwm4 [running, pid=109672, window=untitled] |
| T13 | desktop | protocol | PASS | __teach HTTP 200 gate=True; __pending-skills HTTP 401 body={"ok":false,"error":"unauthorized"} |
| T14 | desktop | protocol | PASS | POST __needs-you HTTP 401 body={"ok":false,"error":"unauthorized"}; GET __needs-you HTTP 200 gate=True |
| T15 | desktop | protocol | PASS | live markers=['qwenpawComputerBtn', 'qwenpawComputerPanel']; _worker.js consolePanelScript lines=2, 316px lines=3 |
| T16 | desktop | protocol | FAIL | PREVIEW_S=15:False files=[('/data/home/mcp-proxy/preview.png', 26, 500411), ('/data/home/mcp-proxy/preview-qa.png', 26, 707634)] upload401:True preview-gate200:True |
| T17 | screenshot | protocol | PASS | mss=600001B mean=72.52 scrot=500476B mean=72.52 |
| T18 | bridge | protocol | PASS | /health={"ok": true, "browser_alive": true, "title": "Satwik Samanta (@0xSatwik) / X", "url": "https://x.com/0xsatwik"} |
| T19 | bridge | protocol | PASS | url=https://x.com/0xsatwik title=Satwik Samanta (@0xSatwik) / X (token never recorded) |
| T20 | bridge | protocol | PASS | /desktop-open={"ok": true, "url": "https://wordsolverx.com", "display": ":1", "agent": "default", "note": "opened on the InstaBox desktop (display :1)"} (token never recorded) |
| T21 | routines | protocol | PASS | / HTTP 200; /api/status HTTP 200 qwenpaw={'status': 'up', 'httpStatus': 200, 'note': 'QwenPaw console answered'} routines=['daily-summary', 'inbox-check-30m'] |
| T22 | routines | protocol | PASS | schedules=['*/30 * * * *', '30 1 * * *'] |
| T23 | routines | protocol | PASS | POST /trigger no token -> HTTP 401 body={ "error": "unauthorized" } |
| T24 | routines | protocol | PASS | recent kinds=['daily-summary-slot', 'manual-trigger', 'wake-tick'] wake-tick=2026-11-15T07:30:12.890Z daily=2026-11-15T01:30:27.825Z |
| T25 | groupchat | protocol | PASS | HTTP 200 body={"service":"qwenpaw-groupchat","thread":"one shared thread for QwenPaw agents default + QwenPaw_QA_Agent_0.2","store":"durable-object (sqlite)","auth_required":true,"endpoints":["GET /thread[?since=<s |
| T26 | groupchat | protocol | PASS | POST /thread/message HTTP 401 {"error":"unauthorized"}; GET /thread HTTP 401 {"error":"unauthorized"} |
| T27 | board | protocol | PASS | / HTTP 200; /health HTTP 200 body={"ok":true,"worker":"qwenpaw-board"} |
| T28 | board | protocol | PASS | GET /api/tickets no key -> HTTP 401 body={"error":"unauthorized — send the board key as ?key= or X-Board-Key header"} |
| T29 | botpages | protocol | PASS | HTTP 200 size=1293 |
| T30 | botpages | protocol | PASS | HTTP 200 size=9831 |
| T31 | skills | protocol | PASS | Showing: 19 of 19 skills, 19 enabled, 0 disabled rows=19 |
| T32 | skills | protocol | PASS | present+enabled: {'delegate': True, 'github': True, 'build-page': True} |
| T33 | mailbox | protocol | KNOWN-GAP | mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured) |
| T34 | heartbeat | protocol | PASS | heartbeat defaults: {'enabled': False, 'every': '6h', 'target': 'main', 'timeoutSeconds': 300, 'activeHours': None} (record only; do NOT enable) |
| T35 | approvals | protocol | PASS | default approval_level=AUTO (SMART patch is NOT applied) |
| T36 | approvals | protocol | PASS | effect allow occurrences=2 parse=True last_error_line=2577 last_refresh_line=2817. |
| T37 | approvals | protocol | PASS | approval-pending count before=7 after list_apps=7 |
| T38 | fleet | protocol | PASS | fleet list exit ok; agents listed: True; head=active agent : default agent order : ['default'] active model : {"provider_id": "mosicn", "model": "nex-n2.6"} heartbeat : {"enabled": false, "every": "6h", "target": "main", "timeoutSeconds": 300, "activeHours": null} I |
| T39 | evals | protocol | PASS | cases v1 ['identity-en', 'english-only', 'no-china-endpoint', 'timezone-awareness', 'destructive-refusal']; prompts/v1=['AGENTS.md', 'HEARTBEAT.md', 'PROFILE.md', 'README.md', 'SOUL.md'] |
| T40 | evals | protocol | PASS | exit=0 dry-run=True tail=POST {BASE}/api/console/chat/task, then poll GET {BASE}/api/console/chat/task/{task_id}. |
| T41 | import-export | protocol | PASS | exported 12 files (agent=QwenPaw_QA_Agent_0.2) -> /tmp/tp-qa-export.tgz excluded by design: history.db*, sessions/, checkpoints/, state/, memory/, mem_*, media/, resource/, drivers/, digest/ EXPORT_EXIT=0 verify OK: 12 files, agent=QwenPaw_QA_Agent_0.2 VERIFY_EXIT=0 |
| T42 | import-export | protocol | PASS | import=True agent.json hashes match=True files=True raw=imported agent=QwenPaw_QA_Agent_0.2 -> /tmp/tp-qa-restore NOTE: a new workspace is only picked up by QwenPaw at startup; registering it in config.json agents.profiles is a separate, approved step (see 11-fleet-manager.md |
| T43 | keepalive | protocol | PASS | HTTP 200 status=up httpStatus=200 failures=0 source=cron:*/5 * * * * |
| T44 | keepalive | protocol | PASS | HTTP 200 status=up source=manual-ping |
| T45 | keepalive | protocol | PASS | backup root=200 status=200 auth=200 body={"enabled":true,"has_users":true} |
| T46 | harness | protocol | FAIL | features/desktop/harness-desktop-gate.mjs: exit=0 tally=133 passed, 0 failed tail=133 passed, 0 failed |
| T47 | harness | protocol | FAIL | features/desktop/harness-desktop-chrome.mjs: exit=0 tally=38 passed, 0 failed tail=38 passed, 0 failed |
| T48 | harness | protocol | PASS | features/desktop/harness-desktop-origin.mjs: exit=0 tally=9 passed, 0 failed tail=9 passed, 0 failed |
| T49 | lease | protocol | NEEDS-VERIFICATION | cf.py put-raw exit 1: { "result": null, "errors": [ { "code": 10048, "message": "your account has reached the free usage limit for this operation for today" } ], "messages": [], "success": false } — exact question in TESTS.md T49 (KV write call unproven) |
| T50 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T51 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T52 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T53 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T54 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T55 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T56 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T57 | screenshot | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T58 | console | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T59 | groupchat | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T60 | board | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T61 | evals | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |

### Notes (non-pass rows)
- **T16** (FAIL): PREVIEW_S=15:False files=[('/data/home/mcp-proxy/preview.png', 26, 500411), ('/data/home/mcp-proxy/preview-qa.png', 26, 707634)] upload401:True preview-gate200:True
- **T33** (KNOWN-GAP): mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured)
- **T46** (FAIL): features/desktop/harness-desktop-gate.mjs: exit=0 tally=133 passed, 0 failed tail=133 passed, 0 failed
- **T47** (FAIL): features/desktop/harness-desktop-chrome.mjs: exit=0 tally=38 passed, 0 failed tail=38 passed, 0 failed
- **T49** (NEEDS-VERIFICATION): cf.py put-raw exit 1: { "result": null, "errors": [ { "code": 10048, "message": "your account has reached the free usage limit for this operation for today" } ], "messages": [], "success": false } — exact question in TESTS.md T49 (KV write call unproven)

## Round 6 — 2026-11-15T08:34:07Z (UTC), `run-tests.py`

Protocol run by the runner; browser / needs-token rows were recorded as skipped, not run. Summary: PASS=49, KNOWN-GAP=1, NEEDS-BROWSER=8, NEEDS-TOKEN=4.

| Test | Area | Method | Result | Evidence |
|---|---|---|---|---|
| T01 | console | protocol | PASS | HTTP 200 size=46691 markers=['qwenpawComputerBtn', 'qwenpawComputerPanel'] |
| T02 | console | protocol | PASS | HTTP 200 size=5587 title=True |
| T03 | console | protocol | PASS | HTTP 200 body={"enabled":true,"has_users":true} |
| T04 | console | protocol | PASS | HTTP 200 size=1878 gate=True |
| T05 | console | protocol | PASS | default={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":19} qa={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":2} |
| T06 | console | protocol | PASS | HTTP 200 size=283218 |
| T07 | desktop | protocol | PASS | 6081 GET 200 WS HTTP/1.1 101 Switching Protocols 6082 GET 200 WS HTTP/1.1 101 Switching Protocols 6083 GET 200 WS HTTP/1.1 101 Switching Protocols 6084 GET 200 WS HTTP/1.1 101 Switching Protocols 6085 GET 200 WS HTTP/1.1 101 Switching Protocols |
| T08 | desktop | protocol | PASS | 17/17 active |
| T09 | desktop | protocol | PASS | ws_status=HTTP/1.1 101 Switching Protocols echo_found=True bytes_read=23 |
| T10 | mcp | protocol | PASS | 8898 200 8897 200 |
| T11 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=104998, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled] xfdesktop -- xfdesktop [running, pid=50676, wind |
| T12 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=111374, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfwm4 -- xfwm4 [running, pid=109672, window=untitled] |
| T13 | desktop | protocol | PASS | __teach HTTP 200 gate=True; __pending-skills HTTP 401 body={"ok":false,"error":"unauthorized"} |
| T14 | desktop | protocol | PASS | POST __needs-you HTTP 401 body={"ok":false,"error":"unauthorized"}; GET __needs-you HTTP 200 gate=True |
| T15 | desktop | protocol | PASS | live markers=['qwenpawComputerBtn', 'qwenpawComputerPanel']; _worker.js consolePanelScript lines=2, 316px lines=3 |
| T16 | desktop | protocol | PASS | PREVIEW_MIN_S=120:True files=[('/data/home/mcp-proxy/preview.png', 14, 500572), ('/data/home/mcp-proxy/preview-qa.png', 14, 707622)] upload401:True preview-gate200:True |
| T17 | screenshot | protocol | PASS | mss=600142B mean=72.56 scrot=500533B mean=72.56 |
| T18 | bridge | protocol | PASS | /health={"ok": true, "browser_alive": true, "title": "Satwik Samanta (@0xSatwik) / X", "url": "https://x.com/0xsatwik"} |
| T19 | bridge | protocol | PASS | url=https://x.com/0xsatwik title=Satwik Samanta (@0xSatwik) / X (token never recorded) |
| T20 | bridge | protocol | PASS | /desktop-open={"ok": true, "url": "https://wordsolverx.com", "display": ":1", "agent": "default", "note": "opened on the InstaBox desktop (display :1)"} (token never recorded) |
| T21 | routines | protocol | PASS | / HTTP 200; /api/status HTTP 200 qwenpaw={'status': 'up', 'httpStatus': 200, 'note': 'QwenPaw console answered'} routines=['daily-summary', 'inbox-check-30m'] |
| T22 | routines | protocol | PASS | schedules=['*/30 * * * *', '30 1 * * *'] |
| T23 | routines | protocol | PASS | POST /trigger no token -> HTTP 401 body={ "error": "unauthorized" } |
| T24 | routines | protocol | PASS | recent kinds=['daily-summary-slot', 'manual-trigger', 'wake-tick'] wake-tick=2026-11-15T07:30:12.890Z daily=2026-11-15T01:30:27.825Z |
| T25 | groupchat | protocol | PASS | HTTP 200 body={"service":"qwenpaw-groupchat","thread":"one shared thread for QwenPaw agents default + QwenPaw_QA_Agent_0.2","store":"durable-object (sqlite)","auth_required":true,"endpoints":["GET /thread[?since=<s |
| T26 | groupchat | protocol | PASS | POST /thread/message HTTP 401 {"error":"unauthorized"}; GET /thread HTTP 401 {"error":"unauthorized"} |
| T27 | board | protocol | PASS | / HTTP 200; /health HTTP 200 body={"ok":true,"worker":"qwenpaw-board"} |
| T28 | board | protocol | PASS | GET /api/tickets no key -> HTTP 401 body={"error":"unauthorized — send the board key as ?key= or X-Board-Key header"} |
| T29 | botpages | protocol | PASS | HTTP 200 size=1293 |
| T30 | botpages | protocol | PASS | HTTP 200 size=9831 |
| T31 | skills | protocol | PASS | Showing: 19 of 19 skills, 19 enabled, 0 disabled rows=19 |
| T32 | skills | protocol | PASS | present+enabled: {'delegate': True, 'github': True, 'build-page': True} |
| T33 | mailbox | protocol | KNOWN-GAP | mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured) |
| T34 | heartbeat | protocol | PASS | heartbeat defaults: {'enabled': False, 'every': '6h', 'target': 'main', 'timeoutSeconds': 300, 'activeHours': None} (record only; do NOT enable) |
| T35 | approvals | protocol | PASS | default approval_level=AUTO (SMART patch is NOT applied) |
| T36 | approvals | protocol | PASS | effect allow occurrences=2 parse=True last_error_line=2577 last_refresh_line=2817. |
| T37 | approvals | protocol | PASS | approval-pending count before=7 after list_apps=7 |
| T38 | fleet | protocol | PASS | fleet list exit ok; agents listed: True; head=active agent : default agent order : ['default'] active model : {"provider_id": "mosicn", "model": "nex-n2.6"} heartbeat : {"enabled": false, "every": "6h", "target": "main", "timeoutSeconds": 300, "activeHours": null} I |
| T39 | evals | protocol | PASS | cases v1 ['identity-en', 'english-only', 'no-china-endpoint', 'timezone-awareness', 'destructive-refusal']; prompts/v1=['AGENTS.md', 'HEARTBEAT.md', 'PROFILE.md', 'README.md', 'SOUL.md'] |
| T40 | evals | protocol | PASS | exit=0 dry-run=True tail=POST {BASE}/api/console/chat/task, then poll GET {BASE}/api/console/chat/task/{task_id}. |
| T41 | import-export | protocol | PASS | exported 12 files (agent=QwenPaw_QA_Agent_0.2) -> /tmp/tp-qa-export.tgz excluded by design: history.db*, sessions/, checkpoints/, state/, memory/, mem_*, media/, resource/, drivers/, digest/ EXPORT_EXIT=0 verify OK: 12 files, agent=QwenPaw_QA_Agent_0.2 VERIFY_EXIT=0 |
| T42 | import-export | protocol | PASS | import=True agent.json hashes match=True files=True raw=imported agent=QwenPaw_QA_Agent_0.2 -> /tmp/tp-qa-restore NOTE: a new workspace is only picked up by QwenPaw at startup; registering it in config.json agents.profiles is a separate, approved step (see 11-fleet-manager.md |
| T43 | keepalive | protocol | PASS | HTTP 200 status=up httpStatus=200 failures=0 source=cron:*/5 * * * * |
| T44 | keepalive | protocol | PASS | HTTP 200 status=up source=manual-ping |
| T45 | keepalive | protocol | PASS | backup root=200 status=200 auth=200 body={"enabled":true,"has_users":true} |
| T46 | harness | protocol | PASS | features/desktop/harness-desktop-gate.mjs: exit=0 tally=133 passed, 0 failed tail=133 passed, 0 failed |
| T47 | harness | protocol | PASS | features/desktop/harness-desktop-chrome.mjs: exit=0 tally=38 passed, 0 failed tail=38 passed, 0 failed |
| T48 | harness | protocol | PASS | features/desktop/harness-desktop-origin.mjs: exit=0 tally=9 passed, 0 failed tail=9 passed, 0 failed |
| T49 | lease | protocol | PASS | lease 344c0c2d… holder=user; control file: human worker-lease 1794731645; deleted below |
| T50 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T51 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T52 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T53 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T54 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T55 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T56 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T57 | screenshot | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T58 | console | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T59 | groupchat | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T60 | board | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T61 | evals | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T62 | storage | protocol | PASS | features/storage/harness-store.mjs: exit=0 tally=38 passed, 0 failed tail=38 passed, 0 failed |

### Notes (non-pass rows)
- **T33** (KNOWN-GAP): mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured)

## Round 7 — 2026-11-15T08:58:45Z (UTC), `run-tests.py`

Protocol run by the runner; browser / needs-token rows were recorded as skipped, not run. Summary: PASS=50, KNOWN-GAP=1, NEEDS-BROWSER=8, NEEDS-TOKEN=4.

| Test | Area | Method | Result | Evidence |
|---|---|---|---|---|
| T01 | console | protocol | PASS | HTTP 200 size=46691 markers=['qwenpawComputerBtn', 'qwenpawComputerPanel'] |
| T02 | console | protocol | PASS | HTTP 200 size=5587 title=True |
| T03 | console | protocol | PASS | HTTP 200 body={"enabled":true,"has_users":true} |
| T04 | console | protocol | PASS | HTTP 200 size=1878 gate=True |
| T05 | console | protocol | PASS | default={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":19} qa={"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,"generation":2} |
| T06 | console | protocol | PASS | HTTP 200 size=283218 |
| T07 | desktop | protocol | PASS | 6081 GET 200 WS HTTP/1.1 101 Switching Protocols 6082 GET 200 WS HTTP/1.1 101 Switching Protocols 6083 GET 200 WS HTTP/1.1 101 Switching Protocols 6084 GET 200 WS HTTP/1.1 101 Switching Protocols 6085 GET 200 WS HTTP/1.1 101 Switching Protocols |
| T08 | desktop | protocol | PASS | 17/17 active |
| T09 | desktop | protocol | PASS | ws_status=HTTP/1.1 101 Switching Protocols echo_found=True bytes_read=228 |
| T10 | mcp | protocol | PASS | 8898 200 8897 200 |
| T11 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=104998, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfce4-panel -- xfce4-panel [running, pid=50665, window=untitled] xfdesktop -- xfdesktop [running, pid=50676, wind |
| T12 | mcp | protocol | PASS | server={'name': 'open-computer-use', 'version': '1.1.4'} tools=9 list_apps=Chromium -- Chromium [running, pid=111374, window=Daily Puzzle Answers, Solvers & Wordle Tools - Chromium] xfwm4 -- xfwm4 [running, pid=109672, window=untitled] |
| T13 | desktop | protocol | PASS | __teach HTTP 200 gate=True; __pending-skills HTTP 401 body={"ok":false,"error":"unauthorized"} |
| T14 | desktop | protocol | PASS | POST __needs-you HTTP 401 body={"ok":false,"error":"unauthorized"}; GET __needs-you HTTP 200 gate=True |
| T15 | desktop | protocol | PASS | live markers=['qwenpawComputerBtn', 'qwenpawComputerPanel']; _worker.js consolePanelScript lines=2, 316px lines=3 |
| T16 | desktop | protocol | PASS | PREVIEW_MIN_S=120:True files=[('/data/home/mcp-proxy/preview.png', 8, 500681), ('/data/home/mcp-proxy/preview-qa.png', 8, 707421)] upload401:True preview-gate200:True |
| T17 | screenshot | protocol | PASS | mss=600052B mean=72.6 scrot=500681B mean=72.6 |
| T18 | bridge | protocol | PASS | /health={"ok": true, "browser_alive": true, "title": "Satwik Samanta (@0xSatwik) / X", "url": "https://x.com/0xsatwik"} |
| T19 | bridge | protocol | PASS | url=https://x.com/0xsatwik title=Satwik Samanta (@0xSatwik) / X (token never recorded) |
| T20 | bridge | protocol | PASS | /desktop-open={"ok": true, "url": "https://wordsolverx.com", "display": ":1", "agent": "default", "note": "opened on the InstaBox desktop (display :1)"} (token never recorded) |
| T21 | routines | protocol | PASS | / HTTP 200; /api/status HTTP 200 qwenpaw={'status': 'up', 'httpStatus': 200, 'note': 'QwenPaw console answered'} routines=['daily-summary', 'inbox-check-30m'] |
| T22 | routines | protocol | PASS | schedules=['*/30 * * * *', '30 1 * * *'] |
| T23 | routines | protocol | PASS | POST /trigger no token -> HTTP 401 body={ "error": "unauthorized" } |
| T24 | routines | protocol | PASS | recent kinds=['daily-summary-slot', 'manual-trigger', 'wake-tick'] wake-tick=2026-11-15T07:30:12.890Z daily=2026-11-15T01:30:27.825Z |
| T25 | groupchat | protocol | PASS | HTTP 200 body={"service":"qwenpaw-groupchat","thread":"one shared thread for QwenPaw agents default + QwenPaw_QA_Agent_0.2","store":"durable-object (sqlite)","auth_required":true,"endpoints":["GET /thread[?since=<s |
| T26 | groupchat | protocol | PASS | POST /thread/message HTTP 401 {"error":"unauthorized"}; GET /thread HTTP 401 {"error":"unauthorized"} |
| T27 | board | protocol | PASS | / HTTP 200; /health HTTP 200 body={"ok":true,"worker":"qwenpaw-board","store":"d1"} |
| T28 | board | protocol | PASS | GET /api/tickets no key -> HTTP 401 body={"error":"unauthorized — send the board key as ?key= or X-Board-Key header"} |
| T29 | botpages | protocol | PASS | HTTP 200 size=1293 |
| T30 | botpages | protocol | PASS | HTTP 200 size=9831 |
| T31 | skills | protocol | PASS | Showing: 19 of 19 skills, 19 enabled, 0 disabled rows=19 |
| T32 | skills | protocol | PASS | present+enabled: {'delegate': True, 'github': True, 'build-page': True} |
| T33 | mailbox | protocol | KNOWN-GAP | mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured) |
| T34 | heartbeat | protocol | PASS | heartbeat defaults: {'enabled': False, 'every': '6h', 'target': 'main', 'timeoutSeconds': 300, 'activeHours': None} (record only; do NOT enable) |
| T35 | approvals | protocol | PASS | default approval_level=AUTO (SMART patch is NOT applied) |
| T36 | approvals | protocol | PASS | effect allow occurrences=2 parse=True last_error_line=2577 last_refresh_line=2817. |
| T37 | approvals | protocol | PASS | approval-pending count before=7 after list_apps=7 |
| T38 | fleet | protocol | PASS | fleet list exit ok; agents listed: True; head=active agent : default agent order : ['default'] active model : {"provider_id": "mosicn", "model": "nex-n2.6"} heartbeat : {"enabled": false, "every": "6h", "target": "main", "timeoutSeconds": 300, "activeHours": null} I |
| T39 | evals | protocol | PASS | cases v1 ['identity-en', 'english-only', 'no-china-endpoint', 'timezone-awareness', 'destructive-refusal']; prompts/v1=['AGENTS.md', 'HEARTBEAT.md', 'PROFILE.md', 'README.md', 'SOUL.md'] |
| T40 | evals | protocol | PASS | exit=0 dry-run=True tail=POST {BASE}/api/console/chat/task, then poll GET {BASE}/api/console/chat/task/{task_id}. |
| T41 | import-export | protocol | PASS | exported 12 files (agent=QwenPaw_QA_Agent_0.2) -> /tmp/tp-qa-export.tgz excluded by design: history.db*, sessions/, checkpoints/, state/, memory/, mem_*, media/, resource/, drivers/, digest/ EXPORT_EXIT=0 verify OK: 12 files, agent=QwenPaw_QA_Agent_0.2 VERIFY_EXIT=0 |
| T42 | import-export | protocol | PASS | import=True agent.json hashes match=True files=True raw=imported agent=QwenPaw_QA_Agent_0.2 -> /tmp/tp-qa-restore NOTE: a new workspace is only picked up by QwenPaw at startup; registering it in config.json agents.profiles is a separate, approved step (see 11-fleet-manager.md |
| T43 | keepalive | protocol | PASS | HTTP 200 status=up httpStatus=200 failures=0 source=cron:*/5 * * * * |
| T44 | keepalive | protocol | PASS | HTTP 200 status=up source=manual-ping |
| T45 | keepalive | protocol | PASS | backup root=200 status=200 auth=200 body={"enabled":true,"has_users":true} |
| T46 | harness | protocol | PASS | features/desktop/harness-desktop-gate.mjs: exit=0 tally=133 passed, 0 failed tail=133 passed, 0 failed |
| T47 | harness | protocol | PASS | features/desktop/harness-desktop-chrome.mjs: exit=0 tally=38 passed, 0 failed tail=38 passed, 0 failed |
| T48 | harness | protocol | PASS | features/desktop/harness-desktop-origin.mjs: exit=0 tally=9 passed, 0 failed tail=9 passed, 0 failed |
| T49 | lease | protocol | PASS | lease 51979769… holder=user; control file: human worker-lease 1794733114; deleted below |
| T50 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T51 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T52 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T53 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T54 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T55 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T56 | desktop | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T57 | screenshot | browser | NEEDS-BROWSER | needs a real logged-in browser (parent agent) — see TESTS.md |
| T58 | console | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T59 | groupchat | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T60 | board | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T61 | evals | needs-token | NEEDS-TOKEN | needs a user-held secret — never invented; see TESTS.md |
| T62 | storage | protocol | PASS | features/storage/harness-store.mjs: exit=0 tally=38 passed, 0 failed tail=38 passed, 0 failed |
| T63 | board | protocol | PASS | attempt 1: 401=30 429=5 follow-up retry-after=14 (machine burst, stable IP) |

### Notes (non-pass rows)
- **T33** (KNOWN-GAP): mailbox row present; mcp.clients={'anysearch': {'name': 'anysearch_mcp', 'description': 'AnySearch web search via MCP', 'enabled': False, 'transport': 's; log mentions qwenpawmail: False (Gmail MCP never configured)
