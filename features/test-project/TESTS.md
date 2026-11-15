# QwenPaw test catalogue (TESTS.md)

Bigger test project for QwenPaw on InstaBox Free. Every test has an id,
area, exact check command(s), expected result, method, and evidence to
record. Run with `run-tests.py` (protocol tests) or by hand / in a real
browser (needs-browser / needs-token tests). Record each round in
`RESULTS.md`.

**Scope:** everything built in Phase 0 (console, desktop Team :1 +
Private :2, bridge + Camoufox, computer-use MCP, routines, group chat,
ticket board, bot pages, skills, mailbox, heartbeat, approvals, fleet,
evals, import/export, teach, needs-you, terminal, maintenance,
keep-alive + Pages proxy). **JEV and Drex are NOT implemented yet —
no tests for them here** (PLAN.md Phase 2/3, after Phase 1).

**Grounding (all verified live 2026-11-15 unless marked):** public curls
from this VM; machine checks via
`python3 ~/workspace/custom-connectors/custom.instabox/bin/ib.py exec
m_agq5wqqo2fvypym7rjlpvngc2m <json>` where the JSON file is
`{"cmd": "...", "timeoutSeconds": N}` and the reply is
`{"stdout","stderr","exitCode","timedOut"}`; Cloudflare reads via
`python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py get
<path>`; repo checks against the files in `~/workspace/qwenpaw-deploy`.
Do NOT use instabox2. Do NOT touch `auth.json` or user chats. Do NOT
restart the container. Do NOT write any token/key anywhere — the Worker
tokens (`GROUPCHAT_TOKEN`, `ROUTINE_WEBHOOK_TOKEN`, `WAKE_TOKEN`,
`DESKTOP_*`, board key) are user-held and never appear below.

**Machine time matters:** the Free machine pauses after 30 min idle and
has a 480-min max run (current run ends ~07:41 IST 2026-11-15, then a
5–20 min cooldown). Before a round, check T43 (keep-alive status). If
it says `waking` / `cooldown` / `conflict`, machine tests are BLOCKED
(not failed) — wait and re-run.

## Methods

| Method | Meaning |
|---|---|
| `protocol` | Runnable now by `run-tests.py`: public curl, on-machine exec via `ib.py`, `cf.py` read, or a local repo/node check. No login, no user-held token. |
| `browser` | Needs a real logged-in browser (parent agent). The runner records it as NEEDS-BROWSER and never attempts it. |
| `needs-token` | Needs a user-held secret (console password, `GROUPCHAT_TOKEN`, board key, eval creds). The runner records it as NEEDS-TOKEN and never invents the value. |
| `KNOWN-GAP` | (A result, not a method.) The expected outcome is a documented gap, not a pass. Record the gap, do not file it as a failure. |
| `NEEDS-VERIFICATION` | (A result, not a method.) The check command itself is unproven. The test states the exact open question instead of guessing. |

## Test count

61 tests: **49 protocol, 8 browser, 4 needs-token.**
Areas: console 6, desktop 11, screenshot 1, bridge 3, mcp 3, routines 4,
groupchat 3, board 3, botpages 3, skills 2, mailbox 1, heartbeat 1,
approvals 3, fleet 1, evals 3, import-export 2, keepalive 3, harness 3,
lease 1, browser-only extras 4 (folded into the 8 browser tests above).

---

## (a) Console — Pages proxy → QwenPaw console

### T01 — Pages root serves the console SPA (+ side-panel injection)
- Area: `console` · Method: `protocol`
- Check: `curl -s -o /tmp/t01.html -w "%{http_code}" --max-time 60 https://qwenpawx.pages.dev/` then `grep -c "QwenPaw Console" /tmp/t01.html` and `grep -o "qwenpawComputerBtn\|qwenpawComputerPanel" /tmp/t01.html | sort -u`
- Expected: HTTP 200, HTML contains `<title>QwenPaw Console</title>` (SPA) AND the injected markers `qwenpawComputerBtn` + `qwenpawComputerPanel` (side-panel script, `pages/public/_worker.js` `consolePanelScript()`, 316px panel).
- Evidence: HTTP code, byte size, marker list. (Verified live 2026-11-15: 200, 40,447 B, both markers present.)
- Notes: a 503 here means the machine is waking (auto-refresh page) or in cooldown — see the header note, not a console bug.

### T02 — /status serves the status/wake page
- Area: `console` · Method: `protocol`
- Check: `curl -s -o /dev/null -w "%{http_code} %{size_download}\n" --max-time 60 https://qwenpawx.pages.dev/status`
- Expected: HTTP 200, `text/html`, title `QwenPaw — Status` (static asset `pages/public/status-page.html`, served by `_worker.js`, not proxied).
- Evidence: HTTP code + size. (Verified live: 200, 5,629 B.)

### T03 — /api/auth/status reports auth on with users
- Area: `console` · Method: `protocol`
- Check: `curl -s --max-time 60 https://qwenpawx.pages.dev/api/auth/status`
- Expected: HTTP 200, body exactly `{"enabled":true,"has_users":true}`.
- Evidence: full body. (Verified live 2026-11-15: exact match, 33 B.)

### T04 — /desktop without a cookie serves the gate page
- Area: `console` · Method: `protocol`
- Check: `curl -s -o /dev/null -w "%{http_code} %{size_download}\n" --max-time 60 https://qwenpawx.pages.dev/desktop`
- Expected: HTTP 200, gate page (`Opening the desktop…`, "Checking your QwenPaw login…", posts to `/desktop/__verify`); NOT a redirect to `/chat`, NOT the console SPA. Gate page source: `_worker.js` `gatePage()`.
- Evidence: HTTP code + size + first 200 chars. (Verified live: 200, 1,884 B.)

### T05 — /desktop/__lease is public read, per computer, holder agent when free
- Area: `console` · Method: `protocol`
- Check: `curl -s --max-time 30 "https://qwenpawx.pages.dev/desktop/__lease"` and `curl -s --max-time 30 "https://qwenpawx.pages.dev/desktop/__lease?computer=qa"`
- Expected: HTTP 200 both; default `{"holder":"agent","leaseId":null,"expiresAt":null,"fence":<n>,"generation":<n>}`, qa the same shape with its own `generation`. (`_worker.js` `desktopLeaseRead`, per-computer keys `lease:default` / `lease:qa`.)
- Evidence: both JSON bodies. (Verified live: default generation 19, qa generation 2, both holder agent.)

### T06 — /desktop/vendor/xterm.js serves the vendored terminal client
- Area: `console` · Method: `protocol`
- Check: `curl -s -o /dev/null -w "%{http_code} %{size_download} %{content_type}\n" --max-time 60 https://qwenpawx.pages.dev/desktop/vendor/xterm.js`
- Expected: HTTP 200, `text/javascript`, ~283 KB (xterm.js 5.3.0, `pages/public/vendor/xterm.js`, served from the ASSETS binding — `_worker.js` intercepts `/desktop/vendor/*` because the desktop router owns all of `/desktop/*`).
- Evidence: HTTP code + size + content-type. (Verified live: 200, 283,404 B.)

---

## (b) Desktop — Team :1 + Private :2, lease, terminal, teach, needs-you, preview

### T07 — websockify GET 200 + WS 101 on all five desktop ports (on-machine)
- Area: `desktop` · Method: `protocol`
- Check (via `ib.py exec`, one command): for each port in `6081 6082 6083 6084 6085`: `curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:$p/` and `curl -s -i -N --max-time 2 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" http://127.0.0.1:$p/websockify | head -n 1`
- Expected: every port GET `200` and WS `HTTP/1.1 101 Switching Protocols`. Ports: 6081 = :1 control, 6082 = :1 view-only, 6083 = terminal, 6084 = :2 view-only, 6085 = :2 control (services `features/desktop/desktop-novnc*.service`, `desktop-terminal-ws.service`).
- Evidence: per-port `GET <code> / WS <first line>`. (Verified live 2026-11-15: all 5 GET 200 + WS 101.)
- Notes: local-only check — the published `https://608N-….instabox.tech` URLs need the private-port token (user-held Worker secret), so the protocol check runs on the machine, not from this VM.

### T08 — all 17 desktop/MCP/bridge/terminal services active (on-machine)
- Area: `desktop` · Method: `protocol`
- Check (via `ib.py exec`): `systemctl is-active desktop-xvfb-qa desktop-dbus-qa desktop-wm-qa desktop-vnc-view desktop-novnc-view desktop-vnc-qa-view desktop-novnc-qa-view desktop-novnc-qa desktop-vnc-qa mcp-computer-use mcp-computer-use-qa desktop-terminal desktop-terminal-ws desktop-lease-watcher desktop-window-watch desktop-chromium camoufox-bridge`
- Expected: 17 lines, every one `active`. (Service files in `features/desktop/`; `camoufox-bridge` unit is the bridge service.)
- Evidence: the full 17-line output. (Verified live 2026-11-15: 17/17 active.)

