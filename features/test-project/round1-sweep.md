# Round 1 — coordinator live protocol sweep (2026-11-15 06:59–07:13 IST)

Machine running (run ends ~07:41 IST). All checks below are protocol-level (curl / ib exec / node WS). Browser checks are the parent's job and are listed separately at the end.

## PASS (protocol)

| # | Check | Evidence |
|---|---|---|
| P01 | Pages root qwenpawx + frontend | 200, 40,447 B both |
| P02 | /status | 200, 5,629 B |
| P03 | /api/auth/status | 200 `{"enabled":true,"has_users":true}` |
| P04 | /desktop no-cookie | 200 gate page, 1,884 B |
| P05 | /desktop/__lease | 200, holder agent |
| P06 | /desktop/vendor/xterm.js | 200, 283,404 B |
| P07 | Keep-alive / + /status + GET /ping | 200, status "up", 0 consecutive failures, lastUpAt 01:25:59Z |
| P08 | Routines / | 200, routines HTML renders |
| P09 | Group chat / | 200 JSON, `auth_required: true` |
| P10 | Ticket board / | 200 HTML renders |
| P11 | Bot pages / + /skills/ | 200 / 200 |
| P12 | Activity feed / | 200 |
| P13 | Container | Up 3h (healthy); /api/healthz `{"status":"ok","agents_loaded":["default","QwenPaw_QA_Agent_0.2"],"uptime_seconds":9663.22}` |
| P14 | Services + ports | 20 desktop/mcp/bridge services running, 0 failed; listening: 5901, 5903/5904, 5999, 6080–6085, 8897/8898; free RAM ~5,030 MB; /data 38%, / 48% |
| P15 | WebSocket origins | 6081 → `RFB 003.008`; 6084 → `RFB 003.008`; 6085 → `RFB 003.008`; 6083 → terminal frames |
| P16 | MCP SSE | 172.18.0.1:8898 → 200; 8897 → 200 |
| P17 | Skills | 19/19 enabled, 0 disabled (build-page, camoufox-browser, delegate, github, mailbox, cron all enabled) |
| P18 | Approvals | 7 `driver_policy` log lines, ALL 04:14:30–04:18:45 IST (pre-fix); ZERO new since the fix. Default + QA cards: `default_effect: deny`, rule `*` → `allow` |
| P19 | Agent screenshot | mss capture in container 1920x1080, PIXEL-IDENTICAL to host scrot (mean abs diff 0.00, frac pixels diff>25 = 0.0000) |
| P20 | :1/:2 Chromium | :1 "Today's Puzzle Answers" 1920x1004+0+28 mapped; :2 "Daily Puzzle Answers" (chromium-qa profile) 1920x1048+0+0 mapped; host scrots 1920x1080 both |
| P21 | Heartbeat state | `agents.defaults.heartbeat` = enabled False, every 6h (state confirmed; enabling needs user OK — NOT a failure) |
| P22 | Agent config | active_agent default; decision_model null; fallback_models [] |
| P23 | Jobs / token usage | jobs empty; token_usage present (mosicn dominant: 1,521,403 prompt tokens, 65 calls) |
| P24 | Fail-closed auth | routines POST /trigger → 401; groupchat POST /thread/message → 401; groupchat GET /thread → 401; keepalive POST /wake → 401; board /api/tickets → 401 with helpful message |
| P25 | Bridge health | GET http://127.0.0.1:8899/health → `{"ok":true,"browser_alive":true}` |
| P26 | Camoufox | FOUND BLANK then FIXED (see below) |

## FAIL found in round 1 — FIXED live

**F26 Camoufox was at about:blank.** Bridge POST /snapshot returned `{"ok":true,"title":"","url":"about:blank","text":"<html><head></head><body></body></html>","chars":39}`; :99 screen analysis: 477 unique colors, mean RGB (246,246,248), 18,987 bytes — a blank white page, not a webpage. Root cause: the Camoufox browser had been restarted and came back at about:blank; nothing re-navigated it. Fix: bridge POST /goto `{"url":"https://x.com/0xsatwik"}` → `{"ok":true,"title":"Satwik Samanta (@0xSatwik) / X","url":"https://x.com/0xsatwik","status":200}`. Re-verified: snapshot after shows the real profile text (4,960 posts, bio, Nov 11/Nov 9 posts); :99 screen now 45,175 unique colors, 349,994 bytes.

