# Real desktop — watchable screen + takeover (InstaBox built-in)

The user asked QwenPaw to open a site and hand them control, like Rakazo's
live computer. QwenPaw's own browser is headless Chromium and cannot do that.
The answer is **InstaBox's built-in desktop** — Xvfb + Xfce + Chromium + VNC —
which is almost certainly what Rakazo uses on InstaBox too (Rakazo lists
InstaBox as a sandbox provider; its "computer" is this desktop + the
computer-use MCP). No second machine, no tunnel, no extra host: it runs on
the same Free machine, on the same single account.

## How it works

| Piece | What it is |
|---|---|
| Desktop | `POST /v1/machines/{id}/desktop` — `status` / `install` / `start` / `takeover` / `handback`. Xvfb display `:1`, 1920x1080, Xfce, Chromium. `controller: agent` by default; `takeover` sets `controller: human` and the computer-use MCP refuses input tools until `handback` or 30 s without a call from the holder. |
| Watch + take over (main path) | `POST /v1/machines/{id}/desktop/stream` `{"viewOnly": false, "ttlSeconds": 86400}` → dashboard full-screen viewer link `https://dashboard.instabox.sh/desktop/{machine}#token=…`. Anyone with the link can open it without signing in; the token is signed, binds this machine + owner + mode, expires in 24 h max, revocable via `DELETE …/desktop/stream`. **This is the link to give the user.** |
| Watch + take over (backup path) | Camoufox's TigerVNC `:99` + noVNC on 6080, published as a **private** InstaBox port: `https://6080-{machine}.instabox.tech/?_token=…` (401 without the token). VNC password is set on the machine (`/data/home/camoufox/.vnc/`). This screen shows the Camoufox Firefox window, not the Xfce desktop. |
| Agent opens sites on the desktop | Camoufox bridge `POST /desktop-open {"url"}` (Bearer `BRIDGE_TOKEN`) runs `DISPLAY=:1 chromium <url>` — new tab if Chromium is already running. Verified live: wordsolverx.com open, then `example.com` opened as a second tab via this endpoint. |
| Agent browses anti-detect sites | Camoufox bridge (`/goto`, `/snapshot`, `/screenshot`, …) — see `features/camoufox/README.md`. x.com/0xsatwik → 200 through Camoufox; X search still needs a logged-in X session. |

## Root cause found 2026-11-15 (read this before touching the desktop)

The 2026-11-15 disk cleanup purged Chromium (`apt purge chromium`) — and
`POST /desktop {"action": "install"}` is a **no-op** afterwards: the API
reports `installed: true` from a stale marker while the binary is gone, and
the ghost Chromium processes kept running from deleted inodes until killed.
Fix was `sudo apt-get install -y chromium` (156.0.8078.79, ~330 MB, root
8.0G avail after). If the desktop ever shows a wallpaper with no browser
again, check `ls /usr/lib/chromium/chromium` first — do not trust
`installed: true`.

## Stream token expiry — SOLVED (2026-11-15 ~03:50 IST)

The viewer link handed to the user on 2026-11-14 showed "This desktop link
is invalid" in a live-browser check at 21:33–21:34 UTC. The first token's
payload `e` was 1794777868 = 2026-11-15T21:24:28Z and it was minted
2026-11-14T21:24:28Z — so it was **fresh (9 min old) when checked**; expiry
does NOT explain that failure. The later "fresh mint expires immediately"
reading was an **IST/UTC date mix-up**: a mint at 2026-11-14T21:37:26Z
returned `expiresAt` 2026-11-15T21:37:26Z, which IS mint+24h. Verified
again 2026-11-14T21:49:50Z: `expiresAt` 2026-11-15T21:49:50Z, payload
`e` = mint+86400 exactly (24.0 h). **ttlSeconds IS honoured; tokens last
24 h.** The one unexplained difference: the first (rejected) token's
payload had field `"a":0`, fresh mints have `"i":0` (both have
`u:-85024, g:0, v:false`) — no known meaning; do not chase it. **Rule:
never hand over a stream link until it has rendered in a real browser.**
A fresh 24 h link was minted 2026-11-14T21:49:50Z (expires
2026-11-15T21:49:50Z) and is held for a browser render check before the
user gets it.