### T09 — terminal WebSocket 101 + frame echo on 6083 (on-machine)
- Area: `desktop` · Method: `protocol`
- Check (via `ib.py exec`, Python stdlib only — `run-tests.py` embeds this script): raw TCP to `127.0.0.1:6083`, HTTP upgrade `GET /websockify`, then send one masked binary WS frame carrying a pty frame `[0x00][len u32be][b"echo hello-terminal\n"]` (frame protocol in `features/desktop/pty-server.py`: kind 0 = stdin, kind 1 = resize) and read until `hello-terminal` comes back.
- Expected: upgrade status `HTTP/1.1 101 Switching Protocols`, `echo_found: true`. (A TEXT frame is rejected by websockify — the xterm.js client sends binary frames, so binary is correct, not a bug.)
- Evidence: WS status line + echo_found + bytes read. (Verified live 2026-11-15: 101, echo found, 23 bytes.)
- Notes: this proves the pty path end-to-end. Whether the Terminal *tab* opens a shell in the browser is T52 (browser).

### T10 — MCP proxies answer SSE 200 (on-machine)
- Area: `mcp` · Method: `protocol`
- Check (via `ib.py exec`): `curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://172.18.0.1:8898/sse` and the same for `http://172.18.0.1:8897/sse`
- Expected: both `200`. (8898 = :1 computer-use proxy, `features/desktop/mcp-computer-use.service`; 8897 = :2 QA proxy, `mcp-computer-use-qa.service` + `qa-server.sh` wrapper, which is required because `mcp-proxy` spawns its server with a minimal env.)
- Evidence: both codes. (Verified live: 8898 → 200, 8897 → 200. WARNING: plain `curl` against an SSE endpoint never ends — always use `--max-time`; an earlier probe without a cap ate the whole 60 s exec budget.)

### T11 — MCP list_apps on 8898 shows ONLY the :1 display's apps (on-machine)
- Area: `mcp` · Method: `protocol`
- Check (via `ib.py exec`, Python stdlib MCP client — `run-tests.py` embeds it): GET `/sse` → read the `endpoint` event (`data: /messages/?session_id=…`), POST `initialize` + `notifications/initialized`, then `tools/list`, then `tools/call {"name":"list_apps","arguments":{}}`.
- Expected: server `open-computer-use 1.1.4`; tools exactly the 9 (`click drag get_app_state list_apps perform_secondary_action press_key scroll set_value type_text`); `list_apps` text lists `Chromium` (pid 104998 at verification time, window `Today's Puzzle Answers…`), `xfce4-panel`, `xfdesktop`, `xfwm4` — and NO :2-only process. `isError: False`.
- Evidence: server version, tool names, full `list_apps` text. (Verified live 2026-11-15.)
- Notes: the first probe of this client failed on a `\r\n\r\n` vs `\n\n` SSE terminator — the runner's client accepts both.

### T12 — MCP list_apps on 8897 shows ONLY the :2 display's apps (on-machine)
- Area: `mcp` · Method: `protocol`
- Check: same MCP client as T11, against port `8897`.
- Expected: server `open-computer-use 1.1.4`; same 9 tools; `list_apps` lists `Chromium` (pid 111374 at verification time, window `Daily Puzzle Answers, Solvers & Wordle Tools - Chromium`) and `xfwm4` ONLY — no `xfce4-panel`, no `xfdesktop`, no :1 Chromium pid. This is the proof that :2 is a real separate display with its own D-Bus/AT-SPI registry (`features/desktop/desktop-dbus-qa.service`, `qa-server.sh`).
- Evidence: full `list_apps` text. (Verified live 2026-11-15.)

### T13 — teach endpoints exist (protocol half)
- Area: `desktop` · Method: `protocol`
- Check: `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 -X POST -H 'Content-Type: application/json' -d '{}' https://qwenpawx.pages.dev/desktop/__teach` (cookie-gated → gate page) and `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 https://qwenpawx.pages.dev/desktop/__pending-skills` (sync-token gated → 401).
- Expected: `__teach` → HTTP 200 gate page (`Opening the desktop…`); `__pending-skills` → HTTP 401 `{"ok":false,"error":"unauthorized"}`. Both routes exist in `_worker.js` (`desktopTeach`, `desktopPendingSkills`); `__pending-skills/ack` is the same handler family. Full teach flow (record → draft → Save → skill in list) is T55 (browser).
- Evidence: both status codes + bodies. (Verified live 2026-11-15.)

### T14 — needs-you endpoints exist (protocol half)
- Area: `desktop` · Method: `protocol`
- Check: `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 -X POST -H 'Content-Type: application/json' -d '{}' https://qwenpawx.pages.dev/desktop/__needs-you` (sync-token gated → 401) and `curl -s -o /dev/null -w "%{http_code}\n" --max-time 30 https://qwenpawx.pages.dev/desktop/__needs-you` (cookie-gated GET → gate page 200).
- Expected: POST → 401 `{"ok":false,"error":"unauthorized"}`; GET → 200 gate page. Routes in `_worker.js` (`desktopNeedsYou`, `desktopNeedsYouResolve`); the bridge raises via `POST /needs-you` with `X-Desktop-Sync` (see T18 note — raising a real record needs the browser to resolve it, so the live raise/resolve cycle is T56, browser).
- Evidence: both status codes. (Verified live 2026-11-15.)

### T15 — side-panel injection present in the live SPA HTML and in _worker.js
- Area: `desktop` · Method: `protocol`
- Check: `curl -s --max-time 60 https://qwenpawx.pages.dev/ | grep -o "qwenpawComputerBtn\|qwenpawComputerPanel" | sort -u` and repo grep `grep -n "consolePanelScript\|316px\|<div id=\\"root\\"" pages/public/_worker.js`
- Expected: live HTML contains both `qwenpawComputerBtn` and `qwenpawComputerPanel`; `_worker.js` contains `consolePanelScript()` injecting before `</body>` only when the HTML has the `<div id="root"` SPA marker, a 316px panel, and a floating Computer button appended outside React's `#root`.
- Evidence: marker list from live HTML + matching `_worker.js` line numbers. (Verified live: both markers in the SPA; `_worker.js:222,232,258,272`.)
- Notes: this is the protocol half only — that the panel actually renders and opens beside chat is T51 (browser; harness-verified, NOT browser-verified at build time).

### T16 — screen generations + preview pipeline (watcher, KV, endpoints)
- Area: `desktop` · Method: `protocol`
- Check:
  1. Repo: `grep -n "PREVIEW_S =" features/desktop/lease-watcher.py` → `PREVIEW_S = 15`; `grep -n "PREVIEW_PNG" features/desktop/lease-watcher.py` → `/data/home/mcp-proxy/preview.png` + `preview-qa.png`.
  2. Machine (via `ib.py exec`): `stat -c '%n %Y %s' /data/home/mcp-proxy/preview.png /data/home/mcp-proxy/preview-qa.png; date +%s` — both files exist and mtime is < 120 s old (15 s cadence, 60 s KV TTL).
  3. Public: `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 -X POST https://qwenpawx.pages.dev/desktop/__preview-upload?computer=default` → 401 (sync-token gated, `desktopPreviewUpload`); `curl -s -o /dev/null -w "%{http_code}\n" --max-time 30 "https://qwenpawx.pages.dev/desktop/__preview?computer=default"` → 200 gate page (cookie-gated, `desktopPreview`).
- Expected: all three sub-checks pass; `__lease` generations are per-computer and non-zero after use (T05).
- Evidence: `PREVIEW_S` value, both mtimes + ages, both status codes. (Verified live 2026-11-15: PREVIEW_S=15; upload 401; preview gate 200. Preview PNG freshness is checked by the runner on the machine each round.)
- Notes: the QwenPaw chat itself cannot show the preview image without a console rebuild — the preview is shown in the /desktop needs-you banner and the injected side panel instead (honest limit, `features/desktop/README.md`).

