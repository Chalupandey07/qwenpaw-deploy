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
- Expected: HTTP 200, HTML contains `<title>QwenPaw Console</title>` (SPA) AND the injected markers `qwenpawComputerBtn` + `qwenpawComputerPanel` (side-panel script, `pages/public/_worker.js` `consolePanelScript()`, 316px panel), the Vault button marker `qwenpawVaultBtn`, the Vault menu marker `data-qwenpaw-vault-menu`, the in-chat popup marker `data-qwenpaw-vault-popup`, the popup provider-select id `qwenpawVaultPopupProvider`, AND the /vault page (HTTP 200) contains the provider-select id `fProvider`.
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

### T04 — /computer/state refuses an anonymous caller (P0)
- Area: `console` · Method: `protocol`
- Check: `curl -s --max-time 60 "https://qwenpawx.pages.dev/computer/state?computer=default"`
- Expected: HTTP 401, body contains `auth_required`, and no state leaks (`"leaseId"`, `"generation"`, `"preview"` all absent). Before the 2026-11-16 P0 fix this answered 200 with the live mode, generation, lease holder and preview hash to anyone on the internet. HTTP 503 instead means the session secret is unset — a deploy error, not a pass.
- Evidence: HTTP code + body. (Verified live 2026-11-17: 401 auth_required, no leaked state.)
- Was `/desktop` gate page (deleted surface); rewritten in commit 1e30568.

### T05 — /computer/takeover and /computer/session refuse an anonymous caller
- Area: `console` · Method: `protocol`
- Check: `curl -s -X POST -H "Content-Type: application/json" -d '{"computer":"default"}' --max-time 30 https://qwenpawx.pages.dev/computer/takeover` and `curl -s --max-time 30 "https://qwenpawx.pages.dev/computer/session?computer=default"`
- Expected: takeover 401/405 with no `leaseId` (a 200 would be a stranger seizing the desktop); session 401/405 with no `"policy"` (a 200 would be a screen capability). Neither assertion touches the store when the gate works.
- Evidence: both HTTP codes + bodies. (Verified live 2026-11-17: both 401.)
- Was `/desktop/__lease` (deleted surface); rewritten in commit 1e30568.

### T06 — /vendor/xterm.js serves the vendored terminal client as JavaScript
- Area: `console` · Method: `protocol`
- Check: `curl -s -D - --max-time 60 https://qwenpawx.pages.dev/vendor/xterm.js`
- Expected: HTTP 200, Content-Type `application/javascript`, >100,000 bytes, contains `xterm`, and NOT the console SPA (no `<!doctype html>` at the start). The defect this guards (B-35) is specific and silent: an unrouted path fell through to the console proxy, which answered 200 `text/html` with 45,989 bytes of the SPA — a `<script src>` answered with HTML fails silently, so `window.Terminal` stayed undefined and the terminal pane was black while the session showed "connected".
- Evidence: HTTP code + content-type + size. (Verified live 2026-11-17: 200, application/javascript, 283,404 B.)
- Was `/desktop/vendor/xterm.js` (deleted surface); rewritten in commit 1e30568. Harness note: `http_get_meta` strips proxy CONNECT header blocks before parsing — without that, the Content-Type read is empty and T06 fails while the live file is fine (found 2026-11-17: reported size 283,836 = 283,404 real bytes + 432 bytes of real header text).

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
- Check (via `ib.py exec`, Python stdlib only — `run-tests.py` embeds this script): raw TCP to `127.0.0.1:6083`, HTTP upgrade `GET /websockify`, then send one masked binary WS frame carrying a pty frame `[0x00][len u32be][b"echo hello-terminal\n"]` (frame protocol in `features/desktop/pty-server.py` (removed 2026-11-15 → features/computer/README.md): kind 0 = stdin, kind 1 = resize) and read until `hello-terminal` comes back.
- Expected: upgrade status `HTTP/1.1 101 Switching Protocols`, `echo_found: true`. (A TEXT frame is rejected by websockify — the xterm.js client sends binary frames, so binary is correct, not a bug.)
- Evidence: WS status line + echo_found + bytes read. (Verified live 2026-11-15: 101, echo found, 23 bytes.)
- Notes: this proves the pty path end-to-end. Whether the Terminal *tab* opens a shell in the browser is T52 (browser).

### T10 — MCP proxies answer SSE 200 (on-machine)
- Area: `mcp` · Method: `protocol`
- Check (via `ib.py exec`): `curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://172.18.0.1:8898/sse` and the same for `http://172.18.0.1:8897/sse`
- Expected: both `200`. (8898 = :1 computer-use proxy, `features/desktop/mcp-computer-use.service` (removed 2026-11-15 → features/computer/README.md); 8897 = :2 QA proxy, `mcp-computer-use-qa.service` + `qa-server.sh` wrapper, which is required because `mcp-proxy` spawns its server with a minimal env.)
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
- Expected: server `open-computer-use 1.1.4`; same 9 tools; `list_apps` lists `Chromium` (pid 111374 at verification time, window `Daily Puzzle Answers, Solvers & Wordle Tools - Chromium`) and `xfwm4` ONLY — no `xfce4-panel`, no `xfdesktop`, no :1 Chromium pid. This is the proof that :2 is a real separate display with its own D-Bus/AT-SPI registry (`features/desktop/desktop-dbus-qa.service` (removed 2026-11-15 → features/computer/README.md), `qa-server.sh`).
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

### T16 — screen generations + preview pipeline (watcher, D1, endpoints)
- Area: `desktop` · Method: `protocol`
- Check:
  1. Repo: `grep -n "PREVIEW_MIN_S =" features/desktop/lease-watcher.py` → `PREVIEW_MIN_S = 120` (change-only uploads, 120 s floor — the old `PREVIEW_S = 15` unconditional cadence was the KV-burn cause; renamed in the 2026-11-15 storage pass).
  2. Machine (via `ib.py exec`): `stat -c '%n %Y %s' /data/home/mcp-proxy/preview.png /data/home/mcp-proxy/preview-qa.png; date +%s` — both files exist and mtime is < 120 s old (120 s floor). Previews are stored in D1 as raw BLOBs (`previews` table, one row per computer), not KV.
  3. Public: `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 -X POST https://qwenpawx.pages.dev/desktop/__preview-upload?computer=default` → 401 (sync-token gated, `desktopPreviewUpload`); `curl -s -o /dev/null -w "%{http_code}\n" --max-time 30 "https://qwenpawx.pages.dev/desktop/__preview?computer=default"` → 200 gate page (cookie-gated, `desktopPreview`).
- Expected: all three sub-checks pass; `__lease` generations are per-computer and non-zero after use (T05).
- Evidence: `PREVIEW_MIN_S` value, both mtimes + ages, both status codes. (Verified live 2026-11-15: PREVIEW_MIN_S=120; upload 401; preview gate 200. D1 previews rows: default 500,429 B, qa 707,640 B, updated 08:12 UTC. Preview PNG freshness is checked by the runner on the machine each round.)
- Notes: the QwenPaw chat itself cannot show the preview image without a console rebuild — the preview is shown in the /desktop needs-you banner and the injected side panel instead (honest limit, `features/desktop/README.md` (removed 2026-11-15 → features/computer/README.md)).

### T17 — agent screenshot: mss in the container is 1920x1080 and matches host scrot
- Area: `screenshot` · Method: `protocol`
- Check (via `ib.py exec`):
  1. `docker exec -e DISPLAY=:1 qwenpaw python3 -c "import mss; m=mss.MSS(); print(m.monitors); s=m.shot(mon=1, output='/tmp/mss-test.png'); print('saved:', s)"` — NOTE: `-e DISPLAY=:1` is REQUIRED; a plain `docker exec` has no DISPLAY in its env (verified: `docker exec qwenpaw env` shows none) and mss fails in `_choose_impl`. Use `mss.MSS()`, not deprecated `mss.mss()`.
  2. `rm -f /tmp/mss-test.png /tmp/scrot-test.png /tmp/scrot-test_*.png; docker cp qwenpaw:/tmp/mss-test.png /tmp/mss-test.png; DISPLAY=:1 scrot /tmp/scrot-test.png; file /tmp/mss-test.png /tmp/scrot-test.png; stat -c '%s' /tmp/mss-test.png /tmp/scrot-test.png` — the `rm` is REQUIRED: scrot refuses to overwrite and silently writes `scrot-test_001.png` instead, leaving a STALE `/tmp/scrot-test.png` for the compare (Round 3 failed exactly this way: fresh mss 598 KB vs stale scrot 243 KB from Round 2).
  3. Compare with the stdlib PNG decoder in `run-tests.py` (`png_mean`): dimensions + mean luminance of both files.
- Expected: mss monitors `[{width:1920,height:1080}, {width:1920,height:1080, output:'VNC-0'}]`; both PNGs `1920 x 1080, 8-bit/color RGB`; both sizes > 100 KB and within 2x of each other; mean luminance within 15% (a bare/unmapped desktop and a Chromium window differ far more than that in size and mean). No eyeballing.
- Evidence: `file` output for both, both byte sizes, both mean-luminance values. (Verified live 2026-11-15: mss 1920x1080, 188,623 B, mean 161.66; scrot 1920x1080, 243,014 B, mean 161.66 — identical means.)
- Notes: if an agent screenshot ever comes back bare again, first check `xwininfo` map state of the Chromium window; if unmapped, re-open via the bridge — do not re-diagnose the capture path (`features/desktop/README.md` (removed 2026-11-15 → features/computer/README.md)).

---

## Lease — D1 write test