## Embedded desktop — Rakazo-style, in the console itself (preferred)

Rakazo's pattern is that its own web app embeds the desktop view, so the
user never uses a separate dashboard link. Ours now does the same:

- Second websockify `desktop-novnc.service` (systemd, enabled, active)
  serves the `:1` desktop on `127.0.0.1:6081` → `127.0.0.1:5901`
  (noVNC HTML 200 locally). Port 6081 published **private** (id
  `pv-opxsq3ta4p5x7sh36c3kqteuf4`); its token is the Worker secret
  `DESKTOP_ORIGIN_TOKEN` on **both** Pages projects (never in git).
- `pages/public/_worker.js` `/desktop` branch: session-gated on a valid
  QwenPaw login — probes `ORIGIN + /api/healthz` with the visitor's
  cookies (200 = proceed, 401 = 302 to `/`, 503 = waking page).
  `/desktop` → 302 to
  `/desktop/vnc.html?autoconnect=true&resize=scale&reconnect=true`,
  prefix-stripped proxy to the 6081 origin with `_token` added
  server-side only, Location rewriting (origin → `/desktop/*`, foreign
  dropped), Domain= stripped from cookies, `X-Frame-Options: SAMEORIGIN`
  + `CSP: frame-ancestors 'self'`, no-store/nosniff, WebSocket 101
  passthrough. Local node harness: 9/9 checks pass (incl. no-secret →
  503, healthz 401 → 302, origin 401 → 502, token only in server-side
  origin URL). Deployed to both Pages projects.
- Live verified: `/desktop` without a cookie → 302 to `/` on both
  projects; `/` console still 200. **Logged-in path not yet verified**
  (needs a real logged-in browser session) — the gate works because the
  desktop lives on the same `qwenpawx.pages.dev` domain as the console
  login cookies.
- URL: `https://qwenpawx.pages.dev/desktop` (also on
  `qwenpaw-frontend.pages.dev/desktop`).

## QwenPaw drives the desktop natively (MCP) — DONE 2026-11-15 ~03:50 IST

The 2026-11-15 disk cleanup had deleted the `open-computer-use` npm
binary (it was an npm global, not a system package). Restored:

- Node v22.20.0 installed from the official tarball to `/opt/node`
  (node/npm/npx symlinked to `/usr/local/bin`).
- `npm i -g open-computer-use` → v1.1.4. `instabox-computer-use mcp`
  answers MCP `initialize` with tools `list_apps, get_app_state, click,
  perform_secondary_action, scroll, drag, type_text, press_key, set_value`.
  The proxy enforces the takeover lock: input tools are refused with "A
  human has taken control of the desktop; wait and retry" while a human
  controls it; read-only tools pass.
- `mcp-proxy` 0.15.0 (PyPI) in venv `/data/home/mcp-proxy/venv`,
  systemd service `mcp-computer-use.service` (see
  `mcp-computer-use.service` in this folder) binding the Docker gateway
  `172.18.0.1:8898`, serving the stdio MCP server over SSE
  (`http://172.18.0.1:8898/sse`). A real MCP client lists all 9 tools
  through it; `get_app_state {"app": "Chromium"}` returns the window
  state + a 144 KB PNG screenshot.
- QwenPaw side: **do NOT add it to `agent.json` / `config.json`
  `mcp.clients`** — the legacy migration is one-shot (watermark
  `migration_version: 2` already reached on the default workspace, so a
  new legacy client is ignored). The live config is the DriverCard
  `working/workspaces/default/drivers/mcp/computer-use.yaml` (reference
  copy `computer-use.yaml` in this folder; no secrets in it — plain
  `sse` endpoint `http://172.18.0.1:8898/sse`, `enabled: true`,
  policy deny-by-default + ask for all tools). Validated with QwenPaw's
  own loader (`load_card` → `computer-use mcp sse … enabled: True`).