### T17 — agent screenshot: mss in the container is 1920x1080 and matches host scrot
- Area: `screenshot` · Method: `protocol`
- Check (via `ib.py exec`):
  1. `docker exec -e DISPLAY=:1 qwenpaw python3 -c "import mss; m=mss.MSS(); print(m.monitors); s=m.shot(mon=1, output='/tmp/mss-test.png'); print('saved:', s)"` — NOTE: `-e DISPLAY=:1` is REQUIRED; a plain `docker exec` has no DISPLAY in its env (verified: `docker exec qwenpaw env` shows none) and mss fails in `_choose_impl`. Use `mss.MSS()`, not deprecated `mss.mss()`.
  2. `rm -f /tmp/mss-test.png /tmp/scrot-test.png /tmp/scrot-test_*.png; docker cp qwenpaw:/tmp/mss-test.png /tmp/mss-test.png; DISPLAY=:1 scrot /tmp/scrot-test.png; file /tmp/mss-test.png /tmp/scrot-test.png; stat -c '%s' /tmp/mss-test.png /tmp/scrot-test.png` — the `rm` is REQUIRED: scrot refuses to overwrite and silently writes `scrot-test_001.png` instead, leaving a STALE `/tmp/scrot-test.png` for the compare (Round 3 failed exactly this way: fresh mss 598 KB vs stale scrot 243 KB from Round 2).
  3. Compare with the stdlib PNG decoder in `run-tests.py` (`png_mean`): dimensions + mean luminance of both files.
- Expected: mss monitors `[{width:1920,height:1080}, {width:1920,height:1080, output:'VNC-0'}]`; both PNGs `1920 x 1080, 8-bit/color RGB`; both sizes > 100 KB and within 2x of each other; mean luminance within 15% (a bare/unmapped desktop and a Chromium window differ far more than that in size and mean). No eyeballing.
- Evidence: `file` output for both, both byte sizes, both mean-luminance values. (Verified live 2026-11-15: mss 1920x1080, 188,623 B, mean 161.66; scrot 1920x1080, 243,014 B, mean 161.66 — identical means.)
- Notes: if an agent screenshot ever comes back bare again, first check `xwininfo` map state of the Chromium window; if unmapped, re-open via the bridge — do not re-diagnose the capture path (`features/desktop/README.md`).

---

## Lease — KV write test