### T49 — lease take/release via D1 write (computer=qa) — updated 2026-11-15 (was KV; KV writes are blocked account-wide, error 10048, and KV is only the fallback now)
- Area: `lease` · Method: `protocol` — **the D1 calls are the lease store since 2026-11-15:** the runner writes the lease row with a D1 query (`INSERT INTO leases ...` via `cf.py post /client/v4/accounts/.../d1/database/5f58a2f8-e4bb-45e5-8a94-4fc283b90871/query`), the lease appears in `__lease` as holder `user`, and the watcher mirrors it to the control file. The NEEDS-VERIFICATION fallback stays as a guard: if a future write call itself errors, it reports NEEDS-VERIFICATION (not FAIL) with the exact command + error.
- Check:
  1. `curl -s "https://qwenpawx.pages.dev/desktop/__lease?computer=qa"` → record `generation` + `fence` (expect holder `agent`).
  2. Write a qa lease to D1: `INSERT INTO leases (computer, lease_id, holder, granted_at, expires_at, fence) VALUES ('qa', '<fresh uuid>', 'user', <now ms>, <now ms + 90000>, <fence+1>)` (shape copied from `_worker.js` `desktopTakeover`).
  3. Poll `GET /desktop/__lease?computer=qa` every 5 s up to 30 s → `holder:"user"` with that `leaseId` (D1 reads are strongly consistent — no KV stale-read window).
  4. Machine (via `ib.py exec`): `cat /run/user/1000/qa/instabox-control` → `human worker-lease <epoch>` (lease-watcher polls `__lease` every 10 s; allow up to 90 s).
  5. **Cleanup in a finally:** `DELETE FROM leases WHERE computer = 'qa'`, then poll `__lease?computer=qa` up to 90 s → holder `agent` again.