**F27 BOTH computer-use DriverCards failed to parse (found by log-check).** `DriverCardError: Failed to parse DriverCard YAML ... mapping values are not allowed here` (line 9, col 401 default / 436 QA). Root cause: the `description:` was an unquoted single-line scalar containing `": "` inside the JSON snippet `-d '{"text": "<what you need>"}'`. Consequence: the driver_config_watcher could not reload the cards, so the running drivers kept the OLD description — the needs-you + narration instructions added in the extension build were never live. Fix: rewrote `description:` as a YAML literal block scalar (`description: |` + indented text) in both live cards (backups in working.backups/*-yaml-fix) and both repo copies (features/desktop/computer-use.yaml, computer-use-qa.yaml). Verified: yaml.safe_load OK (desc len 781 default / 816 QA, policy allow, correct SSE URLs); watcher logged three "Driver 'computer-use' refreshed after card change" at 07:08:54/56 IST; zero new DriverCardError after the fix.

**F28 Agent-side needs-you path had no token.** The DriverCard instructs the agent to curl the bridge with `Authorization: Bearer $CAMOUFOX_BRIDGE_TOKEN`, but the variable was NOT set in the container (len 0), and the bridge gates everything except GET /health on that Bearer token (`_auth` → 401). So the agent's needs-you curl would always 401 — the agent path was never live-tested (the build's "verified end-to-end" used a host-side curl with the token). Fix: appended `CAMOUFOX_BRIDGE_TOKEN` (copied machine-side from /data/home/camoufox/.env, value never printed or stored elsewhere) to /data/home/qwenpaw/.env (backup .env.bak-2026-11-15-needsyou), recreated the container via `docker compose up -d` (necessary: env is read at container start). Verified after recreate: container Up (healthy), healthz ok, token_len 43 inside the container, no-token → 401, env-token + empty text → 400 `empty_text` (auth passed, validation rejected before any forward — no banner created), both drivers reconnected (MCP client connected 07:10:23/24), no new DriverCardError.

## NEEDS-TOKEN (not testable without user-held tokens — do NOT invent them)

- Group-chat post with GROUPCHAT_TOKEN
- Routines POST /trigger with ROUTINE_WEBHOOK_TOKEN
- Board CRUD with the board key
- Keep-alive POST /wake with WAKE_TOKEN

## NEEDS-BROWSER (parent only)

- Console login flow as satwik, chat model reply in the UI
- /desktop overlay interactions: take/release pill, terminal interaction, teach recording, needs-you banner, side panel
- Evals live run, chat-task via the UI

## KNOWN-GAP (not a fail)

- Mailbox MCP `qwenpawmail` not configured (skill present + enabled; MCP server missing)
- INSTABOX_API_KEY unset as Worker secret (maintenance menu + Wake desktop-start unavailable)
- Heartbeat disabled (user decision pending)
- decision_model null; fallback_models empty

## Test-method corrections for the suite (learned this round)

- mss test MUST set `DISPLAY=:1` in `docker exec` (bare exec has no DISPLAY → XError; not a product bug).
- Default computer-use card is mode 600 root — read it via `docker exec`, not host grep (host grep → Permission denied).
- config.json has NO top-level `heartbeat`/`active_agent` — they live under `agents.defaults.heartbeat` and `agents.active_agent`.
- Bridge `/snapshot` and `/goto` are POST, not GET. Bridge port 8899 (`BRIDGE_PORT` env, default 8899). Bridge token lives in `/data/home/camoufox/.env` — use it machine-side only, never print or store it.
- Camoufox check: snapshot URL must be `https://x.com/0xsatwik` AND :99 unique colors > 5,000 (a real page); < 1,000 colors + near-white mean = blank.
- Screenshot check: mss (with DISPLAY=:1) vs host scrot pixel diff — pass is mean abs diff < 5 and frac pixels diff>25 < 0.05.