### T49 — lease take/release via KV write (computer=qa) — VERIFIED in Round 2
- Area: `lease` · Method: `protocol` — **the Cloudflare KV calls are VERIFIED (Rounds 2, 3, 4):** `cf.py put-raw` writes `lease:qa` with no URL-encoding of the `:` (the key works as-is), `cf.py delete` removes it, the lease appears in `__lease` as holder `user`, and the watcher mirrors it to the control file. The NEEDS-VERIFICATION fallback in the runner stays as a guard: if a future write call itself errors, it reports NEEDS-VERIFICATION (not FAIL) with the exact command + error.
- Check:
  1. `curl -s "https://qwenpawx.pages.dev/desktop/__lease?computer=qa"` → record `generation` + `fence` (expect holder `agent`).
  2. Write a qa lease to KV with `cf.py`: `python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py put-raw /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/storage/kv/namespaces/3eb38e6ebdce41f0a7ed744a99afee46/values/lease:qa /tmp/lease-qa.json application/json` where `/tmp/lease-qa.json` is `{"leaseId":"<fresh uuid>","holder":"user","grantedAt":<now ms>,"expiresAt":<now ms + 90000>,"fence":<fence+1>}` (shape copied from `_worker.js` `desktopTakeover`).
  3. Poll `GET /desktop/__lease?computer=qa` every 5 s up to 45 s → `holder:"user"` with that `leaseId`.
  4. Machine (via `ib.py exec`): `cat /run/user/1000/qa/instabox-control` → `human worker-lease <epoch>` (lease-watcher polls every 5 s, but its own __lease read can lag the test's read by up to ~60 s of KV eventual consistency — allow up to 90 s; Round 3 failed at 45 s and the watcher proved it wrote the file later via its "lease ended, control file cleared (qa)" log line).
  5. **Cleanup in a finally:** `cf.py delete /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/storage/kv/namespaces/3eb38e6ebdce41f0a7ed744a99afee46/values/lease:qa`, then poll `__lease?computer=qa` up to 90 s → holder `agent` again (KV stale reads can hold the old value ~60 s; the 30 s staleness bound in the watcher caps the agent's wait).
- Expected: holder flips agent → user → agent; control file appears while held and clears after. Generation is recorded only (a raw KV write does NOT bump it — only the Worker's `__takeover`/`__release` handlers do).
- Evidence: `__lease` JSON at each step, control-file content, delete result.
- **VERIFIED in Round 2 (2026-11-15):** `cf.py put-raw` / `cf.py delete` against the KV values endpoint for namespace `3eb38e6ebdce41f0a7ed744a99afee46` (DESKTOP_KV) work with the key `lease:qa` as-is — no URL-encoding of the `:` needed. The runner reports NEEDS-VERIFICATION only if a future write call itself errors (guard, not an open question). If the write succeeds but the lease never appears, that is a FAIL.
- Blast radius: while the qa lease is held (~1–2 min) the QA agent's MCP input tools are refused — that is the mechanism under test. Use computer=qa only, never `default`, for this test.

---

## (c) Agent screenshot — see T17 above (single test for this area)

## (d) Bridge /desktop-open + Camoufox

### T18 — bridge healthy
- Area: `bridge` · Method: `protocol`
- Check (via `ib.py exec`): `curl -s --max-time 5 http://127.0.0.1:8899/health`
- Expected: HTTP 200, JSON `{"ok":true,"browser_alive":true,...}`. (Binds `127.0.0.1:8899` + `172.18.0.1:8899`; every endpoint except `GET /health` needs `Authorization: Bearer $CAMOUFOX_BRIDGE_TOKEN`; never publish this port.)
- Evidence: full JSON. (Verified live: `{"ok": true, "browser_alive": true, "title": "", "url": "about:blank"}` — see T19 note.)

### T19 — Camoufox on x.com/0xsatwik (navigates the browser — state-changing test)
- Area: `bridge` · Method: `protocol`
- Check (via `ib.py exec` — token is read from the machine file INSIDE the shell and never printed, exactly the pattern in `features/camoufox/README.md`): `T=$(grep '^BRIDGE_TOKEN=' /data/home/camoufox/.env | cut -d= -f2-); curl -s --max-time 60 -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"url":"https://x.com/0xsatwik"}' http://127.0.0.1:8899/goto`
- Expected: HTTP 200, JSON with `url` containing `x.com/0xsatwik` and `title` containing `Satwik` (verified shape 2026-11-15: `https://x.com/0xsatwik` → 200, title `Satwik Samanta (@0xSatwik) / X`). X search still redirects to login — that is expected, not tested here.
- Evidence: `url` + `title` + HTTP status ONLY — never the token, never the full response if it ever echoed a credential (it does not).
- Notes: `/health` showed `about:blank` at verification time, so this test (re-)navigates as its own setup. That is intentional: the test asserts the end state, not the prior state.

### T20 — bridge /desktop-open opens a URL on the :1 desktop
- Area: `bridge` · Method: `protocol`
- Check (via `ib.py exec`, same token-from-env pattern as T19): `T=$(grep '^BRIDGE_TOKEN=' /data/home/camoufox/.env | cut -d= -f2-); curl -s --max-time 30 -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"url":"https://wordsolverx.com"}' http://127.0.0.1:8899/desktop-open`
- Expected: HTTP 200, JSON `{"ok":true,...}` (bridge `desktop_open` runs `DISPLAY=:1 chromium <url>` — new tab if Chromium is running; the live `bridge.py` is machine-only at `/data/home/camoufox/bridge/bridge.py`, the repo copy predates `desktop_open`).
- Evidence: full JSON (no token in it). (Verified shape 2026-11-15: `{"ok":true}` for wordsolverx.com + example.com as a second tab.)

---

## (e) Computer-use MCP — see T10, T11, T12 above (SSE + list_apps isolation)

## (f) Routines Worker

### T21 — routines Worker reachable, /api/status shows QwenPaw up
- Area: `routines` · Method: `protocol`
- Check: `curl -s --max-time 30 https://qwenpaw-routines.qwenpaw-rohan.workers.dev/` (HTML status page, 200) and `curl -s --max-time 30 https://qwenpaw-routines.qwenpaw-rohan.workers.dev/api/status`
- Expected: `/` → 200 `QwenPaw Routines` HTML; `/api/status` → 200 JSON with `qwenpaw.status:"up"`, `httpStatus:200`, and a `routines` list containing `daily-summary` (`Daily summary (07:00 IST)`). Source: `features/routines/worker/src/index.js`.
- Evidence: `/api/status` JSON (trimmed to worker + qwenpaw + routine ids). (Verified live: both 200; daily-summary present.)

### T22 — routines cron schedules present via the Cloudflare API
- Area: `routines` · Method: `protocol`
- Check: `python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py get /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/workers/scripts/qwenpaw-routines/schedules`
- Expected: `success:true`, `result.schedules` contains exactly `*/30 * * * *` (wake tick) and `30 1 * * *` (daily slot, 01:30 UTC = 07:00 Asia/Kolkata). The schedules are set via the API, not in `wrangler.toml` (deliberately — a redeploy must not drop them).
- Evidence: the two cron strings. (Verified live 2026-11-15: both present, created 2026-11-14T19:29:47Z.)

### T23 — POST /trigger without a token fails closed (401, NOT 202)
- Area: `routines` · Method: `protocol`
- Check: `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 -X POST -H 'Content-Type: application/json' -d '{"id":"daily-summary"}' https://qwenpaw-routines.qwenpaw-rohan.workers.dev/trigger`
- Expected: HTTP 401 `{"error":"unauthorized"}`. A 202 would mean an unauthenticated trigger was queued (the pre-audit bug, fixed 2026-11-15); a 503 would mean `ROUTINE_WEBHOOK_TOKEN` is unset. Either is a FAIL of this test's expectation — 401 is the only pass.
- Evidence: status + body. (Verified live: 401 `{"error":"unauthorized"}`.)

### T24 — routines /api/history shows recent cron ticks actually firing
- Area: `routines` · Method: `protocol`
- Check: `curl -s --max-time 30 https://qwenpaw-routines.qwenpaw-rohan.workers.dev/api/history`
- Expected: HTTP 200; `history` contains entries with `kind:"wake-tick"` + `cron:"*/30 * * * *"` and `kind:"daily-summary-slot"` + `cron:"30 1 * * *"` within the last 24 h, each with `qwenpaw:"up"`, `httpStatus:200`.
- Evidence: newest entry per kind (at/cron/qwenpaw/httpStatus). (Verified live: daily-summary-slot at 2026-11-15T01:30:27Z, qwenpaw up, 200.)

---

## (g) Group chat

### T25 — group chat Worker reachable, auth required
- Area: `groupchat` · Method: `protocol`
- Check: `curl -s --max-time 30 https://qwenpaw-groupchat.qwenpaw-rohan.workers.dev/`
- Expected: HTTP 200, JSON `{"service":"qwenpaw-groupchat","auth_required":true,"endpoints":[…"/thread"…]}`. Store is a SQLite-backed Durable Object (not KV — KV lost messages to eventual consistency, fixed 2026-11-15).
- Evidence: full JSON. (Verified live: 200, `auth_required:true`.)

### T26 — unauthenticated post to the thread fails closed (401)
- Area: `groupchat` · Method: `protocol`
- Check: `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 -X POST -H 'Content-Type: application/json' -d '{"author":"test","role":"user","text":"probe - should be rejected"}' https://qwenpaw-groupchat.qwenpaw-rohan.workers.dev/thread/message` and `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 https://qwenpaw-groupchat.qwenpaw-rohan.workers.dev/thread`
- Expected: both HTTP 401 `{"error":"unauthorized"}`. (Fail-closed: if `GROUPCHAT_TOKEN` were ever unset, every gated endpoint returns 401 instead of silently opening — audit fix RT-002.)
- Evidence: both statuses + bodies. (Verified live: both 401. No message was stored — the 401 happens before any write.)

### T59 — full group-chat post flow (token held by the user) — NEEDS-TOKEN
- Area: `groupchat` · Method: `needs-token`
- Check (coordinator/parent step, token never written down): with `GROUPCHAT_TOKEN`, `POST /thread/start {"topic":"…"}`, `POST /thread/message {"author":"…","role":"user","text":"…"}`, `GET /thread?since=N` — expect 200s, the message present in the thread, turn state advancing to the next agent.
- Expected: 200 throughout; no 401/409 unless it is genuinely not that agent's turn.
- Evidence: thread JSON (message + turn fields) — with the token redacted from every record.

---

## (h) Ticket board

### T27 — board reachable, /health ok
- Area: `board` · Method: `protocol`
- Check: `curl -s -o /dev/null -w "%{http_code}\n" --max-time 30 https://qwenpaw-board.qwenpaw-rohan.workers.dev/` and `curl -s --max-time 30 https://qwenpaw-board.qwenpaw-rohan.workers.dev/health`
- Expected: `/` → 200 `QwenPaw Ticket Board` HTML; `/health` → 200 `{"ok":true,"worker":"qwenpaw-board"}`. Source: `features/board/worker/src/index.js` (one KV key `tickets`).
- Evidence: both statuses + `/health` body. (Verified live: 200 + 200.)

### T28 — unauthenticated board API call fails closed (401)
- Area: `board` · Method: `protocol`
- Check: `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 https://qwenpaw-board.qwenpaw-rohan.workers.dev/api/tickets`
- Expected: HTTP 401 `{"error":"unauthorized — send the board key as ?key= or X-Board-Key header"}`. The HTML page itself is public by design; the API is not.
- Evidence: status + body. (Verified live: 401.)

### T60 — board CRUD with the user-held board key — NEEDS-TOKEN
- Area: `board` · Method: `needs-token`
- Check (coordinator/parent step, key never written down): `POST /api/tickets {"title":"test ticket …","priority":"low"}` → 201; `GET /api/tickets/:id` → 200; `PATCH /api/tickets/:id {"column":"doing"}` → 200; `POST /api/tickets/:id/comments {"text":"…"}` → 200; `POST /api/tickets/:id/mark-sent` → 200; `DELETE /api/tickets/:id` → 200 (delete the test ticket afterwards). Also verify the audit fixes: `%FF` id → 400, empty PATCH → 400, strict-boolean `follow_up`.
- Expected: the status codes above; the test ticket is gone at the end.
- Evidence: status per step + final `GET /api/tickets` not containing the test ticket.

---

## (i) Bot pages

### T29 — bot Pages root 200
- Area: `botpages` · Method: `protocol`
- Check: `curl -s -o /dev/null -w "%{http_code} %{size_download}\n" --max-time 30 https://qwenpaw-pages.pages.dev/`
- Expected: HTTP 200, sample page (`Hello from QwenPaw`). Project `qwenpaw-pages` (`features/botpages/README.md`).
- Evidence: code + size. (Verified live: 200, 1,293 B.)

### T30 — bot Pages /skills/ 200 (skill library)
- Area: `botpages` · Method: `protocol`
- Check: `curl -s -o /dev/null -w "%{http_code} %{size_download}\n" --max-time 30 https://qwenpaw-pages.pages.dev/skills/`
- Expected: HTTP 200, `QwenPaw Skill Library` HTML.
- Evidence: code + size. (Verified live: 200, 9,884 B.)

### T32 (see skills) — build-page skill enabled
- Covered by T32: `build-page` must appear as `✓ enabled` in `qwenpaw skills list`. Its SKILL.md is `features/botpages/build-page-SKILL.md`; deploy tool is `features/botpages/deploy-page.py`.

---

## (j) Skills

### T31 — all skills enabled (qwenpaw skills list)
- Area: `skills` · Method: `protocol`
- Check (via `ib.py exec`): `docker exec qwenpaw qwenpaw skills list`
- Expected: output ends `Showing: 19 of 19 skills, 19 enabled, 0 disabled` and every row shows `✓ enabled`. **Count correction:** the task brief said 18; the live list on 2026-11-15 07:03 IST is **19** (the 19th is builtin `QA_source_index`). The expected value in this catalogue is the live one (19); if a round shows 18, record which skill is missing/disabled rather than assuming the brief was right.
- Evidence: the `Showing:` line + full row list. (Verified live 2026-11-15.)
- Notes: the list reads the workspace registry (`working/workspaces/default/skills/`); a skill installed only to the pool (`skill_pool/`) is invisible until also installed to the workspace dir — see the teach-skill bug in `features/desktop/README.md`.

### T32 — delegate, github, build-page skills present and enabled
- Area: `skills` · Method: `protocol`
- Check: same `docker exec qwenpaw qwenpaw skills list` output as T31 (no second run needed — the runner parses one output for T31+T32).
- Expected: rows `delegate` (customized), `github` (customized, `features/integrations/github-SKILL.md`), `build-page` (customized) all `✓ enabled`.
- Evidence: the three rows. (Verified live 2026-11-15.)

---

## (k) Mailbox — KNOWN-GAP, not a failure

### T33 — mailbox skill present, Gmail MCP (qwenpawmail) NOT configured → KNOWN-GAP
- Area: `mailbox` · Method: `protocol` · Expected result: `KNOWN-GAP`
- Check (via `ib.py exec`):
  1. `docker exec qwenpaw qwenpaw skills list | grep mailbox` → row present, `✓ enabled`.
  2. `sudo python3 -c "import json; c=json.load(open('/data/home/qwenpaw/working/config.json')); print(c.get('mcp',{}).get('clients'))"` → expect only a disabled `anysearch` client (per `features/infra/README.md`).
  3. `grep -i "mailbox" /data/home/qwenpaw/working/qwenpaw.log | tail -n 3` → look for the `Skipping skill 'mailbox' … MCP server not configured: qwenpawmail` line (wording quoted from `features/infra/README.md`; the runner matches `mailbox` + `qwenpawmail` case-insensitively).
- Expected: (1) present; (2)+(3) confirm `qwenpawmail` is not configured. The skill is Gmail-only by design (China mailbox providers removed in the 2026-11-15 English fix) and its backend was never wired — that is the known gap, recorded here so no round ever files it as a new failure. It becomes a real test only after someone configures `qwenpawmail` (needs the user's Gmail MCP setup).
- Evidence: the mailbox row, the `mcp.clients` value, the matching log line (or "log line not found in current log" if the log rotated — then (2) alone carries the gap).

---

## (l) Heartbeat — record state, do NOT enable

### T34 — heartbeat config state readable (currently disabled)
- Area: `heartbeat` · Method: `protocol`
- Check (via `ib.py exec`): `sudo python3 -c "import json; c=json.load(open('/data/home/qwenpaw/working/config.json')); print(c.get('agents',{}).get('defaults',{}).get('heartbeat'))"`
- Expected: `{'enabled': False, 'every': '6h', 'target': 'main', 'timeoutSeconds': 300, 'activeHours': None}` — record the value, whatever it is. **Do NOT enable it in this test** — enabling needs user OK (`PUT /api/config/heartbeat` is the supported path; never hand-edit `config.json` while the container runs). If a round finds it enabled, record when/why it changed and re-check T24 (routines depend on the wake layer, heartbeat is a second layer).
- Evidence: the heartbeat dict. (Verified live 2026-11-15: disabled as above.)

---

## (m) Approvals

### T35 — agent.json approval_level is AUTO (default agent)
- Area: `approvals` · Method: `protocol`
- Check (via `ib.py exec`): `sudo python3 -c "import json; a=json.load(open('/data/home/qwenpaw/working/workspaces/default/agent.json')); print(a.get('approval_level'))"`
- Expected: `AUTO`. (Live value; `features/approvals/config-patch.md` proposes SMART but it is NOT applied — do not change it in this test. `approval_level` is an agent-profile setting, `config.json` `agents.running.approval_level` is a null proxy to the same value.)
- Evidence: the value. (Verified live: `AUTO`.)

### T36 — DriverCard policy effect is allow AND both cards parse as YAML
- Area: `approvals` · Method: `protocol`
- Check (via `ib.py exec`):
  1. `sudo grep -A3 'effect: allow' /data/home/qwenpaw/working/workspaces/default/drivers/mcp/computer-use.yaml` and the same for `.../QwenPaw_QA_Agent_0.2/drivers/mcp/computer-use.yaml` → each card has `default_effect: deny` + a rule with `effect: allow` for all tools (the 2026-11-15 approval fix, one word `ask` → `allow`; do NOT revert it).
  2. `docker exec qwenpaw python3 -c "import yaml; yaml.safe_load(open('/app/working/workspaces/default/drivers/mcp/computer-use.yaml')); yaml.safe_load(open('/app/working/workspaces/QwenPaw_QA_Agent_0.2/drivers/mcp/computer-use.yaml')); print('both cards parse')"` (container path `/app/working/…` is the same bind mount as `/data/home/qwenpaw/working/…`).
  3. Last `DriverCardError.*computer-use.yaml` line vs last `refreshed after card change` line in `qwenpaw.log` → expect the last refresh line to be AFTER the last error line (or no error at all). The log is append-only, so a bare `grep -c` would count historical errors forever: the Round 1 fix (2026-11-15 07:08 IST, description rewritten as a block scalar) left two old error lines in the log, and the watcher has refreshed successfully since. An error with no later refresh is a fresh parse failure and FAILS the test.
- Expected: both cards `effect: allow`, both parse cleanly, no `DriverCardError` for either card without a later successful refresh.
- Evidence: the two grep outputs, the parse line, last-error-line and last-refresh-line numbers.
- **Live defect found while writing this catalogue (2026-11-15):** the log tail at verification time contained `yaml.scanner.ScannerError: mapping values are not allowed here` and `DriverCardError: Failed to parse DriverCard YAML /app/working/workspaces/QwenPaw_QA_Agent_0.2/drivers/mcp/computer-use.yaml` (log lines ~2546–2577 of 2580). **Fixed in Round 1 (F27):** both cards rewritten with the description as a YAML block scalar; watcher refreshed 07:08:54/56 IST; zero new errors since. The check above (last-error vs last-refresh) is the correct regression test — it must not be weakened to "expect the error".

### T37 — approval-pending count does not grow after a read-only desktop tool call
- Area: `approvals` · Method: `protocol`
- Check (via `ib.py exec`, in order):
  1. `grep -c "Generic approval pending created" /data/home/qwenpaw/working/qwenpaw.log` → count A (pattern from `qwenpaw/app/approvals/service.py:301`; verified live — pending lines exist from 04:17–04:19 IST, the pre-fix era, e.g. `request_id=271d9cfc … name=driver:mcp:computer-us…`).
  2. Run the T11 MCP client `tools/call list_apps` (read-only desktop tool) against 8898.
  3. Same grep → count B.
- Expected: B == A (with `effect: allow`, a desktop tool call creates no approval request). If B > A, FAIL and record the new `request_id`(s) + tool names from the new lines.
- Evidence: A, B, and (if grown) the new lines.
- Notes: the log can also grow from the user's own chatting — if it grows with lines unrelated to the test's tool call, record that honestly instead of forcing a pass.

---

## (n) Fleet

### T38 — fleet.py runs read-only
- Area: `fleet` · Method: `protocol`
- Check (via `ib.py exec`): the runner base64-transfers the repo file `features/infra/scripts/fleet.py` to `/tmp/tp-fleet.py` on the machine (there is no repo copy on the machine) and runs `sudo python3 /tmp/tp-fleet.py list` (sudo is required — `config.json` is root-owned; see the script's docstring). `enable`/`schedule` are dry-run only by construction (`--dry-run` is a required flag) and are NOT run here.
- Expected: exit 0; output lists the live agents from `config.json`/`agent.json` (active_agent `default`, profiles `default` + `QwenPaw_QA_Agent_0.2`, active model line). No file is written.
- Evidence: exit code + agent list lines. (Script verified in-repo; first live run is Round 1.)
- Notes: `fleet.py` never writes `config.json`. Applying an enable/schedule change needs coordinator approval + a config edit (+ an unverified container restart) — out of scope for this test.

---

## (o) Evals

### T39 — eval cases valid + prompts v1 versioned (local repo check)
- Area: `evals` · Method: `protocol`
- Check (local, no machine): `python3 -c "import json; s=json.load(open('features/infra/evals/cases.json')); print(s['version'], s['prompt_version'], len(s['cases']), [c['id'] for c in s['cases']])"` and `ls features/infra/prompts/v1/`
- Expected: `cases.json` parses, `version:1`, `prompt_version:"prompts/v1"`, 5 cases (`identity-en`, `english-only`, `no-china-endpoint`, `timezone-awareness`, `destructive-refusal`); `prompts/v1/` contains `AGENTS.md HEARTBEAT.md PROFILE.md README.md SOUL.md`.
- Evidence: the printed line + file list. (Verified in-repo.)

### T40 — run-evals.py --dry-run passes (no login, no network)
- Area: `evals` · Method: `protocol`
- Check (local): `python3 features/infra/evals/run-evals.py --dry-run`
- Expected: exit 0; prints `DRY-RUN — no login, no QwenPaw calls.` + the 5 cases + the request envelope (`POST {BASE}/api/console/chat/task`, poll `GET …/task/{task_id}`).
- Evidence: exit code + first/last lines. (Runner verified in-repo; the script has never been run live.)

### T61 — evals live run — NEEDS-TOKEN
- Area: `evals` · Method: `needs-token`
- Check (coordinator/parent step, creds via safe env only, never stored): `QWENPAW_USER=satwik QWENPAW_PASS='…' python3 features/infra/evals/run-evals.py` (default base `https://qwenpawx.pages.dev`). Login once, one task per case, poll up to 6 min per case.
- Expected: per-case pass/fail/unverified from `cases.json` `expect_contains` (case-insensitive substring on the reply); 423 (locked) ends the run immediately — never retry a lockout.
- Evidence: the JSONL results dir (one line per case: id, task_id, status, reply excerpt ≤500 chars, duration). Raw task responses are saved for hand inspection.

---

## (p) Import/export

### T41 — workspace-export.py export + verify on a QA workspace copy (on-machine)
- Area: `import-export` · Method: `protocol`
- Check (via `ib.py exec`): the runner base64-transfers `features/infra/scripts/workspace-export.py` to `/tmp/tp-wsexport.py` and runs `sudo python3 /tmp/tp-wsexport.py export /data/home/qwenpaw/working/workspaces/QwenPaw_QA_Agent_0.2 /tmp/tp-qa-export.tgz` then `sudo python3 /tmp/tp-wsexport.py verify /tmp/tp-qa-export.tgz`
- Expected: export exit 0 (allowlist only — never chats, sessions, memory stores, or credentials; see the script header); verify exit 0 (manifest sha256 for every file).
- Evidence: exit codes + verify output. (Flow verified by the infra build on a copy of the live QA workspace; first runner run is Round 1.)

### T42 — hash-verified restore to a scratch dir, then cleanup (on-machine)
- Area: `import-export` · Method: `protocol`
- Check (via `ib.py exec`, continues T41): `sudo rm -rf /tmp/tp-qa-restore; sudo python3 /tmp/tp-wsexport.py import /tmp/tp-qa-export.tgz /tmp/tp-qa-restore` (fresh dest — never the live workspace), then `sudo sha256sum /data/home/qwenpaw/working/workspaces/QwenPaw_QA_Agent_0.2/agent.json /tmp/tp-qa-restore/agent.json` (hashes must match) and `ls /tmp/tp-qa-restore/` (contains `agent.json`, `SOUL.md`, `skills/`), then cleanup `rm -rf /tmp/tp-qa-restore /tmp/tp-qa-export.tgz /tmp/tp-wsexport.py /tmp/tp-fleet.py` (cleanup runs even if the import fails). The `rm -rf` first is REQUIRED: a previous round leaves `/tmp/tp-qa-restore` behind and the import tool refuses to overwrite by design (Round 3 failed exactly this way); the dir holds only this test's scratch output.
- Expected: import exit 0; the two `agent.json` sha256 match; restored dir has the expected files; scratch files are gone afterwards.
- Evidence: import exit code, both hashes, post-cleanup `ls` showing the scratch paths absent.
- Notes: import refuses to overwrite an existing workspace unless `--backup-dir` is given (existing dir is moved aside, never deleted) — the runner `rm -rf`s the scratch dest first so the import always starts fresh; this never touches a real workspace.

---

## (q) Keep-alive + proxy

### T43 — keep-alive /status is "up"
- Area: `keepalive` · Method: `protocol`
- Check: `curl -s --max-time 30 https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev/status`
- Expected: HTTP 200, JSON `status:"up"`, `httpStatus:200`, `consecutiveFailures:0`, `source` starting `cron:*/5 * * * *` (or `manual-ping` right after a T44). Worker source: `worker/src/index.js`; cron `*/5 * * * *` in `worker/wrangler.toml`.
- Evidence: the JSON. (Verified live: `up`, 200, 0 failures, source `cron:*/5 * * * *`.)

### T44 — keep-alive /ping (public wake path) answers 200 + up
- Area: `keepalive` · Method: `protocol`
- Check: `curl -s -w "\nHTTP %{http_code}\n" --max-time 60 https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev/ping`
- Expected: HTTP 200, JSON with `status:"up"` (or `"waking"` with `retryAfterSeconds` if the machine is genuinely booting — record that instead of failing). `/ping` is the public wake path (the status page and activity-feed Wake button use it, never `/wake`; `/wake` is `WAKE_TOKEN`-gated and is NOT tested here).
- Evidence: the JSON. (Verified live: 200, `up`, source `manual-ping`.)

### T45 — backup Pages project mirrors the console (root/status/auth)
- Area: `keepalive` · Method: `protocol`
- Check: `curl -s -o /dev/null -w "root %{http_code}\n" --max-time 60 https://qwenpaw-frontend.pages.dev/`; same for `/status` and `/api/auth/status` (expect the T03 body).
- Expected: root 200 (SPA), /status 200, /api/auth/status 200 `{"enabled":true,"has_users":true}` — same as the main project (T01–T03). Both projects share `_worker.js` and the same secrets; a drift between them is a deployment bug.
- Evidence: the three codes + auth body. (Main project verified live; backup project codes are checked each round — the two projects were last deployed together in the fix rounds.)

---

## (r) Browser-only tests (parent agent, real logged-in browser)

These are the checks no protocol call can do — they need the satwik login
in a real browser. The runner records them as NEEDS-BROWSER every round;
the parent runs them and pastes the outcome into RESULTS.md.

### T50 — /desktop/__status per computer, full (cookie-gated)
- Area: `desktop` · Method: `browser`
- Check: logged in as satwik → open `/desktop`, then in the browser console fetch `/desktop/__status?computer=default` and `?computer=qa`.
- Expected: each returns `desktop:"up"`, `screen:"live"` (RFB banner seen), `machine:"up"`, `lease.holder:"agent"` when free, and its own `generation`. A `desktop:"down"` with `machine:"up"` means the desktop/proxy path is broken (not the machine) — that is a FAIL, not "asleep" (the fix-round-2 lesson: only `waking`/`cooldown`/`conflict` from keep-alive may report `asleep`).
- Evidence: both JSON bodies.

### T51 — side-panel renders beside chat
- Area: `desktop` · Method: `browser`
- Check: logged in → open the console (`/`) → look for the floating `Computer` button (bottom-right) → click it.
- Expected: a ~316px panel opens beside the chat with the /desktop chrome inside; the console keeps working (chat loads, no JS errors breaking it). The panel state persists in sessionStorage; `Open full` links to `/desktop`.
- Evidence: screenshot/description of the panel open + console usable.

### T52 — /desktop overlay chrome: take/release, terminal shell
- Area: `desktop` · Method: `browser`
- Check: logged in → `/desktop` → wait for Live → Take control → use the desktop (click) → open the Terminal tab → Release control.
- Expected (all verified fixed in re-check 2, 2026-11-15 06:58 IST — re-confirm each round): exactly ONE `You have control` pill, and it clears completely on release (status back to `Live`); Terminal tab shows a real shell prompt (`user@instabox-qwenpaw:~$`) after taking control, no `Someone else is using this computer` error (the terminal shares the header lease); Wake (if needed) renders the desktop within ~3 min; no `Screen link expired` error; idle ~3 min does not falsely report Asleep. A brief `Connecting…` overlay on tab switch / take-release is a known transient, not a failure, unless it becomes a 502 or a dropped stream.
- Evidence: step-by-step pass/fail + timestamps.

### T53 — Team → Private switch renders the :2 desktop live
- Area: `desktop` · Method: `browser`
- Check: on `/desktop`, switch the mode select Team → Private.
- Expected: Private renders Live with a visibly different state from Team (different scroll / no Restore popup / `--no-sandbox` banner — the re-check-2 observations), no `Screen link expired`, no 502, no stale Team frame; switching back to Team also works. Side-panel status agrees with the desktop page.
- Evidence: description of both screens + any error text.

### T54 — "…" maintenance menu (key not set → honest 503)
- Area: `desktop` · Method: `browser`
- Check: logged in → `/desktop` → open the `…` menu → try Stop/Recover/Reset/Update.
- Expected: the endpoint returns 503 `instabox_api_key_unset` until `INSTABOX_API_KEY` is set as a Worker secret on both Pages projects (then redeploy). Recover/Reset/Update return 501 `unsupported` — the InstaBox desktop API has no such actions (only status/install/start/takeover/handback/stop), so those are honest stubs. **Do NOT invent the key.** If the key is ever set, this test's expectation changes to the real actions.
- Evidence: menu behavior + status codes shown.

### T55 — teach-by-showing end-to-end
- Area: `desktop` · Method: `browser`
- Check: logged in → `/desktop` → Take control → `Teach a task` → record a short demo (goal input, optional Sensitive on) → `Stop & draft skill` → fill the 8-field draft editor (Name / When to use / Inputs / Steps / How to check / What to return / Approval boundaries / Failure handling) → Save → check `qwenpaw skills list` (via a protocol re-run of T31) for the new skill → then disable + remove the test skill to leave no residue.
- Expected: Save returns ok; the skill appears in the list (name must equal the skill-pool directory name — the bug found in testing); Test copies the run prompt; Add to routine posts to the routines Worker (needs `ROUTINE_WEBHOOK_TOKEN` pasted once in the browser, stored only in localStorage).
- Evidence: skill name, list output before/after, cleanup confirmation.

### T56 — needs-you banner end-to-end
- Area: `desktop` · Method: `browser`
- Check: in a console chat, get the agent blocked (e.g. a step needing the user — sign-in, CAPTCHA, 2FA) so it raises needs-you (DriverCard instructs it to `curl POST http://172.18.0.1:8899/needs-you` with the bridge token, then wait); watch `/desktop` for the banner.
- Expected: banner appears under the header within ~10 s (poll interval) showing the agent text + a live preview image from `/desktop/__preview`; Skip / I'm done clears the record and toasts `Tell the agent in chat: 'skip that step' / 'done, continue'` (the Worker cannot message the agent directly — honest limit, stated in the UI).
- Evidence: banner screenshot/description + resolve action taken.

### T57 — agent screenshot in chat shows the Chromium window
- Area: `screenshot` · Method: `browser`
- Check: new console chat → `take a screenshot of the desktop`.
- Expected: zero approval prompts (DriverCard `allow`, T36), reply in ~seconds with a screenshot SHOWING the Chromium window with wordsolverx.com (the 04:23 IST browser proof). A bare desktop means the window went `IsUnMapped` — re-open via the bridge (T20) and re-test; do not re-diagnose the capture path (T17 covers it).
- Evidence: reply description (steps, time, what the screenshot shows).

---

## (s) Console login — NEEDS-TOKEN

### T58 — console login as satwik
- Area: `console` · Method: `needs-token`
- Check (coordinator/parent step, password via safe env only, never written down): log in at `https://qwenpawx.pages.dev` as `satwik` (the account username — verified in `working.secret/auth.json` on the machine; the `.env` admin password does NOT log in as satwik, 401 everywhere — see MEMORY.md 2026-11-15 correction).
- Expected: login succeeds, console loads, Default agent shows Running.
- Evidence: login outcome + console state. (Verified live 2026-11-15 01:04 IST.)

---

## Harness tests (local, no machine)

### T46 — desktop gate harness 116/116
- Area: `harness` · Method: `protocol`
- Check (local): `node features/desktop/harness-desktop-gate.mjs`
- Expected: `116 passed, 0 failed` (gate, verify, cookie, legacy redirect, lease grant/409/heartbeat-410, capability mint, session routing, shim injection, generation bump, tampered capability 403, `__status`, `__wake` throttle, `__action` 503, foreign redirect dropped, per-computer lease, needs-you, preview, teach, mode, terminal, side-panel, vendor, origin-auth cases; plus 40a-40j: KV-write failure to 503,
  probe protocol binary, cheap-probe 204, 4 s-late banner still live).
- Evidence: the final tally line. (Verified 2026-11-15 by AutoClaw: 116/116.)

### T47 — desktop chrome harness 34/34
- Area: `harness` · Method: `protocol`
- Check (local): `node features/desktop/harness-desktop-chrome.mjs`
- Expected: `34 passed, 0 failed` (DOM shim over the real chrome page: pill, terminal lease sharing, mode switch, wake timeout, Down/Auth-error states).
- Evidence: the final tally line. (Verified 2026-11-15 by AutoClaw: 34/34.)

### T48 — desktop origin harness 9/9
- Area: `harness` · Method: `protocol`
- Check (local): `node features/desktop/harness-desktop-origin.mjs`
- Expected: `9 passed, 0 failed` (real undici fetch vs 5 local mock proxy servers: per-port token/cookie, first-cookie-wins, 303 follow, `__status` down-vs-asleep).
- Evidence: the final tally line. (Verified 2026-11-15 by AutoClaw: 9/9.)

---

## (p) Preflight — run BEFORE any browser round

### P1 — preflight: machine, KV write budget, watcher throttle, services
- Area: `preflight` · Method: `protocol` (read-only script; run by Muse)
- Check: `python3 features/test-project/preflight.py --probe-write`
- Why: the 2026-11-15 11:27 browser round lost T52/T53/T56 to a spent
  Cloudflare KV write quota that **no protocol test could see** — reads all
  looked healthy while every write answered 500. This runs first so a browser
  session is never spent discovering that again.
- Expected: exit `0` and `CLEAR`. It checks (1) the machine is `up`, not
  `waking`/`cooldown`/`conflict`; (2) the KV write budget, via **one**
  scratch write + delete looking for Cloudflare error `10048`; (3) the live
  lease-watcher actually carries the change-only/throttle markers that
  bounded the burn; (4) the desktop services are active; (5) the gate and
  console answer.
- Exit `3` = BLOCKED with the reason (do not schedule a browser round).
  A run where the connectors are absent prints `INCOMPLETE` and exit `0` —
  a wrong-host run must not masquerade as a real block.
- Without `--probe-write` it performs **zero** writes; on a spent-quota day
  every probe write is one you cannot get back, so that is opt-in.
- Timing: the quota resets at midnight UTC = 05:30 IST.

---

## (m) Memory — Phase 4 (local + machine)

These four tests cover `features/memory/` (bounded recall, lessons ledger,
ReMe doctor). T62–T64 are local and dependency-free; T65 runs on the
machine and is read-only. **Upstream context:** QwenPaw v2.3.0 already
ships FTS5 history recall (`recall_history(op="search")` over
`conversation_history_fts`); these tests do NOT re-test that path — they
test the token budget, redaction, lessons workflow and ReMe diagnosis that
upstream does not provide. See `features/memory/README.md`.

### T62 — memory recall CLI: caps, redaction, read-only
- Area: `memory` · Method: `protocol`
- Check (local): `python3 features/memory/test_recall.py`
- Expected: `44 passed, 0 failed`. Builds a throwaway `history.db` with
  QwenPaw's **exact** v2.3.0 schema (external-content FTS5, porter unicode61)
  and asserts: ≤3 results by default, ≤2,000-token budget that a flag cannot
  raise, excerpt windows only (never a full session), GitHub/Slack/AWS/JWT/
  bearer/assignment redaction, tool-result rows excluded by default, the
  `recall_history` self-pollution guard, agent/since/kind filters, FTS5
  punctuation safety (`C++ foo-bar`), and that writes are denied while FTS5
  still works.
- Evidence: the final tally line.

### T63 — lessons ledger: candidates, caps, no auto-accept
- Area: `memory` · Method: `protocol`
- Check (local): `python3 features/memory/test_lessons.py`
- Expected: `45 passed, 0 failed`. Asserts: `propose` writes a **candidate
  only**; `accept` is separate and requires `--why`; ≤10 accepted / ≤3
  candidates / ≤800 words enforced; `L-001` ids never reused; accepted
  entries require Evidence; secret-shaped fields are **rejected** (file left
  byte-identical) rather than scrubbed; everything outside the
  `## Important Decisions and Lessons` section survives a rewrite verbatim.
- Evidence: the final tally line.

### T64 — ReMe doctor selftest: all five causes detected
- Area: `memory` · Method: `protocol`
- Check (local): `python3 features/memory/reme_doctor.py --selftest`
- Expected: `11 passed, 0 failed`. Synthetic workspaces prove the doctor
  detects each real gate: `interval_disabled`, `reme_not_started`,
  `reme_disabled`, `automation_only`, `below_interval`, `no_workspace`, plus
  the healthy case.
- Evidence: the final tally line.

### T65 — ReMe doctor live diagnosis (read-only, machine)
- Area: `memory` · Method: `protocol`
- Check: `ib.py exec` →
  `python3 /data/home/qwenpaw/working/memory-tools/reme_doctor.py
  --root /data/home/qwenpaw/working --agent default --json`
- Expected: the doctor reports `status=OK` or names the blocking cause
  code(s). **An empty `memory/` directory is not itself a failure** — v2.3.0
  scopes ReMe to `daily_dir`+`digest_dir` markdown by design, so "no notes"
  is only a bug when no cause explains it. Until `features/memory/` is synced
  to the machine this row is `NEEDS-VERIFICATION` (never a false PASS).
- Evidence: `status`, `causes`, per-directory `md_files`, `interval`.
- **Sync map (Muse):** `features/memory/*.py` →
  `/data/home/qwenpaw/working/memory-tools/`. Read-only; no restart, no write
  to `.env`/`auth.json`/chats.

---

## (r) Ripwire — optional code-map tool (local)

### T67 — Ripwire installer: safety invariants + skill honesty
- Area: `memory` · Method: `protocol`
- Check (local): `python3 features/memory/test_install_ripwire.py`
- Expected: `49 passed, 0 failed`. Static tier (always runs): `bash -n` clean,
  the x86-64-v3 feature check exists and accepts **`abm`** for lzcnt (a bare
  `lzcnt` grep is a false negative on Linux), the `/tmp` refusal exists, the
  sha256 sidecar is verified before unpacking, the binary is probed before
  install, the install is atomic, temp dirs are trapped and cleaned, the
  script never edits `docker-compose.yml` / restarts anything / touches
  `.env` or `auth.json` (checked against **code**, not comments), a `--check`
  mode changes nothing, the version is pinned, and no credential is embedded.
  Skill tier: frontmatter parses for QwenPaw, declares `RIPWIRE_BIN`, and the
  content is honest — it documents the unbudgeted `--for` token trap (~9.7K),
  the measured token table, that `--help-task` abstains in v0.6.10, the closed
  `--verify` grammar, and the fallback when the binary is missing.
- Live tier is **opt-in**: `RIPWIRE_TEST_INSTALL=1` performs a real download,
  checksum, install, idempotency re-run and a budgeted map query. The tally is
  49 either way, so an opt-out never looks like a failure.
- **Not covered here (Muse):** whether the *InstaBox* vCPU is x86-64-v3
  capable, and the container recreate needed to expose the binary. Run
  `bash features/memory/install-ripwire.sh --check` on the host — it refuses
  with the missing flags rather than installing a binary that would SIGILL.
- Evidence: the final tally line.

---

## (c) Code Mode — Phase 5 pilot (local, no deploy)

Covers `features/codemode/` — a bounded pilot that MEASURES Code Mode rather
than asserting it helps. See `features/codemode/README.md` and
`features/research/code-mode.md`.

### T66 — Code Mode pilot: benchmark maths + fail-closed auth
- Area: `codemode` · Method: `protocol`
- Check (local): `node features/codemode/harness-codemode.mjs`
- Expected: `59 passed, 0 failed`. Imports the **real** Worker
  (`features/codemode/worker/src/index.js`, the same bytes that get deployed)
  and drives it with mocked `env`: routing; `/health` binding state; the
  benchmark's internal arithmetic (per-turn × turns must equal the stated
  total, for both the best case and the retry case); that Code Mode actually
  reduces prompt tokens on the 10-step job while a **single** call is reported
  as worse; the visual-judgment caveat is present; `chars_per_token`
  validation; fail-closed auth (503 `token_unset` with no secret, 401 on a
  wrong header or query token, 405 on GET); that a missing loader/MCP URL
  yields an honest 503 naming both blockers and never claims a run; the
  audit trail; and that no token value leaks into the HTML.
- Evidence: the final tally line.
- **Not covered here (deploy-time, Muse):** whether `worker_loaders` exists on
  the free tier, whether the MCP SSE port is reachable from Cloudflare's edge,
  and real sandbox execution. `POST /api/run` returns 501 with the reason
  until both are established — that is by design, not a gap in the test.

---

## (k) Quota discipline — local, no deploy

These two exist because the free-tier quotas are the constraint that shapes
the whole architecture, and both had a real burn before they were fixed.

### T68 — keep-alive Worker: KV write-on-change + fail-closed /wake
- Area: `keepalive` · Method: `protocol`
- Check (local): `node worker/harness-keepalive.mjs`
- Expected: `19 passed, 0 failed`. Runs the real Worker with a mock KV and
  mock fetch. Asserts the write-on-change contract: the first tick writes
  (unknown → up), **nine further healthy ticks add zero writes**, a real
  transition writes exactly once, and recovery resets the failure counter.
  Also asserts `lastPingAt` is not persisted (it would defeat the guard) but
  is still returned to the caller; `/status` reads cached without writing;
  `/wake` fails closed with no token, 401s a wrong token, and never accepts
  the token in the query string; and a failed KV write still returns a live
  status rather than a false error.
- Evidence: the final tally line. The old Worker fails 2 of these.
- **Not covered:** real Cloudflare KV behaviour (mock only).

### T69 — lease-watcher: adaptive polling + safety invariants
- Area: `desktop` · Method: `protocol`
- Check (local): `python3 features/desktop/test_lease_watcher.py`
- Expected: `28 passed, 0 failed`. Asserts the cadence constants are
  coherent (idle 30 s ≤ the control file's own 30 s staleness bound, active
  5 s < 10 s, preview check < preview floor), that `main()` selects the
  interval from `lease_held` rather than a fixed sleep, and the quota
  arithmetic (idle ≤ 10,000 requests/day, ≥75% saved versus the old fixed
  5 s). Also pins the safety invariants that must not regress: the watcher
  only ever clears a control file it owns (`worker-lease`), a Worker outage
  leaves state unchanged (fail-open for the agent), previews never go to
  `/tmp`, uploads stay change-only, the sync token is never logged, and a
  browser User-Agent is sent because Cloudflare 403s python-urllib's default.
- Evidence: the final tally line.

---

## (d) Docs integrity — local

### T70 — every relative link and repo path resolves
- Area: `docs` · Method: `protocol`
- Check (local): `python3 scripts/check-links.py`
- Expected: `all links and paths resolve`, exit 0. Scans every markdown file
  for (a) relative markdown links and (b) backticked repo paths that
  start with a known top-level directory, and asserts each exists.
- Why it matters: a broken link in `AGENTS.md` sends a new agent to a file
  that does not exist. This check found **four real stale paths** left behind
  when the infra scripts moved into `features/infra/scripts/` — the docs still
  pointed at the old `scripts/` location, so anyone following them got
  "No such file".
- Excluded on purpose: `features/jev/awesome-jev-tools-full-list.md` is a
  verbatim copy of upstream READMEs, so its relative links resolve against
  github.com/<repo>, not our tree — checking them yields guaranteed false
  positives.
- Evidence: the summary line.

---

## (u) Routing + cost — local, no deploy

### T72 — content-aware routing: classify, abstain, bounded scan
- Area: `routing` · Method: `protocol`
- Check (local): `python3 features/routing/policy.py --selftest`
- Expected: `27 passed, 0 failed`. Asserts each route classifies its own
  vocabulary; that an empty input, an unmatched input, and a genuine tie all
  **abstain** with `route=None` (never a silently-substituted default); that
  `decide_with_default()` is the only place the default is applied; that a
  route needing tools is penalised when tools are absent; that a 36 KB prompt
  classifies in <50 ms (the scan is capped, it is a prefilter); that the same
  input always gives the same decision; and that a missing routes file
  degrades to "always abstain" rather than raising.
- Context: fills the seam in QwenPaw's `RoutingPolicy.decide()`, which
  ignores content entirely (verified in v2.3.0 source).
- Evidence: the final tally line.

### T71 — pricing resolver: honest UNKNOWN, optional catalogue
- Area: `cost` · Method: `protocol`
- Check (local): `python3 features/board/pricing.py --selftest`
- Expected: `20 passed, 0 failed`. Asserts a local override resolves with its
  source and `as_of`; cost arithmetic for input / output / cached / combined;
  per-provider overrides beat generic ones; an unknown model stays
  `resolved=false` with `cost() is None` (never 0); a **partial** price
  (input known, output unknown) also yields no cost, because a partial total
  is a wrong total; negative token counts raise; and the optional
  `genai-prices` dependency never raises whether it is installed, absent, or
  half-installed.
- Context: the dashboard showed UNKNOWN for GPT Astra. Verified that
  `genai-prices` 0.2.3 carries `gpt-6-astra` (450 provider entries), and that
  it needs Python >= 3.11 plus a deep dependency chain — hence optional.
- Evidence: the final tally line.

---

## Out of scope for this catalogue (do not add tests here without a new decision)

- **JEV / Drex** — not implemented (PLAN.md Phase 2/3). No tests until they land.
- **Ripwire / deja-vu** — deliberately not installed (Phase 4, see
  `features/memory/README.md` "Deliberately not done"). No tests until a
  decision to install lands.
- **Log-check option** (PLAN.md Phase 1: one place to see all logs with issue-finding) — a build item, not a test; T36/T37 cover the log greps this suite needs.
- **Mobile app** (Rakazo #16) and **15-language UI** (Rakazo #21) — explicitly excluded from the Rakazo build (English only).
- **Voice calls, bot email receive path, Spaces/Access enforcement** — blocked/partial items with external requirements (keys, a Cloudflare zone). Their blockers are recorded in `features/infra/README.md`; they get tests only when unblocked.