- Expected: holder flips agent → user → agent; control file appears while held and clears after. Generation is recorded only (a raw D1 write does NOT bump it — only the Worker's `__takeover`/`__release` handlers do).
- Evidence: `__lease` JSON at each step, control-file content, delete result.
- **VERIFIED in Round 2 (2026-11-15, KV version):** the lease mechanism (holder flip + watcher mirror) was verified with the old KV write path. Round 5's KV write failed with error 10048 (budget spent) — that is what the D1 migration fixes. The runner reports NEEDS-VERIFICATION only if a future write call itself errors (guard, not an open question). If the write succeeds but the lease never appears, that is a FAIL.
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
- Check (via `ib.py exec` — token is read from the machine file INSIDE the shell and never printed, exactly the pattern in `features/camoufox/README.md` (removed 2026-11-15 → features/computer/README.md)): `T=$(grep '^BRIDGE_TOKEN=' /data/home/camoufox/.env | cut -d= -f2-); curl -s --max-time 60 -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"url":"https://x.com/0xsatwik"}' http://127.0.0.1:8899/goto`
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
- Expected: `/` → 200 `QwenPaw Ticket Board` HTML; `/health` → 200 `{"ok":true,"worker":"qwenpaw-board","store":"d1"}`. Source: `features/board/worker/src/index.js` — tickets live in D1 table `tickets` (one row per ticket) since the 2026-11-15 KV→D1 migration; KV is the fallback only.
- Evidence: both statuses + `/health` body. (Verified live: 200 + 200, store d1.)

### T28 — unauthenticated board API call fails closed (401)
- Area: `board` · Method: `protocol`
- Check: `curl -s -w "\nHTTP %{http_code}\n" --max-time 30 https://qwenpaw-board.qwenpaw-rohan.workers.dev/api/tickets`
- Expected: HTTP 401 `{"error":"unauthorized — send the board key as ?key= or X-Board-Key header"}`. The HTML page itself is public by design; the API is not.
- Evidence: status + body. (Verified live: 401.)

### T60 — board CRUD with the user-held board key, on D1 — NEEDS-TOKEN
- Area: `board` · Method: `needs-token`
- Check (coordinator/parent step, key never written down): `POST /api/tickets {"title":"test ticket …","priority":"low"}` → 201; `GET /api/tickets/:id` → 200; `PATCH /api/tickets/:id {"column":"doing"}` → 200; `POST /api/tickets/:id/comments {"text":"…"}` → 200; `POST /api/tickets/:id/mark-sent` → 200; `DELETE /api/tickets/:id` → 200 (delete the test ticket afterwards). Also verify the audit fixes: `%FF` id → 400, empty PATCH → 400, strict-boolean `follow_up`. While the ticket exists, verify the row in D1 directly: `SELECT COUNT(*) FROM tickets WHERE id='<id>'` → 1 with the same title — the proof storage is one row per ticket, not one KV value; after the delete it → 0.
- Expected: the status codes above; the test ticket is gone at the end; D1 row count matches.
- Evidence: status per step + final `GET /api/tickets` not containing the test ticket + D1 count.
- History: rewritten 2026-11-15 for the KV→D1 migration (was: all tickets in one KV value `tickets`). The keyed part still awaits the user-held board key.

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
- Expected: output ends `Showing: 20 of 20 skills, 20 enabled, 0 disabled` and every row shows `✓ enabled`. **Count correction:** the task brief said 18; the live list on 2026-11-15 07:03 IST was **19** (the 19th is builtin `QA_source_index`). The 20th is workspace skill `fxembed` (added 2026-11-16 10:10, not in the shared `skill_pool/`). The expected value in this catalogue is the live one (20); if a round shows a different count, record which skill is missing/disabled/added rather than assuming the brief was right.
- Evidence: the `Showing:` line + full row list. (Verified live 2026-11-17: 20 of 20, all enabled.)
- Notes: the list reads the workspace registry (`working/workspaces/default/skills/`); a skill installed only to the pool (`skill_pool/`) is invisible until also installed to the workspace dir — see the teach-skill bug in `features/desktop/README.md` (removed 2026-11-15 → features/computer/README.md).

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

### T62 — D1 store harness (leases, generations, previews, routines)
- Area: `storage` · Method: `protocol`
- Check: `node features/storage/harness-store.mjs` — the store module (`features/storage/store.js`) against a mock D1 backed by real SQLite: lease put/get/upsert/delete, generation upsert, per-computer needs-you isolation + legacy fallback, preview base64 round-trip + BLOB storage, teach-skill list/get/delete, modes/budget/meta/status, routines history diff-put + 50-cap prune, definitions replace, pending expiry on read + list, unknown-key meta fallback, KV fallback when USE_D1 is off / the binding is unbound, `get(key, "json")` parity.
- Expected: 38 passed, 0 failed.
- Evidence: the harness tally line.

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

### T46 — desktop gate harness 105/105
- Area: `harness` · Method: `protocol`
- Check (local): `node features/desktop/harness-desktop-gate.mjs`
- Expected: `105 passed, 0 failed` (gate, verify, cookie, legacy redirect, lease grant/409/heartbeat-410, capability mint, session routing, shim injection, generation bump, tampered capability 403, `__status`, `__wake` throttle, `__action` 503, foreign redirect dropped, per-computer lease, needs-you, preview, teach, mode, terminal, side-panel, vendor, origin-auth cases).
- Evidence: the final tally line. (Verified live 2026-11-15: 105/105.)

### T47 — desktop chrome harness 13/13
- Area: `harness` · Method: `protocol`
- Check (local): `node features/desktop/harness-desktop-chrome.mjs`
- Expected: `13 passed, 0 failed` (DOM shim over the real chrome page: pill, terminal lease sharing, mode switch, wake timeout, Down/Auth-error states).
- Evidence: the final tally line. (Verified live: 13/13.)

### T48 — desktop origin harness 9/9
- Area: `harness` · Method: `protocol`
- Check (local): `node features/desktop/harness-desktop-origin.mjs`
- Expected: `9 passed, 0 failed` (real undici fetch vs 5 local mock proxy servers: per-port token/cookie, first-cookie-wins, 303 follow, `__status` down-vs-asleep).
- Evidence: the final tally line. (Verified live: 9/9.)

### T63 — board rate limit: unauthenticated burst → 429 + Retry-After (Durable Object)
- Area: `board` · Method: `protocol`
- Check: the burst MUST run from a stable IP — the InstaBox machine (`ib.py exec`, egress `16.148.199.63`, stable). 35 sequential unauthenticated `POST /api/tickets` from the machine → expect the first 30 to be 401 and the rest 429 with a `Retry-After` header (the DO counts failed-auth attempts at 30/min/IP). The runner retries once if no 429 appears (a burst straddling a minute boundary splits the count).
- Expected: ≥1×429 within 35 requests; every non-429 is 401; no other status; the immediate follow-up request is 429 with `Retry-After` (seconds until the window resets, 1–60).
- Evidence: the code tally + the follow-up `retry-after` value. (Verified live 2026-11-15: 30×401 + 5×429, follow-up `retry-after: 44`.)
- Why the machine: the runner VM's egress IP rotates per connection (12 parallel curls → 12 distinct IPv6 / 5 distinct IPv4), so a burst from this VM never accumulates in one per-IP bucket — the same rotating-IP effect is also why the first in-memory limiter never fired. A real user (stable home IP) and the machine are both single-IP, so the cap bites for them. The DO is a singleton per id, so counts are exact regardless of Worker isolates.
- History: added 2026-11-15 with the KV→D1 board migration; fixes audit bug `board-no-rate-limit-auth`. The first (in-memory) limiter was proven dead live (90 unauth POSTs → 0×429) and replaced by the DO.

### T106 — vault: the model can USE a key but never SEE it (canary, gate, AAD, redaction)
- Area: `vault` · Method: `protocol`
- Check: `node features/vault/harness-vault.mjs` (63 checks). Drives the REAL Worker (`_worker.js` → vault router) against a D1 mock backed by real SQLite (the real `schema.sql`), with the upstream fetch stubbed. A fresh canary (random 32-hex) per run. Asserts: (a) anon list/put/request/export → 401; list returns metadata only (no canary, no base64/percent-encoded form, no ciphertext, no row id); an upstream that echoes the Authorization header AND leaks the token in plain text returns a body with `[redacted]` and no canary form — while the upstream really did receive the Bearer header; a wrong-origin request → 403 AND writes no use row AND never calls the upstream; reveal needs the session cookie AND the console bearer token (session alone → 401); export needs the broker token; validation (bad name/origin/header, reserved env var, `*_PROXY`, command via `/request` → 400/409). (b) Crypto unit checks via the real `crypto.js`: seal/open round-trip, wrong host/kind/item-id in the AAD → null (no transplant, no cross-type), tampered ciphertext → null, overlapping redaction forms merge into one marker, a short raw value is never a form. (c) Activity lists uses without values; remove deletes the item and its uses. (d) List-broker (2026-11-18): the agent's list path — broker token only (no token / wrong token → 401), metadata only (no canary, no ciphertext, no row id), and it writes NO use row.
- Expected: 63 passed, 0 failed.
- History: added 2026-11-17 with the vault build (Phase 1 + harness). The redeploy/restart half of property (c) is a live test, run by Muse at deploy time. List-broker added 2026-11-18 (fail-first 59/63, 63/63 after).

### T107 — vault broker: env-var injection + output scrubbing (selftest)
- Area: `vault` · Method: `protocol`
- Check: `python3 features/vault/vault-broker.py --selftest` (19 checks). Machine-free selftest of the broker and the shared `redact.py`. Asserts the per-kind redaction forms (bearer scheme variants, basic decoded user:pass + password alone), that a short raw value is never a form, that redaction replaces every occurrence, and that the streaming redactor hides a value split across chunks, and that the broker sends its own User-Agent (not Python-urllib's, which Cloudflare blocks with 1010). Also the GET `/list` endpoint (2026-11-18): served live on an ephemeral port with a test token — no token / wrong token → 401, correct token → 200 with metadata only, and `/health` still 200.
- Expected: 19 passed, 0 failed.
- History: added 2026-11-17 with the vault build (Phase 2). The live broker test (`/run` with a real command, `env | sort` proving `[redacted]`) is run by Muse at deploy time. `/list` added 2026-11-18 (fail-first 15/19, 19/19 after).

### T108 — sleep/wake: decide before probing; sleep only when idle (harness)
- Area: `sleepwake` · Method: `protocol`
- Check: `node features/sleepwake/harness-sleepwake.mjs` (47 checks). Drives the REAL keep-alive Worker (`worker/src/index.js`) with a mock D1 + mock fetch. Asserts: (a) nextRun — daily 07:00 IST (same-day + next-day), weekly Monday, every-30-min steps; bad cron / bad timezone throw (never a silent wrong time). (b) decideSleepWake (pure) — idle → sleep; unknown nextRoutineAt / stale reporter / recent visit / recent agent work / short uptime / manual rest / machine down / in-flight transition / woken <20 min ago → hold; routine due in 8 min + machine down → wake; routine due in 8 min + machine up → hold; routine due in 30 min → sleep (it will wake in time); overdue routine → wake (never sleep past a routine). (c) POST /report — valid token → 200 + stored; wrong/no token → 401; bad JSON → 400; REPORTER_TOKEN unset → 503. (d) GET /sleepwake/state — next routine is the 07:00 daily summary (source d1), reporter fresh, no secret leaks; no routines + no report → nextRoutineAt null (unknown, not Infinity). (e) The cron tick — idle → calls Pages /api/machine/sleep exactly once and does NOT probe the console, sleep state 'sleeping'; routine due → probes (wake) and does NOT suspend, state 'running'; sleeping + nothing due → no probe, no suspend; stale reporter → no suspend, probe (stay awake).
- Expected: 47 passed, 0 failed.
- History: added 2026-11-17 with the intelligent sleep/wake build. The live half (idle → the machine actually suspends; wake 5 min before the 07:00 daily summary; wake-on-visit shows progress) is run by Muse at deploy time.

### T109 — sleep/wake reporter: next native run + agent activity (selftest)
- Area: `sleepwake` · Method: `protocol`
- Check: `python3 features/sleepwake/reporter.py --selftest` (12 checks). Machine-free selftest of the reporter. Asserts the cron next-run (daily 07:00 IST same-day + next-day, weekly Monday, every-30-min steps), that a bad cron raises (never a silent wrong time), ISO parsing, the report shape (all four keys, uptimeSec is null — unknown, not invented), that the report is null for nextNativeRun when jobs.json is empty, and that the reporter sends its own User-Agent (Cloudflare blocks Python-urllib's default with 1010).
- Expected: 12 passed, 0 failed.
- History: added 2026-11-17 with the intelligent sleep/wake build. The live reporter (systemd timer, POST /report, the machine actually reporting agent activity) is run by Muse at deploy time.

### T110 — reset: the broker's HTTP surface (harness)
- Area: `reset` · Method: `protocol`
- Check: `node features/reset/harness-reset.mjs` (43 checks). Starts the REAL reset broker on 127.0.0.1 with `RESET_ROOT=<tmpdir>` over a fake tree (fake chats.json, a REAL sqlite history.db, screenshots, auth.json, .env, kilo.json, an escaping symlink to /etc). Asserts: (a) auth — anon/wrong token → 401 on preview and execute, unknown category → 400; (b) preview — 200, per-category bytes/files, plan_id stable across identical previews, changes after touching a file, zero categories → 200 with zero bytes, models excludes the active provider; (c) confirmation — execute without confirm/ack/plan_id → 400 and nothing deleted, stale plan_id → 409 plan_changed and nothing deleted, lowercase confirm → 400; (d) idempotency — same X-Request-Id returns the cached report and deletes nothing new, a re-run is ok with 0 bytes; (e) partial failure — a history.db that is a directory makes its db_clear fail, the category reports partial, the run is 207, and the other targets in the same category still run; (f) concurrency — two simultaneous executes, one succeeds, one gets 409 busy; (g) happy path — execute all safe categories, bytes_freed equals the preview exactly, and auth.json, .env, kilo.json, active_model.json, audit.db, reset.log and the escaping symlink all survive.
- Expected: 43 passed, 0 failed.
- History: added 2026-11-18 with the Settings Reset build. Three real bugs found by this harness, all fixed in the same commit: a keep-alive desync (a 401 returned without reading the body corrupted the next request on the connection, answered 501), a threading.Lock that serialized the flock so the second execute waited instead of getting 409, and a preview double-count of MEMORY.md when both memories and lessons were selected. The live half (preview with zero categories against the real machine, a rehearsal execute on a copy of the real tree, one real category live) is run by Muse at deploy time — see `features/reset/README.md`.

### T111 — reset broker: allowlist guard + category table (selftest)
- Area: `reset` · Method: `protocol`
- Check: `python3 features/reset/reset-broker.py --selftest` (20 checks). Machine-free selftest of the broker, the guard (`reset_guard.py`) and the category table (`reset_categories.py`). Asserts the guard rejects auth.json, .env, kilo.json, active_model.json and audit.db, rejects /etc/passwd and ../../etc/passwd escapes, rejects an escaping symlink and a path through it, allows a normal deletable path, and that the tree is byte-identical after all the rejections; and that the category table excludes the active provider from models, never lists active_model.json, excludes MEMORY.md and skill.json from workspaces, maps lessons to a section rewrite (not a delete), raises on an unknown category, and that lessons is superseded by memories.
- Expected: 20 passed, 0 failed.
- History: added 2026-11-18 with the Settings Reset build. The live half (the broker running under systemd with ProtectSystem=strict, the Pages /reset route, the UI confirmation flow) is run by Muse at deploy time — see `features/reset/README.md`.

### T112 — screen retry on failure (B-47, harness)
- Area: `computer` · Method: `protocol`
- Check: `node features/computer/harness-screen-retry.mjs` (17 checks). Static checks on the real `pages/public/computer/ui.html`: the message handler's `failed` branch calls `scheduleReconnect()` and still records the specific error first; `scheduleReconnect()` is single-flight (`reconnectTimer`) so the three iframes posting one failure cannot burn three budget units; the budget is enforced; the exhausted branch preserves a specific error instead of overwriting it with the generic "closed repeatedly" wording; the `connected` branch clears the pending timer. Dynamic checks: the real `scheduleReconnect` is extracted and run in a VM with mocks — three simultaneous calls schedule exactly one retry, firing it calls `loadScreen` once and frees the slot, a later failure schedules fresh, and at the budget no further retry is scheduled. Fail-first proven: against the unfixed `ui.html` it fails 9/17.
- Expected: 17 passed, 0 failed.
- History: added 2026-11-18 with the B-47 fix. The live half (leave the page open past 10 minutes, trigger a reconnect, confirm the error is gone) is run by Muse in a real browser — see `BUGS.md` B-47.

### T113 — routines daily-summary slot always probes (harness)
- Area: `routines` · Method: `protocol`
- Check: `node features/routines/harness-routines-slot.mjs` (9 checks). Replays the exact live instant from 2026-11-18 07:00:27 IST against the real routines worker module. Asserts: the daily-summary slot at 07:00:27 probes (machine up, HTTP 200, one fetch), its kind is daily-summary-slot; the wake-tick at the same instant still skips (zero fetches); a wake-tick 15 min before the routine still probes; a slot with no routines still skips (zero fetches). Fail-first proven: with the fix stashed it fails 3/9 and reproduces the exact live "skipped" entry.
- Expected: 9 passed, 0 failed.
- History: added 2026-11-18 with the daily-summary slot fix (B-47 follow-up). The live half (tomorrow's 07:00 slot must show the daily-summary slot probing, not "skipped") is verified by Muse from /api/history after deploy.

### T115 — loop-gate fix: tool-call budget counts once and applies by default (harness)
- Area: `loop-gate` · Method: `protocol`
- Check: `python3 features/loop-gate-fix/test_gate.py` (47 checks). Machine-free unit test for `ToolCallBudgetGate`: builds a minimal fake `qwenpaw` package (pristine `base.py` / `loop_gate.py`, a stub `agent_context`, and the `limits.py` under test) and drives the gate with fake agents whose context mimics the parent's merged-message behaviour (all of a turn's tool-call blocks in the message(s) carrying the current `reply_id`). Discriminating tests: A — merged message, total 50→100→150 across three rounds (not 50→150→300); E — a stale `last_iteration` still counts the round (not skipped). Workflow-bypass tests H — a `run_tool_batch` call with 50 shell steps counts 51 and fires (H1 file, H2 inline actions); 4 batches count 204 (H3, the live test that reached 200); a completed batch is counted from its result JSON when its call could not be expanded (H4, H8 `last_only` via `total`); a batch is never counted twice (H5: call + result = 51, not 101); the per-tool cap fires through a batch (H6); a small batch (3 steps) does NOT fire (H7, no false positive). Execution-time tests I — a single response with 200 direct shell calls executes 20 and refuses 180 (I1, per-tool cap); 25 shell + 175 web_search executes 30 and refuses 170 (I2, total cap after the shell cap); a 5-call run executes all 5 (I3, no false positive); the counter persists across rounds of one turn (I4: 25 + 5 = 30) and resets on a new turn (I5: 20 again); a batch of 50 steps is refused whole (I6 big) while a batch of 3 is allowed (I6 small); the gate's reason names the true total 200 and the refusal reason names the budget (I7). Regression tests: B — fires in round 0 when the first batch already exceeds `max_calls` 30 with the true total "(50 calls)"; C — per-tool cap fires on the true count; D — separate message per round (no merge) also totals 50→100; F — a previous turn's calls (different `reply_id`) are excluded; G — fallback when `reply_id` is missing still terminates via the old incremental counting. Fail-first proven: against `src/pristine/limits.py` it fails 29/47; against `src/gatefix1/limits.py` it fails 25/47 (H + I); against `src/gatefix2/limits.py` it fails 11/47 (only I — the live single-response burst, 200 executed); against `src/patched/limits.py` it passes 47/47. The default-chain wiring (`mode.py` + `config.py`) and the `react_agent.py` funnel change are not covered here (they need the full QwenPaw import chain) and are verified inside the derived image before deploy: the patched modules import, a `ToolCallBudgetGate` is present in `DefaultMode._build_gates`, and `try_reserve_execution` refuses past the budget.
- Expected: 47 passed, 0 failed.
- History: added 2026-11-18 with the loop-gate fix; extended the same day with the workflow-bypass fix (round 2) after the gatefix1 live test reached 200 echoes via 4 batches of 50; extended again the same day with execution-time enforcement (round 3) after the gatefix2 live test reached 200 echoes via 200 direct parallel calls in a single model response — the gate fired ("(200 calls)") but its TERMINATE is deferred, so all 200 executed. The live half (a real browser, fresh ordinary chat, no `/guarded`: echo 1–200 stops after ~20 executed calls — the per-tool shell cap, not 200 — with the true total in the stop message) is verified by Muse after deploy. The remaining gap is a batch whose steps cannot be read from its arguments (unreadable file): its sub-calls bypass `_execute_tool_call`, so up to one batch (~50) can execute before the gate's result-JSON fallback fires; see `features/loop-gate-fix/README.md`.

### T116 — tinyfish: Settings-based key + free search + fetch request-building, fallback when no key, Settings Search section (selftest + UI harness)
- Area: `tinyfish` · Method: `protocol`
- Check: `python3 features/tinyfish/test_tinyfish.py --selftest` (108 checks) + `node features/tinyfish/test_search_settings_ui.mjs` (27 checks). Machine-free selftest for the `tinyfish` skill's rules: the key is an env var (`TINYFISH_API_KEY`) set by the user in Console → Settings → Environments — NOT a vault item (the vault holds only connectors); the skill reads it from `os.environ` at runtime with python3 (stdlib urllib), so the key never appears in a command string, argv, or log, and it is deliberately NOT declared in `require_envs` (a skill whose declared env vars are unmet is skipped for the turn, which would break the fallback); builds the TinyFish search URL (root path on api.search.tinyfish.ai, the path the official SDK uses) and the fetch body (1–10 urls, markdown/html/json), the DuckDuckGo Instant Answer URL (the only DDG surface that works from this box — the HTML and lite endpoints are anomaly-blocked), the env-based fallback decision (key present → TinyFish, absent → built-in web_search/web_fetch exactly as now), the feature flags (`TINYFISH_SEARCH` / `TINYFISH_FETCH` / `TINYFISH_DDG_IA`, absent means on, the built-in is never a flag), and the error mapping (401/402/429/404/5xx). No network: it only builds requests and decides. The UI harness covers the Settings Search section (`pages/public/search-settings-ui.js`): PATCH /api/envs (never PUT), DELETE the key, password key field, key never rendered into the DOM, mount once after Environments, throttled self-mount on SPA navigation, and the `pages/public/_worker.js` wiring (asset route + script injection). Fail-first proven: the skill selftest fails 7/108 against the old vault-based SKILL.md, and the UI harness fails 2/27 before the `_worker.js` wiring lands.
- Expected: 108 passed, 0 failed (skill) + 27 passed, 0 failed (UI).
- History: added 2026-11-18 with the `tinyfish` skill (TinyFish free search + fetch, combined with DuckDuckGo Instant Answer; the user enters the key in the vault, and with no key normal search happens as now). Rewritten 2026-11-18 to the Settings-based key + the Settings Search section (user rule: the vault holds only connectors; keys for providers/services go in Settings). The live half (a real TinyFish search + fetch with a real key, settling the root-path vs `/free/...` question, and the Search section in a real browser) needs a key in Settings and is NOT verified here.

### T117 — memory facts: compact fact store + session handoff (selftest)
- Area: `memory` · Method: `protocol`
- Check: `python3 features/memory/test_facts.py --selftest` (41 checks). Machine-free selftest for the Mem0-style extract-and-retrieve store (`features/memory/facts.py`): extraction proposes the salient facts from a sample conversation (decision, preference, task, measurement, the TinyFish key rule) and skips trivia/tool noise; retrieval ranks the relevant fact first, runs in < 100 ms, costs <= 500 tokens for 5 facts and < 10% of the full history text; a handoff written by session A is read by session B with the open tasks + where A left off, in <= 300 tokens; adding the same fact twice returns the same id (add-only dedup); superseding marks the old row and never deletes it, and search excludes it by default; a fact containing a credential is rejected with no row written; universal search returns facts AND reaches back into history.db read-only through `recall.py`. Fail-first proven: the test fails with ModuleNotFoundError before `facts.py` exists.
- Expected: 41 passed, 0 failed.
- History: added 2026-11-18 with the memory system (Mem0 extract-and-retrieve, self-contained; no embeddings, no new provider). The live half (store created on the machine, a fact written and retrieved, a handoff written by one session and read by the next, with measured tokens and latency) is verified by Muse from the machine after sync. The agent-facing half (the `memory` skill driving handoff-read at session start and handoff-write at session end in a real browser) is verified by Muse after the skill is enabled.

### T118 — bloat win-win: Alibaba telemetry phone-home removed (harness)
- Area: `bloat-winwin` · Method: `protocol`
- Check: `python3 features/bloat-winwin/test_bloat_winwin.py` (26 checks). Machine-free test for the telemetry removal: the patch replaces `qwenpaw/utils/telemetry.py` and `qwenpaw/utils/daily_telemetry.py` with stubs that keep every public name the rest of the codebase imports, as safe no-ops, with no endpoint constant, no network code, no sender thread, and no disk writes. Asserts the stubs load standalone (stdlib-only), expose the same public names, never reference the telemetry endpoint or httpx, and never start a thread or write a file. Fail-first proven: against the pristine upstream files it fails 12/13 (1 passed) — the pristine files import `..__version__` / `..constant` / `httpx` relatively and cannot even load standalone.
- Expected: 26 passed, 0 failed.
- History: added 2026-11-18 with the bloat win-win (telemetry removal, deployed live as image qwenpaw-agentx:2.3.0-bloatwinwin1 built from gatefix3). The live half (telemetry endpoint hits 0, no telemetry thread, console 200, new log has zero telemetry mentions) is verified by Muse after deploy. Policy win: the forbidden China endpoint is gone from code, not just held off by an env var.

### T119 — bloat win-win data layer: VACUUM, WAL checkpoint, PNG, log rotate (harness)
- Area: `bloat-winwin` · Method: `protocol`
- Check: `python3 features/bloat-winwin/test_bloat_winwin_data.py` (15 checks). Machine-free test for the data-layer work done on the live machine 2026-11-18 with no source change. Runs against temporary test databases / files only; it never touches the live working tree. Asserts VACUUM preserves every row and the FTS index (and that a freelist-0 database barely shrinks, so the history file IS the history), WAL checkpointing reclaims the WAL, PRAGMA `journal_size_limit` is per-connection (a fresh connection reads −1, so it does not bound future WAL growth — a correction to DeepSeek's recommendation, verified on SQLite 3.45.1 and 3.46.1), PNG recompression is lossless (pixel-identical), and log rotation verifies the archive before truncating (a failed archive leaves the live log untouched). Fail-first proven: the test fails on a database with a non-zero freelist and on a rotation that truncates before verifying.
- Expected: 15 passed, 0 failed.
- History: added 2026-11-18 with the bloat win-win data layer (history.db VACUUM + WAL checkpoint, audit WAL checkpoint, screenshot lossless recompression, log rotation). Live measurements: history.db 980 rows preserved, FTS MATCH 'summary' = 13 before and after, ~8.9 MB reclaimed (both WALs ~8.3 MB + screenshots 0.56 MB + VACUUM 0.06 MB), recorded in `features/bloat-winwin/DATA_LAYER.md` — including the log-loss incident (the 1.39 MB qwenpaw.log was zeroed before its backup was verified; the rotation script now verifies the archive before truncating) and the `journal_size_limit` correction.

### T120 — memory facts v2: multi-signal retrieval, entities, time travel (selftest)
- Area: `memory` · Method: `protocol`
- Check: `python3 features/memory/test_facts_v2.py` (40 checks). Machine-free test for the v2 memory store (`features/memory/facts.py`): multi-signal retrieval (BM25 + entity overlap + importance, weighted reciprocal rank fusion) so a fact about the same project or person ranks up even when the keywords are thin; rule-based entity extraction (stdlib only, auto-populated on add, backfill-entities for older facts); temporal validity windows (valid_from / valid_to, search `--as-of DATE`). Asserts the entity boost, the RRF fusion, the temporal queries, and the v1 → v2 migration (schema 2, valid_from backfilled, no fact or handoff lost). Fail-first proven: against the v1 `facts.py` it fails with AttributeError (no `extract_entities`). Deliberately NOT added: semantic/vector search (needs an embedding model/key — a user decision), sleep-time consolidation, a graph DB.
- Expected: 40 passed, 0 failed.
- History: added 2026-11-18 with memory v2 (built from the trending landscape: Mem0 ~68K stars, Zep/Graphiti ~32K, Letta ~25K, Supermemory ~31K). The live half (live memory.db migrated v1 → v2, search returns fused_score + entity_overlap in 0.22 ms, `--as-of` works, 23/23 skills enabled) is verified by Muse after sync.

### T121 — mechanical checks: no China endpoints, no secrets, AGENTS.md budget, no polling (selftest)
- Area: `checks` · Method: `protocol`
- Check: `python3 features/test-project/test_checks.py` (14 checks). Machine-free test for the mechanical checks in `scripts/checks/` (`run-checks.sh`): proves, for each check, that it PASSES on the current repo and FAILS on a file that violates the rule (fail-first, using a temporary directory as the check's ROOT so the real repo is never touched). A ModelScope endpoint URL and a Function Compute host fail the China-endpoints check while bare provider names pass; a `ghp_` + 36-char key and an `AKIA` + 16-char key fail the secrets check while a short `ghp_` fragment passes; the AGENTS.md budget check fails at a 100-char cap and passes at 20000; a `setInterval` in `_worker.js` fails the polling check while the waking-page elapsed timer (the documented allowlist entry) passes. The violating strings are built from parts at runtime so this test file itself contains no China endpoint literal and no secret-shaped literal (the checks scan the repo, including this file). The checks enforce AGENTS.md §3 mechanically: a convention that lives only in prose gets violated within a week; a rule + a check survives.
- Expected: 14 passed, 0 failed.
- History: added 2026-11-18 with the mechanical checks (research top-10 gap #1: Rakazo, Claude Code, OpenClaw). The checks run on PR + before a push (AGENTS.md §5). There is no live half — the checks are a repo discipline, not a machine state.

### T122 — plan mode: read-only plan before any mutation (selftest)
- Area: `plan-mode` · Method: `protocol`
- Check: `python3 features/plan-mode/test_plan_mode.py --selftest` (43 checks). Machine-free test for the plan-mode enforcer (`features/plan-mode/plan_mode.py`): read-only calls allowed in plan mode; mutating calls (write/edit/delete, git commit, deploy, shell `>` / `rm` / `git push` / `curl -X POST`, unknown tool, `git_diff --output`, `web_fetch` POST) refused with the tool named; plan file written to `plans/<timestamp>.md` with all five required sections (steps, files, commands, expected diff, risks) and validating (duplicate step ids fail, two plans in the same second get distinct paths); execution before approval refused (`PlanNotApproved`, nothing ran); after approval only the plan's steps run, in order, at most once, with an approved step id bound to its tool and (for bash) its exact command; a corrupt state file loads as planning (fail closed). Fail-first proven: `--gate permissive` (no enforcer) fails 20 of 43 — mutations allowed, execution starts before approval, the plan executes three times.
- Expected: 43 passed, 0 failed.
- History: added 2026-11-18 with plan mode (research top-10 gap #2: OpenCode Plan agent, Claude Code `EnterPlanMode`, Gemini `EnterPlanMode` + `WriteTodos`). DeepSeek design review 2026-11-18 (10,469 tokens) found 12 findings; 9 fixed (shell denylist, step-id/tool/command binding, SHA-256-bound approval, at-most-once ledger, duplicate-id rejection, fail-closed corrupt state). The live half (agent loop calling `PlanMode.enforce()` before dispatch, `plan-mode` skill enabled) is verified by Muse after deploy.

### T123 — egress guard: untrusted-content wrapping + allowlist (selftest)
- Area: `egress-guard` · Method: `protocol`
- Check: `python3 features/egress-guard/test_egress_guard.py` (35 checks). Machine-free test for the egress guard (`features/egress-guard/egress_guard.py`): the wrapper marks fetched content as untrusted in a nonce-fenced `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` block with a Source line and strips forged chat-template tokens (`<|im_start|>`, `<|im_end|>`, `[INST]`, …) visibly; the allowlist guard DENIES a curl to a non-allowlisted host, DENIES a request carrying a vault-shaped string even to an allowlisted host, DENIES China hosts (DashScope / ModelScope / Alibaba OSS / any `.cn`, even if allowlisted), and ALLOWS legitimate requests to allowlisted LLM provider hosts; the redactor scrubs fake `ghp_` / `github_pat_` / `sk-` / `AKIA` strings from a log line while a commit SHA and a UUID survive. Fail-first proven: `--impl none` runs the same assertions against the pre-guard behaviour and fails 9 passed, 26 failed.
- Expected: 35 passed, 0 failed.
- History: added 2026-11-18 with gap #3 (research 2026-11-18, gap 4 in §2). The live half (wiring the guard into the TinyFish skill, `web_fetch`, and the broker `/run`, then a browser check against a poisoned page) is verified by Muse after sync.

### T124 — SMART approval patch + per-tool preview + Allow/Block list (selftest)
- Area: `approvals` · Method: `protocol`
- Check: `python3 features/approvals/test_approvals.py` (40 checks). Machine-free test for the SMART apply-script (exact agent.json change on a copy, idempotent, QA agent only if it has the field, destructive auto-deny verified read-only, config.json untouched), the preview builder (exact shell command, exact unified diff for file edits, never executes anything), and the Allow/Block enforcement (low-risk auto, medium ask, destructive deny, deny-listed tool refused under SMART and under OFF). Fail-first proven: against an empty approvals dir it fails 37/40 (2 vacuous passes); the first run against the real code failed 2/32 (E7/E8, list-over-level precedence bug, fixed). DeepSeek review 2026-11-18: 5 findings, all fixed, 8 regression checks (F1–F8).
- Expected: 40 passed, 0 failed.
- History: added 2026-11-18 finishing the 2026-11-15 SMART proposal as an apply-script. The live half (script run on the machine, approval_level SMART confirmed via running-config; preview/policy wired into the approval-card path in a derived image and checked in a real browser) is verified by Muse after sync/deploy.

### T125 — cost ledger with hard kill switch (harness)
- Area: `cost-ledger` · Method: `protocol`
- Check: `python3 features/cost-ledger/test_cost_ledger.py` (55 checks). Machine-free test for the token/cost ledger (`features/cost-ledger/cost_ledger.py`): ledger math on a hand-computed sample (350,000 prompt / 110,000 completion / 460,000 total / 23 calls / $0.57; today 210,000 tokens / $0.22 / 15 calls); 80% alert at exactly 80,000/100,000 tokens and not at 79,999; 100% hard stop refuses a simulated model call with the `Budget exhausted` denial (0 executions at 150%); raising the budget unblocks calls; reservations close the parallel-call race; cache tokens are never double-billed; unpriced models still bind via the token cap and priced partial sums keep the USD cap binding on mixed days; budget validation + atomic save; no network fetch (static checks); the derived-image patch dry-runs cleanly and reproduces the patched files byte-for-byte; CLI + reference /cost server (GET /cost, POST /cost/budget, POST /cost/reset). Fail-first proven: `--no-cap` fails 6/34 (the alert/denial checks) — a call at 150% of budget still goes through with no cap.
- Expected: 55 passed, 0 failed.
- History: added 2026-11-18 with the cost ledger (gap #5, research §2 gap 10). Derived image `qwenpaw-agentx:2.3.0-costledger1` (from `bloatwinwin1`, so loop-gate + telemetry removal survive) NOT yet built or deployed — the image build, machine deploy, and live browser verification are the parent's job.

### T126 — per-task cap + structured stop audit (harness)
- Area: `loop-gate` · Method: `protocol`
- Check: `python3 features/loop-gate-fix/test_task_cap.py` (61 checks). Machine-free unit test for the round-4 per-task cap: the same fake agent is reused across turns (context grows, reply_id changes). J — the live cross-turn shape (turn 1 spends 20 shell, turn 2 "hello" gets 20 more to task shell 40 = cap and finalises, turn 3 "hello" executes 0, a new instruction gets a fresh budget); K — sub-cap creep (25 web_search/turn, task cap 60 stops turn 3 after 10); L — the stop audit (6 records, all four kinds, fuse refused 180, finalised-resume refused 200 with task_total 40, append-only); M — explicit task id gets a fresh budget, re-issuing the capped instruction inherits the spent budget and executes 0; N — an unreadable batch's 50 sub-calls are charged to the task from the result JSON (task total 51) and the resume is refused; O — a batch that would jump the task cap from 55 to 66 is refused whole. Regression N1 — a 5-call run executes fully, is not finalised, writes no stops. Fail-first proven: against src/gatefix3/limits.py it fails 37/61 (turn 2 resumes with a fresh budget, turn 3 executes 20 more); against src/patched/limits.py it passes 61/61.
- Expected: 61 passed, 0 failed.
- History: added 2026-11-18 with the per-task cap (round 4) after the gatefix3 live test proved the per-turn cap works but the task resumed on "hello" and did 21-40. The live half (single-turn echo test, cross-turn "hello" test, new-instruction test) is verified by Muse after deploy — see features/loop-gate-fix/README.md.

### T127 — checkpoints + rollback: per-run workspace snapshot + safe restore (harness)
- Area: `checkpoints` · Method: `protocol`
- Check: `python3 features/checkpoints/test_checkpoints.py` (48 checks). Machine-free test for the per-run snapshot tool (`features/checkpoints/checkpoints.py`): tarball + JSON manifest (per-file sha256/size/mode, tarball sha256) tagged with the run ID, taken before the first mutation; a second snapshot with the same run ID is a first-wins no-op. Asserts the snapshot captures the files before mutation, restore returns the exact original bytes, restore REFUSES on drift without `--force` and leaves the workspace untouched, restore with `--force` proceeds and prints what will be lost, list shows run ID + timestamp + size, and the exclusion list keeps caches/logs/live DBs/session state/node_modules/media out of the snapshot and the tarball. Plus: the pre-restore safety snapshot makes a restore reversible, a corrupt tarball refuses to restore, an escaping symlink is skipped not followed, an invalid run id is rejected. Fail-first proven: against a stub with no implementation it fails 29/37 checks that run (8 pass vacuously — the negative checks). Deliberately NOT built: per-run branches as isolation for parallel subagents (needs per-agent workspaces first), and an automatic run-start hook (runs by convention until layered on the derived image).
- Expected: 48 passed, 0 failed.
- History: added 2026-11-18 with gap #7 (research §2 gap 3, §6 recommendation 7; Cline, Claude Code, OpenCode). Shadow-git verified absent from this repo — only `shadow.git` in `features/reset/reset_guard.py`'s protected-names list, which is upstream-only. The live half (snapshot + restore on the real workspace, list on the real store) is verified by Muse after sync.

### T128 — MCP client: stdio + streamable HTTP, allowlist, namespacing, egress (harness)
- Area: `mcp-client` · Method: `protocol`
- Check: `python3 features/mcp-client/test_mcp_client.py` (61 checks). Machine-free test for the MCP client (`features/mcp-client/mcp_client.py`): stdio + streamable HTTP transports (JSON-RPC 2.0, protocol 2025-03-26), servers disabled by default, per-server tool allowlist (default none, `*` rejected at load), namespaced tools `mcp.<server>.<tool>`, HTTP egress limited to declared hosts (redirects refused, env proxies ignored, private addresses refused unless declared loopback), no auto-install. Proves stdio connect/list/call, allowlist refusal naming server + tool with the mock's call log proving the call never arrived, disabled-by-default spawning no process, namespacing with two servers sharing a tool name, HTTP egress refusals with zero requests reaching the listener, and transport edge cases (timeout tears down, crash fails fast, 1 MB stderr no deadlock, colliding server ping answered, out-of-order replies correlated by id). Fail-first proven: 0 passed, 1 failed (ModuleNotFoundError) before `mcp_client.py` existed.
- Expected: 61 passed, 0 failed.
- History: added 2026-11-18 with gap #8 (research §2 gap 5: MCP is the canonical extension surface in Goose/Claude Code/Codex). Design reviewed by DeepSeek (deepseek-v4.1-flash-free, 1,111 prompt / 6,821 completion tokens) before implementation; review points adopted (method-first server-request dispatch, timeout poisons the connection, stderr draining, Mcp-Session-Id + 404 re-initialize, no redirects/proxies, mock-side positive proofs). The live half (a real MCP server connected, client wired into the agent loop through the registry) is verified by Muse after sync.

### T129 — skills as progressive-disclosure packages + self-written skills (harness)
- Area: `skills` · Method: `protocol`
- Check: `python3 features/skills/test_skills_packages.py` (46 checks). Machine-free test for gap #10: (a) a skill with valid frontmatter passes the scanner and appears in the index with only name/description/when-to-use/allowed-tools; (b) a skill missing frontmatter FAILS the scanner; (c) a skill invoking a tool outside its declared allowed-tools list is flagged by scope enforcement; (d) the self-written writer drafts a valid skill from a demonstrated task transcript (steps + checks + when-to-use present) and it passes the scanner, including a guidance-only draft (`allowed_tools: []`); (e) the writer REFUSES a draft that needs a secret or a China endpoint, or has unbounded scope; (f) the index builder loads only the index (no body text). Fail-first proven: 13 of the 46 checks fail against the pre-change scanner. DeepSeek design review 2026-11-18 (17,647 prompt + 5,361 completion tokens) caught six issues, all fixed: body-only scope (helper scripts now covered), backslash-continuation hole, unknown binaries in shell blocks, guidance-only refused, over-broad secret refusal, narrow vault mediation — plus three narrowed false positives (plain HTML TODO comment, `.env.example`, password-reset link).
- Expected: 46 passed, 0 failed.
- History: added 2026-11-18 with gap #10 (research top-10 gap #7 + #12: Claude Code, OpenClaw, Hermes Agent). The live half (converting the 20 pool-only skills, wiring the agent to load the index, first draft installed from the writer) is verified by Muse after deploy. No skill body was rewritten; the three repo skills (memory/tinyfish/vault) were NOT converted (their files belong to other features) — conversion is a follow-up with convert.py + human review.

### T130 — drex decision model: NACE endpoint configurable via env, decision_model slot fragment for both agents, live-test script fails closed without a key (harness)
- Area: `decisions` · Method: `protocol`
- Check: `python3 features/decisions/test_drex.py` (21 checks). Machine-free test for the Drex wiring: decide.py reads NACE_BASE_URL (arg > NACE_BASE_URL > default https://console.nace.ai, https-or-loopback only), per-provider scoping (a stray NACE_BASE_URL can never retarget Jev, which reads TYPESAFE_BASE_URL), decision_model_drex.json fragment {provider_id: nace, model: drex-max-v1.1} + endpoint block (base_url, path /v1/systemone, key_env NACE_API_KEY), apply script dry-run by default (writes both agents' agent.json only with --apply, timestamped backups, never touches approval_level, key-gated — fails closed exit 2 unless the key is in env/.env or --key-in-settings), live-test script fails closed without a key (exit 2). Fail-first proven: 8 passed / 12 failed (env override + fragment/scripts missing). T84 still 33/33.
- Expected: 21 passed, 0 failed.
- History: added 2026-11-18 with Drex wiring (research §2, Drex decision model; fork gogibeta/rakazo PR #8). NOT verified live: no real NACE call (no key yet); 'nace' provider registration in the deployed image unverified — if the image does not resolve provider_id "nace", the slot is inert and decide.py still needs a registry entry or a security/decision_model.py call path; calibration unverified (collect (probability, outcome) pairs + run decide.py calibrate() before trusting the 0.7 threshold).

### T131 — Telegram full-feature bot: token-only setup, menus, chats (selftest)
- Area: `telegram` · Method: `protocol`
- Check: `python3 features/telegram-full/test_telegram_full.py` (66 checks). Machine-free test for the Telegram integration (`features/telegram-full/tg.py` + `menu.py` + `SKILL.md` + `qwenpaw-telegram-menu.patch` + `Dockerfile`): token-only setup-check (token in the Settings store + safe flags `dm_policy: allowlist`, `access_control_dm: true`, `require_mention: true`; the bot is never enabled with the token alone and an open policy); owner = first entry of the telegram whitelist in `access_control.json` (computed fresh, no sidecar), guests get read-only branches and only their own Telegram session's chats, strangers are refused and nothing is called; new chat clears the pinned session; list + preview (last 10 messages only — a session file is 9.2 MB) + continue an existing console chat via `POST /api/console/chat/task` with polling (409 → already-running message); a settings change via a button callback (model PATCH validated against the Settings provider catalog, unknown model refused before any PATCH; approval PUT); the menu grammar (`ui:`/`act:`, ≤64 bytes, `tga:`/`tgd:` reserved, dots and slashes allowed so model names like `nex-n2.6` and `kilo-auto/free` parse) and the per-chat token cache (15-min TTL, 200-entry cap, token reuse); outbound redaction (bot-token shape + known provider keys + `sk-`/`xox-`/hex shapes) and vault reveal refused as console-only; inbound untrusted wrapping (forged `END_EXTERNAL_UNTRUSTED_CONTENT` marker broken before the egress-guard wrap, verified: `wrap_untrusted` alone does not neutralise an embedded END marker); and the driver patch applying cleanly to the pristine v2.3.0 `platform.py` (sha256-pinned) and reproducing `src/patched/platform.py` byte-for-byte, with the patched file routing menu callbacks (`/tgmenu` via `_handle_menu_callback`) and threading `reply_markup` through `_send_text`. Fail-first proven: the first run failed with `ModuleNotFoundError` (no modules yet); the pristine file has no menu routing. Bugs the test found and fixed: the callback regex excluded uppercase args (SMART/JEV), excluded dots/slashes in model names, and the busy-chat message missed the "already running" substring; the `patch -p1` invocation needed the plugin-dir layout.
- Expected: 66 passed, 0 failed.
- History: added 2026-11-18 with the Telegram integration (user 2026-11-18 ~14:45 IST: a bot that can do EVERYTHING the frontend can, token only in Settings, no numeric ID). DeepSeek design review 2026-11-18 (9,687 tokens) returned a design with 6 verified corrections (send_parts takes `route` not `chat_id`; `on_callback` takes a dict; `deny_message` is unused by the gate; model-switch reload needs no restart; the fenced ```ui block idea is invented; the owner sidecar is unnecessary). The live half (image `qwenpaw-agentx:2.3.0-telegram1` built on the machine — Docker images are 5 of 5, delete an old image first — skill enabled, token in Settings, pending flow, a real DM + model tap + chat continue + guest refusal) is verified by Muse after deploy. Honest limits: noVNC cannot be mirrored (status + Rest only), vault reveal is console-only, job run-now is console-only.

### T132 — Approval TTL: pending approvals + secret requests expire (selftest)
- Area: `approvals` · Method: `protocol`
- Check: `python3 features/approval-ttl/test_approval_ttl.py` (41 checks). Machine-free test for the port of gogibeta/rakazo PR #50 (F6) (`features/approval-ttl/ttl.py`): issue stamps `expires_at_ms` (approval 24h, secret 1h, question never), env overrides `APPROVAL_TTL_MS` / `SECRET_REQUEST_TTL_MS` with the fork's fallback rule (unparsable, 0, below the 1-second floor, or above the 30-day cap falls back to the default, so a bad value can never make approvals expire instantly), read is pure and fails closed (an expired card reads as denied with reason "timed out", `do_not_retry: True`, card copy "This approval expired" / "Expired"; boundary `now == expires_at` counts as expired; a legacy item without `ttl_version` never auto-denies; two reads write no audit row), answer refuses a late answer with `ExpiredError` ("This request expired before it was answered.") after persisting the expired terminal state + audit row (terminal state is sticky and checked before the clock, so a clock rollback cannot resurrect a card; a double answer never flips; legacy items stay answerable; a question carries nothing to answer), the sweep expires stale cards idempotently (never legacy, a post-migration card with no expiry fails closed, fork-shaped audit rows with actor `system`, outcome `denied`, decision `expired`, `via` sweep/answer, `age_ms`; a secret settles like a dismissal with `{ok: false, expired: true}` + the expired prompt), the store survives a reload (a restart cannot resurrect a stale card), a corrupt store raises `CorruptStoreError` (never a silent empty store), the file is mode 0600, `flock` serialises every read-modify-write (a lock holder blocks the sweep, which exits non-zero and leaves the store untouched), the audit is pruned to 1000 rows, and the CLI sweep/check/issue exit codes. Fail-first proven: 0/41 against an empty dir. DeepSeek design review 2026-11-18 (9,664 tokens): 6 findings, all fixed (the approve/deny endpoint as the single gate, flock + re-read inside the lock, sticky terminal state, pure read, legacy keyed on the missing `ttl_version`, env validated at issue time).
- Expected: 41 passed, 0 failed.
- History: added 2026-11-18 as all-20 todo #1 (research §2 gap #18; fork PR #50). Deliberate divergences from the fork: per-type TTLs (secrets 1h, approvals 24h) instead of one 24h value; a JSON file store with `flock` instead of a database column (QwenPaw's PendingApproval lives in container memory); `read()` pure instead of resolving on read. Known limits: standing grants (approve-with-scope `similar`, AUTO/SMART auto-approvals) carry no expiry and are immortal; the sweep resolves the file record + audit but cannot unblock a hung in-memory ASK call (only the in-process check can); the secret kind has no live consumer in QwenPaw yet (no pending secret queue). NOT verified live: the module is not synced to the machine, no sweep timer is installed, the derived-image wiring of the approve/deny handlers + `GET /api/approval/list` is not written, and no browser check exists yet (a card left unanswered past its TTL shows expired; a late approve is refused with 409).

### T133 — Ask-before-durable-write: high-stakes memory v2 facts need explicit accept (selftest)
- Area: `memory` · Method: `protocol`
- Check: `python3 features/memory/durable-write/test_durable_write.py` (114 checks). Machine-free test for all-20 gap #20 (`features/memory/durable-write/durable_write.py`): `gated_add()` is the single entry point — a rule-based classifier holds high-stakes facts in a `pending_facts` table inside the same `memory.db` (no row in `facts`, not searchable); routine facts write silently via `facts.add_fact` with provenance `gated:routine`. `propose / accept --id --why / reject --id --why / list / check` mirror the lessons.py API exactly, with its caps reused (max 3 pending, 400 chars per field, `--why` required, `PF-001` ids from AUTOINCREMENT, never reused). Accept flushes into memory v2 with provenance `pending:PF-001; accepted: <why>`; reject never lands. Secrets are rejected, not scrubbed — and never held (checked before any pending insert, re-checked at accept). A full pending store refuses the 4th fact loudly and never falls back to a routine write. High-stakes = kind `preference`, preference phrasing ("I prefer…", "Respond in metric units"), identity ("My name is…", "Call me…", timezone, contact handles, email, PII), credentials-adjacent mentions without a secret value ("My API key is stored in the vault", "We rotate tokens monthly"), durable language ("from now on", "Always use…"), and identity-field contradictions ("My name is Sam" vs stored "My name is Rohan"). Routine = measurements, plain observations, ordinary updates ("gate is 30" → "gate is 20"), and lookalikes ("I am running the migration", "Tests always use a temp dir", "Alice prefers dark mode"). Fail-first proven: fails at import on pristine code. DeepSeek design review changed the design in 4 places (classify on phrasing not just kind; narrow contradiction detection to identity fields only — a general rule false-positives on normal updates; leave `facts.py` untouched with a wrapper CLI instead of a lazy-import hook; pending table inside memory.db with accept-writes-fact-first ordering). Two real bugs caught by the test while building and fixed (credential nouns missed plurals like "tokens"; the contradiction check used dict-style row access on raw connections without a row factory). No regression: T117 41/41, T118 40/40, lessons 45/45 still green.
- Expected: 114 passed, 0 failed.
- History: added 2026-11-18 as all-20 todo #2 (research §2 gap #20; reuses the lessons.py propose/accept gate). Deliberately left alone: `facts.py` untouched (the wrapper is enough; zero regression risk, proven by T117/T118); no general contradiction detector (false-positives on routine updates); `kind="lesson"` not routed to the lessons ledger (different store, different purpose); no cap on accepted facts, no auto-supersede, no semantic judgement (no embedding model configured). NOT verified live: the module is not synced to the machine, no SKILL.md routing line yet (the gate is code-complete but not wired into the agent loop), and no live held-fact → accept → searchable round-trip (sync `durable_write.py` to `/data/home/qwenpaw/working/memory-tools/` alongside `facts.py`/`recall.py`, add the routing line, then live-check).

### T134 — Serving-model identity note: per-attempt note + {from,to,reason} switch log (selftest)
- Area: `model-identity` · Method: `protocol`
- Check: `python3 features/model-identity/test_model_identity.py` (48 checks). Machine-free test for all-20 gap #17 (`features/model-identity/model_identity.py` + `qwenpaw-model-identity.patch`, a port of fork PR #37/#44). Part 1 — discrepancy verdict, derived from the repo files by `discrepancy_verdict()` (not hardcoded): the correct source of truth as of the last repo evidence (2026-11-15) is `mosicn/nex-n2.6`; the `xingchiapi/gpt-6-astra` value in `features/board/config-patch.md` §2 is a stale same-day snapshot (true ~01:34 IST, superseded ~02:22 IST when the user switched to mosicn after two Astra stream stalls; corroborated by `cost-data.json` 02:46 IST, the audit retest 02:50 IST, the handoff, and repeated T38 fleet runs). The per-agent rule still holds (both agents' `active_model: null`, so the global file governs). The phrase "no active chat model configured" does exist in the repo (`features/memory/reme_doctor.py:289`) but is a conditional diagnostic string, not a live-state claim. Part 2 — the identity note is stamped per attempt at the dispatch boundary, `TokenRecordingModelWrapper.__call__`, onto a copy of the messages (never mutates the live transcript, exactly one note, never stacks); wording follows #44 (plain when serving == configured, "unavailable (reason_kind)" only with the fallback engine's recorded reason, neutral otherwise, same-model-another-key stays plain). `PATCH /api/agents/{agentId}/model-settings` gains an optional `reason` field (popped before applying, never stored on the config) and appends `{from, to, reason}` to `<workspace>/model-switch-log.jsonl` — effective from/to (per-agent else global file), no-change switches log nothing, log failures can never fail an applied switch. Fail-first proven: `ModuleNotFoundError` before the module existed. The patch applies cleanly `-p1` and `-p2` and reproduces the patched files byte-for-byte, and also applies onto cost-ledger's already-patched `model_wrapper.py` (both features coexist, stamp runs first so the budget check measures the stamped messages). DeepSeek design review changed the design twice (sink events are matched, never popped; the `before` capture moved inside the lock-held mutator). Also touched: `scripts/checks/check-no-secrets.sh` — allowlist entry only, because the upstream `agents.py` copies contain `_ALLOWED_MAIL_DOMAINS` (`qiye.aliyun.com` beside gmail.com/qq.com; inert mail-domain data, not an endpoint; the patch does not touch those lines).
- Expected: 48 passed, 0 failed.
- History: added 2026-11-18 as all-20 todo #3 (research §2 gap #17; fork PR #37/#44). Deliberately left alone: the preparation-time budget reserve inside the compaction manager (needs compaction-source work + machine) — shipped `estimate_note_tokens()` + a short fixed note + stamp-first ordering instead; `generate_structured_output` (no chat system prompt), the `llm_routing` path (disabled in this deploy, unreachable), per-message UI provenance (the fork deliberately excluded it), and subagent scope differs from the fork (QwenPaw stamps subagent/compaction calls too — still true information, disclosed in the README). NOT verified live: a live re-read of `working.secret/providers/active_model.json` (may have changed since 2026-11-15); the image build (base `costledger1`, tag `modelidentity1`) — if the image chain is re-based (e.g. onto gatefix4), re-verify the patch against the new base first, since `model_wrapper.py` is shared with the cost ledger; a browser check that the note never leaks into stored messages and the agent answers "which model are you?" with `mosicn/nex-n2.6`; a live PATCH switch (with/without `reason`) writing one log line, a no-change PATCH writing none; the first real fallback as the live failover test (do not force a failure).

### T135 — Bot-built Pages 2nd gen: routine refresh loop + publish allowlist (selftest)
- Area: `botpages` · Method: `protocol`
- Check: `python3 features/botpages/routine-loop/test_routine_loop.py` (25 checks). Machine-free test for all-20 gap #15 (`features/botpages/routine-loop/routine-refresh.py`, on top of the shipped build-page skill, qwenpaw-pages, and `deploy-page.py`): the loop — routine fires → re-read `<state-dir>/<slug>.json` → validate → pure-render `<pages>/<slug>/index.html` → redeploy the whole pages dir via `deploy-page.py`. Pure render / no drift: `render_page()` is a pure function of allowlisted state (no wall clock, no filesystem reads, sorted keys, all values HTML-escaped); a hand edit is overwritten on the next run. Idempotent: unchanged state → a byte-identical file, and the deploy is skipped too (a full-snapshot deploy per tick would waste Cloudflare API calls); the freshness line uses the state's own `updated_at`, not run wall-clock — a run-time stamp would break idempotency. The page says: "Last updated: … This page is a snapshot refreshed by a routine run, not a live view." Deploy failure: atomic write (dot-prefixed temp in the same dir, byte-verified, `os.replace()` — never truncate-in-place), then deploy with the exit code checked; failure = no new deployment (`deploy-page.py` creates one only as its final step), so the live page stays the last good one; failure recorded in `<state-dir>/<slug>.failures.jsonl` with slug + exit code; a `deploy_failed` status makes the next run retry the deploy instead of concluding "unchanged". Publish allowlist (fail-closed): unknown slug, unlisted state key, missing `title`/`updated_at`, non-scalar value, secret-shaped value (`ghp_`/`github_pat_`/`sk-`/`AKIA…`), or a value naming `working.secret`/`history.db`/`auth.json` → nonzero exit, page untouched, failure recorded. State, failure log, status, and lock live OUTSIDE the pages tree — a `state.json` under `pages/` would itself be published (`.json` is an allowed ext in `collect()`); check 21 proves it with the real `deploy-page.py` `collect()` over the pages dir. A lock serialises render→deploy so two slugs can't race a snapshot deploy. No sharing/private-link model (Pages URLs are already public; that needs an auth layer, out of scope). Fail-first proven: the same test against an empty stub → 0 passed, 25 failed, exit 1. DeepSeek design review (988 prompt / 5,337 completion tokens): its two substantive findings were verified against the real source and built in (state-outside-pages-tree; freshness-vs-idempotency trade-off); its lock and deploy-atomicity points are also implemented and tested.
- Expected: 25 passed, 0 failed.
- History: added 2026-11-18 as all-20 todo #4 (research §2 gap #15). Deliberately left alone: the sharing/private-link model (needs an auth layer, out of scope); `deploy-page.py`, the build-page skill, and the routines Worker are untouched (the loop calls the shipped deploy script as a subprocess); live-push freshness is impossible on static Pages, and the page states it is a snapshot. NOT verified live: a real routine firing the loop, a real `deploy-page.py` run from the loop, the refreshed page served at `qwenpaw-pages.pages.dev/<slug>/`, or the allowlist against real workspace state. The README includes the native cron-job wiring for when the machine is back.

### T136 — Eval harness, LLM judge: judge.py + versioned rubric + calibration set (selftest)
- Area: `evals` · Method: `protocol`
- Check: `python3 features/infra/evals/test_judge.py` (44 checks). Machine-free test for all-20 gap #13 (`features/infra/evals/judge.py` + `features/infra/evals/rubrics/v1.md` + `features/infra/evals/judge/calibration.json`): `judge_reply(reply, rubric, task, *, transport=None, case_id=None)` → verdict dict `{pass, reason, evidence, qualified, error_kind, rubric_version, rubric_sha256, judge_prompt_version, model, reply_truncated}`. Also `parse_verdict`, `build_judge_prompt`, `grade_case`, `check_observable_effects`, `audit_cases`, `load_rubric`, `ConsoleJudgeTransport`, and a CLI (`--audit-cases`, `--calibrate [--live]`). The judge runs over the same console chat-task API as `run-evals.py` (login once, an `eval-judge-<case-id>` session so judging never contaminates the case chat, 423 aborts, 429 backoff, 401 one re-login), on the existing model (mosicn nex-n2.6 expected), no new key, per-transport cap of 50 calls (judging doubles call volume). The versioned rubric (criteria R1–R6) is immutable — a change means a new `v2.md` file, never an edit. Fail-closed: non-JSON / missing field / `pass` not a bool / empty reason / pass with no quoted evidence / judge error / timeout / empty reply → unqualified, never pass; in `grade_case` that surfaces as verdict `"unqualified"`, not `"fail"`, so an outage never looks like a quality regression; `task` is mandatory. Injection-resistant: the reply is fenced as data, never instructions; the parser takes only the judge's own (last) `<verdict>` block, else whole-output JSON — no substring search for a JSON object. Calibration `cal-03` covers the injection attempt. No substring grading, at all: `grade_case` raises `ValueError` on legacy `expect_contains`/`must_not_contain`; observable effects are real probes only (`file_exists`, `endpoint_called`); a failed effect fails the case without calling the judge (quota saved). `audit_cases(cases.json)` flags 9 violations across 8 cases — all 5 T61 cases, plus 3 recall cases the sibling #6 agent added (`recall-loop-gate`, `recall-keepalive`, `recall-daily-summary`). The calibration set (12 human-reviewed examples with expected verdicts: timezone paraphrase, Paris-distractor, injection attempt, 2 borderlines, refusal good/bad, no-China good/bad, English good/bad, empty reply) is graded by the judge, not by a stub — the machine-free test does NOT claim live-model agreement (a stub returning recorded verdicts would only prove the parser); it proves parser/plumbing, set well-formedness, and that the old substring grader disagrees with the humans on 5/12 examples (`--old-grader` exits non-zero by design; the injection case fools the substring grader too, since the smuggled block itself contains "Paris"). Fail-first proven: the test failed with `ModuleNotFoundError` before `judge.py` existed. DeepSeek review caught 6+ issues, all fixed. (Registration fix by the coordinator: the test printed only `44/44 checks passed.`, which the runner's `(\d+) passed, (\d+) failed` regex cannot parse — added the harness-compatible tally line `44 passed, 0 failed`; no test logic touched.)
- Expected: 44 passed, 0 failed.
- History: added 2026-11-18 as all-20 todo #5 (research §2 gap #13; fork PRs #43/#57 give fixtures). Deliberately left alone: `run-evals.py` / `cases.json` untouched — migrating the 5 T61 cases to judge grading needs human re-review as judge cases first; no second judge for #6 (its integrity fixtures import `judge_reply` / `grade_case` from here, documented in the README with the exact signature); no temperature control (none exists in the chat-task envelope — live verdicts are one sample, not deterministic); no structured criterion citation (the rubric asks the judge to cite ids in the reason; the parser doesn't enforce it semantically); no new model key. NOT verified live: live-model agreement with the calibration set — no real judge call has been made. Run `QWENPAW_USER=satwik QWENPAW_PASS='...' python3 judge.py --calibrate --live` (or `test_judge.py --live`); it requires 12/12 agreement before the judge is called trusted, and also confirms the serving model is actually mosicn/nex-n2.6. If the live judge disagrees on a borderline case, that means fix the rubric or the example — not ship anyway. No machine deploy, no browser check, no sync to the machine.

### T114 — AgentX rebrand (DOM injection, harness)
- Area: `rebrand` · Method: `protocol`
- Check: `node features/rebrand/harness-rebrand.mjs` (93 checks). Static checks on the real `pages/public/_worker.js`: the fetch patch targets exactly the PyPI update-check URL (and only it) and returns the pinned version 2.3.0; the window.open patch swallows exactly the two upstream hosts (qwenpaw.agentscope.io, github.com/agentscope-ai/QwenPaw); the kill switch exists at both layers (worker env AGENTX_REBRAND=0 and ?rebrand=0 at runtime); the rule table has 13 rules and each runs in its own try/catch with a console.debug naming the rule; the menu/China rules hide by accessible name (aria-label/title/alt) and climb to the whole button/card container; the China climb is structural and never returns the list container (agentxClimbToChinaCard) and the hide-china rule uses it; the hide-by-name matching is case-insensitive (the console renders "XiaoYi" and the channel icon img alt is the lowercase id "xiaoyi"); the About click is a delegated capture listener with a prefix match ("About QwenPaw"/"About AgentX", version suffix allowed) that opens /status; the title is watched by its own MutationObserver on the `<title>` element; the logo rule replaces the QwenPaw img with an AgentX text label; the CSP-Report-Only + Referrer-Policy headers are set on the console HTML and the `<title>` is rewritten; the shim is injected before the panel script and the observer calls the rebrand pass; the keep-alive Worker and the activity-feed Worker report the note "AgentX console answered" and the activity-feed title/heading are AgentX. Dynamic checks in a VM with mocks: the real shim (extracted from the file, run with the file's own constants) stubs the PyPI fetch while other fetches pass through, swallows upstream window.open while other opens pass through, and stays unpatched under ?rebrand=0; the real rebrand rules (extracted between the AGENTX-REBRAND markers, run against a mock DOM) rename the title and a visible text node, hide a Tutorial and a GitHub menu item (but not Settings), hide icon-only buttons matched by accessible name (GitHub, Documentation) as whole buttons, leave a load-bearing instruction alone, rename an aria-label, hide the China cards on the REAL card DOM (hashed CSS-module classes from the live bundle: a DashScope / SiliconFlow / ModelScope / Aliyun provider card as a whole card, an Alibaba Cloud card matched only by its settings-button aria-label and a SiliconFlow card matched only by its icon img alt, a WeCom / DingTalk configured channel card and a Feishu / QQ / WeChat available-channel button, a XiaoYi / Yuanbao channel as an available button and as a configured card, and a XiaoYi channel matched only by its icon img alt "xiaoyi"), do NOT hide a non-China provider (OpenAI, DeepSeek, Anthropic) or a non-China channel (Telegram, Slack, iMessage), do NOT hide the provider list container or the channel grid, and hide the China cards when the provider list mounts after the initial pass (async mount), rename the About item ("About QwenPaw v2.3.0" → "About AgentX v2.3.0") and make clicking it open /status, replace the sidebar logo img with an "AgentX" text label, rename a title change immediately via the title observer, and block an upstream link click while letting a same-origin link through. Fail-first proven: against the unmodified `_worker.js` it fails 49/51 (the 2 that pass check for the absence of a rebrand section, vacuously true on the original file); after the 2026-11-18 browser-verification fixes, the extended harness fails 22/69 against the pre-fix code (all 22 are the new checks) and passes 69/69 after; after the 2026-11-18 China-card fix, the extended harness fails 13/86 against the pre-fix code (the 2 static China-climb checks, the 6 provider-card hides, the list over-hide, the 3 available-channel buttons, the async mount) and passes 86/86 after; after the 2026-11-18 XiaoYi/Yuanbao channel fix, the extended harness fails 7/93 against the pre-fix code (the 2 static checks — the China-hide list and the case-insensitive match — and the 5 XiaoYi/Yuanbao hides) and passes 93/93 after.
- Expected: 93 passed, 0 failed.
- History: added 2026-11-18 with the AgentX rebrand (approach B, DOM injection). Extended 2026-11-18 after a live browser verification found the first version only partly working (menu buttons and China cards blanked, not removed; About click dead; sidebar logo still QwenPaw; /status note still QwenPaw; settings title flashed). Extended again 2026-11-18 after a second live browser verification found SiliconFlow / ModelScope / Aliyun still present: the old generic climb hid the whole provider list (the case-sensitive `[class*='card']` never matched the hashed `groupCardGlass` class, while `[class*='provider']` matched the `providerCards` list container) and left available-channel buttons as unnamed shells; the harness mock used class `provider-card`, which the real bundle never emits, so it passed while the live rule failed. Extended again 2026-11-18 after a third live browser verification found the XiaoYi channel card still visible and Yuanbao present: the label list spelled it "Xiaoyi" (zero occurrences in the live bundle) while the console renders "XiaoYi" and the icon img alt is the lowercase id "xiaoyi", so the case-sensitive match could never fire; Yuanbao (Tencent) was missed by the original research. The live half (a real browser on the deployed console: title "AgentX Console", no update badge, no upstream menu items, no upstream navigation, China cards hidden) is verified by Muse after deploy.

---

## Out of scope for this catalogue (do not add tests here without a new decision)

- **JEV / Drex** — not implemented (PLAN.md Phase 2/3). No tests until they land.
- **Log-check option** (PLAN.md Phase 1: one place to see all logs with issue-finding) — a build item, not a test; T36/T37 cover the log greps this suite needs.
- **Mobile app** (Rakazo #16) and **15-language UI** (Rakazo #21) — explicitly excluded from the Rakazo build (English only).
- **Voice calls, bot email receive path, Spaces/Access enforcement** — blocked/partial items with external requirements (keys, a Cloudflare zone). Their blockers are recorded in `features/infra/README.md`; they get tests only when unblocked.