- One container restart (`docker restart qwenpaw`, the task's single
  allowed restart) picked the card up at workspace init. Log confirms:
  `MCP client connected: computer-use` and `Driver 'computer-use'
  refreshed after card change` (there is also a
  `driver_config_watcher`, so future card edits hot-reload — a restart
  may not be needed next time). Container healthy after restart, auth
  on, bridge healthy, desktop still running, controller agent.
- **To use it:** in a QwenPaw chat (new session), ask e.g. "take a
  screenshot of the desktop" or "open example.org in the browser on the
  desktop". Tool calls ask for approval (policy `ask`) until the user
  changes it in the Console. The bridge (`/desktop-open` + Camoufox
  skill) stays as the fallback.

## Current state (2026-11-15 ~03:50 IST, verified live)

- Desktop running, 1920x1080, `controller: agent`, `agentPausable: true`.
- Chromium open on the desktop with tabs: wordsolverx.com
  ("Daily Puzzle Answers, Solvers & Wordle Tools" — screenshot
  `/data/home/camoufox/shots/desktop-wordsolverx4.png`), example.com
  (opened via `/desktop-open`, screenshot `desktop-open-test.png`), and
  example.org (opened via `/desktop-open` 2026-11-14T21:49Z, screenshot
  `retest-desktop.png` 114 KB; MCP `list_apps` confirms window
  "Example Domain - Chromium").
- Interactive stream link minted, TTL 24 h (token delivered to the user
  only — never in git or memory). **Fresh link minted 2026-11-14T21:49:50Z,
  expires 2026-11-15T21:49:50Z — awaiting a real-browser render check
  before the user gets it.**
- noVNC private ports published: 6080 (Camoufox `:99`, token in the
  publish response, user only; no token → 401) and 6081 (embedded
  `:1` desktop, token = `DESKTOP_ORIGIN_TOKEN` Worker secret).
- Embedded desktop live at `https://qwenpawx.pages.dev/desktop`
  (gate verified for logged-out → 302; logged-in path still to verify).
- QwenPaw computer-use MCP wired and connected (see section above).
  One container restart used (03:18 UTC) for the DriverCard pickup.
- Camoufox bridge healthy, browser sitting on `https://x.com/0xsatwik`.
- Astra alive again (models list works; earlier 429 cleared). 120 s
  first-content timeout still in `.env`; console + Pages 200, keep-alive
  Worker up.
- Re-test 2026-11-14T21:49Z: bridge open example.org OK, desktop
  screenshot OK, MCP `list_apps` + `get_app_state` (screenshot) OK,
  takeover → `controller: human` → handback → `controller: agent` OK
  (full cycle, ends in agent control).
- Snapshots: `qwenpaw-before-camoufox` (pre-install safety) and
  `qwenpaw-desktop-working` (captures the working desktop + Chromium
  reinstall + bridge `/desktop-open`). **Restore from
  `qwenpaw-desktop-working`, not the older one** — the older predates the
  Chromium reinstall.

## Limits (honest)

- The desktop dies when the Free VM pauses (30-min idle) or the run ends
  (~07:41 IST for the current run, then cooldown). The stream link works
  only while the machine + desktop run; re-`start` after a wake.
- The stream link is per-machine and per-owner; only the machine's creator
  (signed in or with their personal key) can mint/revoke it.
- `takeover` is advisory for direct display drivers (xdotool does not
  consult the lock); the computer-use MCP honors it.
- X search / logged-in X still needs a one-time X login in the Camoufox
  persistent profile (never paste an X password in chat).

## Useful commands

```bash
# status / start (1920x1080) / hand back control to the agent
python3 ~/workspace/custom-connectors/custom.instabox/bin/ib.py post \
  /v1/machines/m_agq5wqqo2fvypym7rjlpvngc2m/desktop '{"action":"status"}'
# (start / takeover / handback use the same endpoint with another action)

# mint an interactive viewer link (24 h max)
# POST /v1/machines/{id}/desktop/stream {"viewOnly": false, "ttlSeconds": 86400}

# open a URL on the desktop screen (agent side, needs BRIDGE_TOKEN)
curl -X POST -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}' \
  http://127.0.0.1:8899/desktop-open

# screenshot the desktop screen (from the machine)
DISPLAY=:1 scrot /data/home/camoufox/shots/desktop.png
```
