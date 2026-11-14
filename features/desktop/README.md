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

UPDATE 2026-11-15 ~03:55 IST: the 21:49:50Z token ALSO failed in a real
browser ("This desktop link is invalid", first load + reload) — so the
expiry theory is dead twice over. Decoded, that token's payload was
`{u, g, v, e, i}` — it LACKS the machine id (`m`) and nonce (`n`) that
the first (also rejected) token had. A mint is not always well-formed:
fresh mints done after that one (21:58Z, 22:13Z) return the FULL
7-field payload `{m, u, i, g, v, e, n}` with `e` = mint+86400. Why one
mint came back short is unexplained (it was minted during the
takeover/handback re-test, so desktop state at mint time is a suspect —
never mint while a takeover is in progress). **Always decode the payload
and check for `m` + `n` before trusting a mint.** A fresh full-payload
link was minted 2026-11-14T22:13:52Z (expires 2026-11-15T22:13:52Z) and
saved at `/tmp/stream-link.txt` for a parent browser render check —
still NOT verified in a real browser, do not give it to the user until
it renders.

## Embedded desktop — Rakazo-style, in the console itself (preferred)

Rakazo's pattern is that its own web app embeds the desktop view, so the
user never uses a separate dashboard link. Ours now does the same:

- Second websockify `desktop-novnc.service` (systemd, enabled, active)
  serves the `:1` desktop on `127.0.0.1:6081` → `127.0.0.1:5901`
  (noVNC HTML 200 locally). Port 6081 published **private** (id
  `pv-opxsq3ta4p5x7sh36c3kqteuf4`); its token is the Worker secret
  `DESKTOP_ORIGIN_TOKEN` on **both** Pages projects (never in git).
- `pages/public/_worker.js` `/desktop` branch: session-gated on a valid
  QwenPaw login. **The first gate design was wrong and is replaced — see
  "Gate fix" below.** The current design: a gate page + `POST
  /desktop/__verify` + HMAC-signed cookie (12 h, `Path=/desktop`, keyed
  by `DESKTOP_ORIGIN_TOKEN`). `/desktop` → 302 to
  `/desktop/vnc.html?autoconnect=true&resize=scale&reconnect=true`,
  prefix-stripped proxy to the 6081 origin with `_token` added
  server-side only, Location rewriting (origin → `/desktop/*`, foreign
  dropped), Domain= stripped from cookies, `X-Frame-Options: SAMEORIGIN`
  + `CSP: frame-ancestors 'self'`, no-store/nosniff, WebSocket 101
  passthrough. Local node harness `harness-desktop-gate.mjs`: 11/11
  checks pass (gate page, bad token → 401, good token → 200 + valid
  HMAC cookie, forged/expired cookie → gate, vnc.html proxied, bad
  JSON → 400, GET __verify → 405, console unaffected). Deployed to both
  Pages projects.
- Live verified: `/desktop` without a cookie serves the gate page (200,
  1,884 B) on both projects; `POST /desktop/__verify` with a bad token
  → 401 `{"ok":false}`; console still 200. **Logged-in render still
  needs a real logged-in browser check by the parent** — the gate page
  reads the console's stored token from browser storage and reloads
  once `__verify` succeeds.

### Gate fix — why the first gate could never work (2026-11-15 ~04:15 IST)

The first gate probed `ORIGIN + /api/healthz` with the visitor's
**cookies**. QwenPaw has no session cookie at all: its auth reads the
token only from the `Authorization: Bearer` header or the `?token=`
query param (`/app/src/qwenpaw/app/auth.py`, `_extract_token`, line
~850; no `set_cookie` anywhere in the app). The console SPA keeps the
token in browser storage and sends it as a header on API calls — a
plain navigation to `/desktop` carries no credential, so the probe
always got 401 and the worker bounced every logged-in user to `/`
(the SPA then sent them on to `/chat`). Verified symptom: logged-in
browser, `/desktop` → `/chat` (3 tries, 2 tabs); logged-out curl
correctly 302'd. The new gate page runs in the browser on the same
origin as the console, so it can read the stored token, tries every
token-shaped stored value against `__verify` (max 10), and reloads on
success. The token is never logged or stored server-side.

### Pages secret lesson — redeploy after setting a secret (2026-11-15)

After the gate rewrite was deployed, `/desktop` returned 503
"Desktop is not configured yet" on BOTH projects even though the
project config listed `DESKTOP_ORIGIN_TOKEN` (secret_text) in both
environments. The secret value was re-set via the API (PATCH
`/accounts/{id}/pages/projects/{project}` — PUT returns 405
`method_not_allowed`) and the worker STILL 503'd until the projects
were **redeployed**. Rule: **a Pages secret only binds to deployments
created after it is set — set the secret, then redeploy.** The 6081
publish was also rotated in the process (delete + re-create returns
the new private-port token; the list/get APIs never return it): new
publish id `pv-sei4re6fbr7e6kkb3nyt6wnp5q`, token re-set as
`DESKTOP_ORIGIN_TOKEN` on both projects. Current deployments:
qwenpawx `df54820e-1418-4158-be07-ea0c8fc1788a`, qwenpaw-frontend
`4fcbfc1a-edc7-4b73-9190-c13093000b37` (both production/main/success).
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
- Chromium on the desktop: the window came up 10x10 (`WM_NORMAL_HINTS:
  program specified size: 10 by 10`) even with `--start-maximized`, so
  screenshots showed a bare desktop. Fixed: `bridge.py` `desktop_open`
  now launches with `--window-size=1920,1048 --window-position=0,0`
  (in addition to `--start-maximized`); Chromium relaunched via
  `/desktop-open` — content window now `1920x1004+0+28` titled "Daily
  Puzzle Answers, Solvers & Wordle Tools - Chromium" (wordsolverx.com),
  screenshot `/data/home/camoufox/shots/fix-1-after.png` (496 KB).
  NOTE: the repo copy `features/camoufox/bridge/bridge.py` predates
  `desktop_open` entirely — it is stale; the live file is on the
  machine at `/data/home/camoufox/bridge/bridge.py`.
- Interactive stream link: the 21:49Z mint was ALSO invalid in a real
  browser (payload lacked `m`/`n`). Fresh full-payload link minted
  2026-11-14T22:13:52Z, expires 2026-11-15T22:13:52Z, saved at
  `/tmp/stream-link.txt` — awaiting a real-browser render check before
  the user gets it.
- noVNC private ports published: 6080 (Camoufox `:99`) and 6081
  (embedded `:1` desktop, publish id now
  `pv-sei4re6fbr7e6kkb3nyt6wnp5q`, token = `DESKTOP_ORIGIN_TOKEN` Worker
  secret). **Both VNC servers are passwordless now**: `:99` restarted
  with `-SecurityTypes None` (was `-rfbauth`, which is why the 6080
  view prompted for a VNC password on Connect) and `:1` already ran
  with `None` — protocol-verified, both offer only security type `[1]`
  (None), so noVNC never prompts. `/usr/share/novnc/index.html` now
  redirects `/` straight to `vnc.html?autoconnect=true&resize=scale&
  reconnect=true` (was a directory listing). Camoufox relaunched after
  the `:99` restart and is back on `https://x.com/0xsatwik` (200,
  title verified); its window resized to 1920x1048.
  The 6080 direct URL still needs its private-port token (unchanged);
  the 6081 token is the Worker secret (server-side only).
- Embedded desktop live at `https://qwenpawx.pages.dev/desktop`
  (gate page 200 for logged-out, `__verify` 401s bad tokens). **Fixed
  2026-11-15 ~04:15 IST — see "Final fix round" below**: the
  `/desktop/vnc.html` fetch now returns real noVNC HTML (200, 17,810 B)
  instead of the console SPA, and the WebSocket opens with the RFB
  banner. Logged-in render still needs a real-browser check by the parent.
- QwenPaw computer-use MCP wired and connected (see section above).
  One container restart used (03:18 UTC) for the DriverCard pickup.
  **Fixed 2026-11-15 ~04:15 IST — see "Final fix round" below**:
  Chromium is now visible to AT-SPI, `list_apps` shows it and
  `get_app_state({"app":"Chromium"})` returns a 1920x1004 screenshot of
  the actual browser window (wordsolverx.com).
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

## Final fix round — /desktop redirect + agent screenshot (2026-11-15 ~04:15 IST)

Both bugs were verified by the parent in a real browser at 03:47 IST and
both are fixed below. Neither needed a container restart.

### BUG 1 — /desktop fell back to the chat view (root cause: InstaBox proxy 303)

**Measured live (not guessed):** with a valid desktop cookie,
`GET /desktop` → 302 to `/desktop/vnc.html?...`, then
`GET /desktop/vnc.html?...` → **303 `Location: /vnc.html?...`**,
then `GET /vnc.html` → **200, the QwenPaw console SPA (38,125 B)** —
whose router shows the chat view with a blank pane, URL still on
`vnc.html`. That is exactly the reported symptom.

**Mechanism:** the InstaBox private-port proxy answers ANY request
carrying `?_token=` with `303 See Other` + `Set-Cookie:
__Host-instabox_port_auth` and a relative Location with the token
stripped (verified by curl against the 6080 origin for `vnc.html`,
`app/ui.js` and `websockify` alike). The old worker passed that relative
Location straight to the browser, so the browser left `/desktop/*` for
`/vnc.html` on the Pages root. A follow-up request with ONLY that cookie
(no `_token`) returns 200; no cookie + no token returns 401.

**Fix (`pages/public/_worker.js`, `fetchDesktopOrigin`):**
- First try WITHOUT `_token`, forwarding the browser's cookies (a
  returning visitor already holds `__Host-instabox_port_auth`).
- On 401, retry once WITH `_token` and follow the proxy's 303
  server-side (resolve Location against the origin, re-fetch without
  `_token` but with the 303's Set-Cookie, max 3 hops).
- The collected proxy-auth cookies are passed through to the browser
  (Set-Cookie) so later visits skip the token dance.
- Any Location that survives is resolved against the desktop origin and
  re-scoped under `/desktop/*`; foreign redirects are dropped — a
  root-relative Location can never reach the browser again.
- The WebSocket path was already fine and is untouched in behaviour:
  the upgrade opens (101) and the first message is the RFB banner
  (`RFB 003.008`).

**Verification:** harness `features/desktop/harness-desktop-gate.mjs`
extended with a mock InstaBox proxy — **16/16 pass** (new tests 11–14:
303-follow to 200, cookie-first path sends no `_token`, asset through
the same flow, foreign redirect dropped). Live (Node probe with a
short-lived test token, since revoked): `/desktop/vnc.html` → **200,
real noVNC HTML, 17,810 B, `class="noVNC_loading"`, `app/ui.js`
present**; WS → 101 + `RFB 003.008`. Deployed to both Pages projects
(qwenpawx `dda49570`, frontend `b95a1340`).

### BUG 2 — the agent's screenshot showed a bare desktop (root cause: Chromium off the AT-SPI bus)

**Measured live:** the MCP server's `list_apps` returned ONLY
`xfce4-panel`, `xfdesktop`, `xfwm4` — no Chromium — so
`get_app_state({"app":"Chromium"})` returned `appNotFound("Chromium")`.
The agent's screenshot therefore came from the desktop window's own
pixbuf (wallpaper + icons), never the Chromium window above it. VNC and
`scrot` capture the composited framebuffer, which is why THEY showed the
window.

**Mechanism:** Chromium (pid 61356) was launched by the bridge with
**no `DBUS_SESSION_BUS_ADDRESS` and no `XDG_RUNTIME_DIR`** (the bridge
systemd unit never set them), so it could not register with AT-SPI2
(registry at `/run/user/1000/at-spi/bus`). The XFCE session, Xvnc and
the MCP server all have `DBUS_SESSION_BUS_ADDRESS=
unix:path=/run/user/1000/bus`.

**Fix (live on the machine, `/data/home/camoufox/bridge/bridge.py`,
`desktop_open`, backup `bridge.py.bak-2026-11-15-atspi`):** inject the
session-bus env into the Chromium subprocess — discover
`DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` from the running
`xfce4-session`'s environ, fall back to `/run/user/<uid>`. Bridge
restarted (`sudo systemctl restart camoufox-bridge` — plain restart is
denied for the exec user), Chromium killed and relaunched via
`/desktop-open` (wordsolverx.com). **The repo copy of `bridge.py` is
NOT synced — it contains no secret values, but the file is kept
machine-only by convention; the patch is documented here.**

**Verification (live, via the running MCP server — the exact path
QwenPaw uses):** `list_apps` now shows Chromium; `get_app_state(
{"app":"Chromium"})` → `isError: False`, `App=Chromium (pid 72478)`,
window `"Daily Puzzle Answers, Solvers & Wordle Tools - Chromium"`,
frame `{x: 0, y: 0, width: 1920, height: 1004}`, and a **1920x1004
screenshot of the actual browser window** (wordsolverx.com content
visible in the pixel map; the old 144 KB "screenshot" was the bare
desktop). Note: `/proc/<chromium-pid>/environ` is **zeroed after
startup** (1150 NUL bytes — Chromium scrubs it), so env checks must use
the crashpad-handler children (which inherit the launch env and DO show
`DBUS=Y`) or the launch-time env, never the main process environ.

**Still needs the parent's real browser:** (1) log in as satwik →
`https://qwenpawx.pages.dev/desktop` — confirm the embedded desktop
renders and stays rendered; (2) new QwenPaw chat → "take a screenshot
of the desktop" — confirm the browser window is visible in the reply.

## Screenshot fix — the agent's own screenshot showed a bare desktop (2026-11-15 ~04:25 IST)

**Correction to BUG 2 above:** the AT-SPI fix fixed the MCP path only
(`get_app_state` returns the window). The agent's own chat screenshot
still showed a bare desktop at 04:10 IST — because the agent does NOT
use the MCP for "take a screenshot of the desktop". It uses QwenPaw's
native tool `DesktopScreenshot`
(`/app/src/qwenpaw/agents/tools/desktop_screenshot.py`), which captures
with **mss** (`mss.mss().shot(mon=0)`) inside the container.

**Real root cause (measured live):** the container runs its OWN full
desktop — Xvfb `:1` (1280x800) + `dbus-run-session startxfce4` +
xfce4-session/panel/xfdesktop, all started by supervisord from the
image's `/etc/supervisor/conf.d/supervisord.conf.template` — while the
host's real desktop is Xvnc `:1` (1920x1080, Chromium + wordsolverx).
Both claim display `:1`, but the container's `/tmp/.X11-unix` is private
to it, and the QwenPaw server runs with `DISPLAY=:1`. So mss always
captured the container's phantom XFCE desktop (same wallpaper/icons/dock
— hence "bare desktop"), never the host desktop. A compositor would not
have helped: Chromium is not on that X server at all.

**Fix (live, container recreated once — the restart was necessary and is
the proof: `DISPLAY=:1` is baked into the running supervisord `app`
environment, the internal Xvfb owned the container's X1 socket, and the
host socket can only be shared via a compose volume change):**
- `instabox/docker-compose.yml`: added volumes
  `/tmp/.X11-unix:/tmp/.X11-unix` (host X sockets into the container)
  and `/data/home/qwenpaw/supervisord.conf.template:/etc/supervisor/
  conf.d/supervisord.conf.template:ro`.
- `instabox/supervisord.conf.template` (new, byte-identical to the live
  file): `xvfb` and `xfce4` programs set `autostart=false`,
  `autorestart=false`, and the `rm -f /tmp/.X1-lock /tmp/.X11-unix/X1`
  was removed from the xvfb command — with the host socket mounted in,
  that rm would have deleted the host desktop's socket. Disabling xfce4
  also matters: otherwise a second XFCE session would start against the
  host display and fight the host's own session.
- `docker compose up -d` recreated the container (backup:
  `docker-compose.yml.bak-2026-11-15-screenshot-fix` on the machine).
  A fresh snapshot create was refused with HTTP 429 (rate limit — not
  retried); the existing `qwenpaw-desktop-working` snapshot remains the
  restore point.

**Verification (mechanism + live behaviour):** after the recreate the
container has no Xvfb/XFCE processes, its `/tmp/.X11-unix` shows the
host's X1/X99 sockets, and `mss` inside the container captures
1920x1080 — pixel-identical to the host's own `scrot` (same brightness
grid, same center pixel). `list_apps` still shows Chromium
(`[running, pid=72478, window=Daily Puzzle Answers, Solvers & Wordle
Tools - Chromium]`); qwenpawx root and `/desktop` both 200.
**Parent browser proof 04:23 IST:** new chat "take a screenshot of the
desktop" → zero approval prompts, 3 steps, 8 s, and the screenshot
**shows the Chromium window with wordsolverx.com** (two tabs — the
second tab came from the re-open call below).

**One loose end, stated honestly:** after the recreate the Chromium
window was found `IsUnMapped` (10x10; its frame 1920x1032 also
unmapped) even though the process was alive and the parent had seen it
mapped at 04:11 IST. The only desktop interactions in that window were
MCP clicks/keys (22:44–22:49 UTC, incl. a `click_method=global` call) —
correlating, not proven. It was re-mapped with the bridge
(`POST /desktop-open {"url":"https://wordsolverx.com"}` → `{"ok":true}`,
window `0xe00003` 1920x1004 `IsViewable`) and stayed mapped across
re-checks. If an agent screenshot ever comes back bare again, first
check `xwininfo -id <chromium-window>` map state; if unmapped, re-open
the URL through the bridge — do not re-diagnose the capture path, it is
now the host display.

## Rakazo-style computer — P0/P1 build (2026-11-15 ~04:30 IST)

Per the study `rakazo-computer-study.md` (repo commit `0c97840`). The
working XFCE 1920x1080 desktop was NOT churned; the computer-use
DriverCard policy stays `effect: allow` (approval fix, blob `3693a825`
— do not revert to `ask`). No container restart was needed for this
build. KV namespace `qwenpaw-desktop` (`3eb38e6ebdce41f0a7ed744a99afee46`,
bound as `DESKTOP_KV` on BOTH Pages projects, production + preview).

### P0 — view/control split + lease + sealed capabilities

| Piece | What it is |
|---|---|
| View-only VNC | `desktop-vnc-view.service`: x11vnc `-display :1 -forever -shared -viewonly -nopw -rfbport 5902 -localhost`. `desktop-novnc-view.service`: websockify `127.0.0.1:6082 → 127.0.0.1:5902`. Port 6082 published **private** (id `pv-lwjj2gjx7mrvllk64p6xttkf4a`); token = Worker secret `DESKTOP_VIEW_TOKEN` on both projects (never in git). Reference copies in this folder. |
| Lease (Worker KV) | `POST /desktop/__takeover` grants a 90 s UUID lease (409 if held); `POST /desktop/__heartbeat` extends 90 s (410 on wrong/stale lease); `POST /desktop/__release` names the lease (stale release is a no-op); `GET /desktop/__lease` is public read. Fence counter + `generation` counter in KV (bumped on takeover/release). |
| Lease → agent lock | `desktop-lease-watcher.service` polls `__lease` every 5 s (`lease-watcher.py` in this folder) and writes `human worker-lease <epoch>` to `/run/user/1000/instabox-control` while a user lease holds; the computer-use MCP proxy refuses input tools while that file is fresh (≤30 s), read-only tools pass. On lease end it removes the file ONLY if its owner word is `worker-lease` (a dashboard takeover writes a different owner, so it can never be cleared by mistake). On Worker-unreachable it leaves state unchanged (fail-open for the agent). |
| Sealed capabilities | `POST /desktop/__screen` mints an AES-256-GCM sealed capability (60-min TTL, scope `{mode, generation, leaseId}`; control requires holding the lease); key = SHA-256 of `DESKTOP_ORIGIN_TOKEN` (no new secret). `GET /desktop/session/{view\|control}/{exp}.{token}/...` verifies the capability on EVERY request and proxies to the 6082 (view) or 6081 (control) origin; legacy direct `/desktop/*` asset paths now 302 to the chrome (the old bypass is closed). |
| noVNC shim + state machine | The Worker injects a shim into `vnc.html`: in-memory storage fallback, hides `#noVNC_status` + the control bar in view-only, posts `qwenpawScreen` states (loading/connecting/connected/failed/disconnected) to the parent, deletes `VideoDecoder` (prevents a codec stall), and re-checks the capability every 1 s on the WebSocket (closes on revocation). |

**Verification (protocol level, all live):**
- Harness `harness-desktop-gate.mjs`: **38/38 pass** (gate, verify,
  cookie, legacy redirect, lease grant/409/heartbeat-410, capability
  mint, session view/control routing to the right origin, shim
  injection incl. control-bar hiding only in view mode, stale release,
  generation bump killing old capabilities, tampered capability 403,
  `__status`, `__wake` throttle, `__action` 503 without key, foreign
  redirect dropped).
- **RFB split test (raw RFB client, live):** pointer event to 5902
  (view) left the cursor at (960,540) — ignored; pointer event to 5901
  (control) moved it to (700,700); cursor restored. Both servers
  1920x1080.
- **Lease end-to-end (live, via KV write):** lease written → watcher
  wrote `human worker-lease <epoch>` within ~40 s (KV propagation +
  5 s poll); MCP `list_apps` passed, `click` refused with "A human
  has taken control of the desktop; wait and retry after they hand
  back." (the exact path QwenPaw uses, via the SSE proxy); lease
  deleted → file cleared (23:08:28, journal) → `click` reached the
  server (`Missing required argument: app`, not the refusal).
- **Bugs found by testing, fixed:** (1) Python urllib's default
  User-Agent is 403'd by Cloudflare on the Pages domain — the watcher
  now sends a Mozilla UA. (2) The watcher's expiry check multiplied
  epoch-ms by 1000 again (`exp * 1000`), so an expired lease would
  have been treated as active forever — fixed to compare ms directly.
  (3) The removal branch's desktop-controller check flaked (two
  "controller is not agent" log lines); the owner-word check is the
  real guard, so the controller check was removed. (4) KV is
  eventually consistent: after a delete, a stale read kept refreshing
  the control file for ~50 s — the 30 s staleness bound caps the
  agent's wait; documented in `lease-watcher.py`.
- Deployed 2026-11-14T23:04:16Z: qwenpawx `35eb7913-6fae-45f8-bacf-
  84bd35ad407e`, qwenpaw-frontend `26d23300-11d4-4f1e-86ad-34caed128e
  ae` (both production/success). Live: `/` → 200 both projects,
  `/desktop` no-cookie → 200 gate page, `/desktop/__lease` → 200
  `{"holder":"agent","leaseId":null,"expiresAt":null,"fence":0,
  "generation":0}` on both.

### P1 — overlay chrome + Wake/Asleep + "…" menu

- `pages/public/desktop-chrome.html`: Rakazo-style header (QwenPaw's
  computer, status pill, Take control → green "You have control" pill
  + Release control, "…" menu, X Close → `/chat`, machine keeps
  running). The screen iframe has `pointer-events: none` until the
  user holds control — that IS the gate. Held predecessor frame during
  view↔control swaps (15 s timeout, so the screen never blanks);
  pre-probe before mounting; auto-reconnect with backoff (max 10,
  then Retry); 15 s heartbeat only while the page is visible; release
  on `pagehide` via `sendBeacon`. Wake/Asleep/Booting states via
  `GET /desktop/__status` (probes the view origin + keep-alive
  `/status`) and `POST /desktop/__wake` (calls keep-alive `GET /ping`,
  throttled 1/60 s in KV).
- "…" menu endpoint `POST /desktop/__action` (Stop/Recover/Reset/
  Update): **built, but returns 503 `instabox_api_key_unset` until
  `INSTABOX_API_KEY` is set as a Worker secret on both Pages projects
  (then redeploy). The key was NOT invented and must come from the
  user.** Recover/Reset/Update return 501 `unsupported` — the
  InstaBox desktop API has no such actions (only
  status/install/start/takeover/handback/stop), so those menu items
  are honest stubs, not live actions.
- **Still needs the parent's real browser:** (1) log in as satwik →
  `/desktop` — confirm the overlay chrome renders and stays rendered;
  (2) Take control → green pill + heartbeat + Release control + held
  frame across the swap; (3) Wake/Asleep states (only visible when the
  machine is actually asleep); (4) "…" menu shows the API-key message
  (expected 503 until the key is set). The parent already verified the
  plain `/desktop` render at 04:11 IST (before this chrome existed).

## Scope extension — the rest of Rakazo (2026-11-15 ~05:00 IST)

The user asked for the REST of Rakazo too (teach-by-showing, needs-you,
maintenance UI, per-bot computer + Team/Private, terminal tab, side-panel
preview, tool-call display, generations + preview). All built, all
protocol-verified; the harness is now **89/89** (tests 1–21 P0/P1 +
22–31 extension). No container restart. The working XFCE 1920x1080
desktop was NOT churned.

### Per-bot computer + Team/Private — a real second display :2 (not a toggle-only stub)

- **:2 display** (services in this folder): `desktop-xvfb-qa.service`
  (Xvfb :2, 1920x1080) + `desktop-dbus-qa.service` (a DEDICATED session
  bus `unix:path=/run/user/1000/qa/bus` — see below) + `desktop-wm-qa.service`
  (xfwm4 on :2) + x11vnc view (5903) / control (5904) + websockify view
  (6084) / control (6085). Ports 6084/6085 published **private**
  (pv-6dnnzvsqjqzfrbwsida6d45x3q, pv-zcqckhcx6ezqvm5elgvtbxx4mm);
  tokens = Worker secrets `DESKTOP_QA_VIEW_TOKEN` /
  `DESKTOP_QA_ORIGIN_TOKEN` on both projects (never in git).
- **Why a second bus:** the first attempt (DISPLAY=:2 only) failed —
  `open-computer-use` lists apps via the shared AT-SPI registry, so the
  :2 proxy saw the :1 apps (and `get_app_state xfwm4` matched the :1
  one). A dedicated bus gives the :2 display its own AT-SPI registry,
  so the QA proxy sees ONLY :2 apps.
- **Why a wrapper script:** `mcp-proxy` spawns its server with a
  MINIMAL env (only HOME/LOGNAME/PATH/SHELL/USER — verified in
  `/proc/<pid>/environ`), so the display/bus set in the systemd unit
  never reaches the server. `qa-server.sh` (in this folder) exports
  `DISPLAY=:2`, `XDG_RUNTIME_DIR=/run/user/1000/qa`,
  `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/qa/bus` and execs
  the proxy directly — bypassing `/usr/local/bin/instabox-computer-use`,
  which hardcodes `export DISPLAY=:1`. `mcp-computer-use-qa.service`
  runs it on port 8897. The QA proxy's control file is
  `/run/user/1000/qa/instabox-control` (separate lock, so a :1 takeover
  never blocks the QA agent and vice versa).
- **QA DriverCard:** `working/workspaces/QwenPaw_QA_Agent_0.2/drivers/
  mcp/computer-use.yaml` (reference copy `computer-use-qa.yaml` here),
  SSE `http://172.18.0.1:8897/sse`, same `effect: allow` policy as the
  default card, description adapted to the private :2 screen (narrate
  actions + raise needs-you). Hot-reloads via `driver_config_watcher`.
- **Bridge:** `POST /desktop-open {"url", "agent": "qa"}` opens on :2
  with a separate Chromium profile
  (`--user-data-dir=/data/home/.config/chromium-qa` — two Chromiums
  sharing one profile fight over the singleton lock) and the :2 bus.
- **Per-computer lease + generation:** the Worker lease/generation are
  now per-computer (`lease:default` / `lease:qa`,
  `generation:default` / `generation:qa` in KV; the old un-suffixed
  keys are legacy and no longer written). `__takeover` / `__heartbeat` /
  `__release` take `{computer}`, `__lease` takes `?computer=`,
  capabilities carry `computer` and are checked against that
  computer's lease/generation. The lease-watcher polls BOTH and mirrors
  each to its own control file; it also uploads a per-computer preview
  (`preview:default` / `preview:qa`).
- **Verification (live):** QA proxy `list_apps` shows ONLY :2 apps
  (Chromium pid 111374 + xfwm4 pid 109672); RFB split on :2 (view 5903
  ignores the pointer, control 5904 moves it); QA Chromium screenshot
  1920x1048, 712 KB, distinct from the :1 screenshot. **Lease
  end-to-end (live, via KV write):** qa lease → watcher wrote
  `/run/user/1000/qa/instabox-control` (renewed every 5 s, epoch tracks
  now), :1 control file stayed absent, QA `click` refused with the
  exact refusal text, :1 `click` passed through; lease deleted → file
  cleared after the ~60 s KV stale-read window, QA `click` passed
  again. **Harness 22–24 cover the same logic** (independence,
  heartbeat/release per-computer, capability routing to 6084/6085).
- **Desktop Chromium is now a service:** the bridge restarts at
  23:23 IST killed the :1 Chromium (it was a bridge subprocess;
  `start_new_session=True` does NOT protect it — systemd kills by
  cgroup, not process group). `desktop-chromium.service` (in this
  folder) now owns the :1 Chromium (wordsolverx.com, session-bus env);
  a bridge restart was re-tested and the Chromium (same pid 104998)
  survived. The bridge's `/desktop-open` is now just a tab-opener when
  Chromium is already running (Chromium singleton behaviour).

### Teach-by-showing

- Worker: `POST /desktop/__teach` (cookie-gated; saves `{id, name,
  goal, playbook, events}` to KV `teach-skill:<id>`; server-side
  `sanitizeTeachEvents` mirrors Rakazo's `sanitizeTeachRecordingEvent`
  — sensitive events lose key/text, cap 500 events);
  `GET /desktop/__pending-skills` + `POST /desktop/__pending-skills/ack`
  (sync-token gated, for the watcher).
- Chrome: "Teach a task" button (visible only while holding control);
  teaching bar (goal input, Sensitive checkbox, "Stop & draft skill");
  the noVNC shim forwards pointer/key/scroll/clipboard events to the
  parent as `qwenpawTeachEvent` while teaching (never preventDefaults;
  while Sensitive is on, key/clipboard VALUES are never sent); draft
  editor modal with the 8 Rakazo fields (Name / When to use / Inputs /
  Steps / How to check / What to return / Approval boundaries / Failure
  handling) + Save / Test / Add to routine. Save → `POST
  /desktop/__teach`. Test → copies `formatSkillRunPrompt(name,
  playbook, test=true)` to clipboard + opens `/chat` in a new tab. Add
  to routine → POSTs to the routines Worker `/api/routines` with
  `X-Routine-Token` from localStorage (prompts the user to paste
  ROUTINE_WEBHOOK_TOKEN once; stored only in the browser).
- Watcher: every 30 s fetches pending taught skills and delivers each
  to the skill pool. **Two bugs found by testing, fixed:** (a) the
  SKILL.md frontmatter `name` MUST equal the skill-pool directory name
  — `qwenpaw skills enable <name>` looks the skill up by that name.
  (b) Installing only to the pool leaves the skill invisible — the
  default workspace's `skills/` dir holds IDENTICAL COPIES of pool
  skills, and `qwenpaw skills list` reads the workspace registry. The
  watcher installs to BOTH `skill_pool/<slug>/` and
  `workspaces/default/skills/<slug>/` (via `sudo install`; never
  hand-edit `skill.json`). Verified: test skill
  `taught-test-taught-skill` appeared in `qwenpaw skills list`
  (19 skills), then was disabled + removed (cleaned up).
- **Harness 27** covers save/list/ack + sensitive-event redaction.

### Needs-you flow

- Worker: `GET /desktop/__needs-you` (cookie-gated), `POST
  /desktop/__needs-you` (sync-token gated — the bridge raises it),
  `POST /desktop/__needs-you/resolve {action:"skip"|"done"}`
  (cookie-gated). KV key `needsyou`.
- Bridge (`/data/home/camoufox/bridge/bridge.py`, machine-only by
  convention): `POST /needs-you` — a plain function `raise_needs_you`
  (NOT via `WORKER.call()`, no browser needed) that POSTs to the Pages
  Worker with `X-Desktop-Sync`. **Bug found by testing, fixed:**
  Python urllib's default UA is 403'd by Cloudflare on the Pages
  domain — the bridge's forward now sends `User-Agent:
  qwenpaw-bridge/1.0`. Verified: bridge POST (with BRIDGE_TOKEN) →
  `{"ok": true, "record": {...}}` → KV `needsyou` confirmed; unauth
  bridge POST → 401. Test record deleted after verification.
- Chrome: needs-you banner under the header (polls every 10 s; agent
  text + live preview image from `/desktop/__preview` + Skip / I'm
  done / Take control). Skip/I'm done clears the record and toasts
  "Tell the agent in chat: 'skip that step' / 'done, continue'" — the
  Worker cannot message the agent directly (the agent reads only the
  console); this honest limitation is stated in the UI and the code.
- DriverCard description (both cards) now instructs the agent: when
  blocked, `curl -X POST http://172.18.0.1:8899/needs-you -H
  'Authorization: Bearer $CAMOUFOX_BRIDGE_TOKEN' ...` and wait. Policy
  unchanged (`effect: allow`). **Harness 25** covers raise/GET/resolve
  + auth.
- **Bug found by the harness (2026-11-15):** `POST /desktop/__mode`
  read the request body TWICE (`readJsonBody` for the agent, then
  again for the mode) — the second read returns `{}` because the
  stream is consumed, so the mode always fell back to "team".
  Fixed in `_worker.js` (read once, reuse). No other double-read in
  the Worker (scanned).

### Terminal tab

- `pty-server.py` (in this folder, stdlib-only): binds
  `/run/user/1000/terminal.sock`, one login shell per connection, cwd
  `/data/home`; frame protocol `[kind:u8][length:u32be][payload]`
  (kind 0 stdin, kind 1 resize cols/rows u16be), output raw bytes —
  a direct mirror of Rakazo's `terminal-server.ts`.
  `desktop-terminal.service` + `desktop-terminal-ws.service`
  (websockify `127.0.0.1:6083 --unix-target=...`). Port 6083 published
  **private** (pv-nu32td2toobnaoni5dzpipc2nm); token = Worker secret
  `DESKTOP_TERMINAL_TOKEN` on both projects.
  **6083 publish incident:** the first publish used `{"port": 6083,
  "public": false}` and came back `access: "public"` with NO token —
  a public websockify endpoint serving a login shell with no auth,
  exposed for ~1 minute (URL never shared). Fixed immediately by
  re-creating with `{"port": 6083, "access": "private", ...}`. **Rule:
  the publish field is `"access": "private"`, never `"public":
  false`.**
- Worker: `DESKTOP_TERMINAL_ORIGIN` + mode "terminal" in
  `verifyCapability` (requires a live lease, like control) +
  `desktopSession` routes it. Chrome terminal tab uses xterm.js
  (vendored `pages/public/vendor/xterm.js` 5.3.0 + `xterm.css`,
  served via `/desktop/vendor/*` from the ASSETS binding — the
  Worker's `desktop()` router intercepts all `/desktop/*`, so the
  vendor files cannot be plain static assets). Shows "Take control to
  use the terminal" + Take control button when the user does not hold
  control. Verified: raw WebSocket to 6083 → 101; a BINARY frame
  carrying `echo hello-terminal` got the shell echo back. (A TEXT
  frame is rejected by websockify — the xterm.js client sends binary
  frames, so this is correct, not a bug.) **Harness 29 + 31** cover
  the capability + the vendor files.

### Side-panel preview beside chat

- The console SPA HTML is proxied by the Worker, and its CSP is only
  `frame-ancestors 'self'` — NO script-src — so an injected
  same-origin `<script>` runs. The SPA marker is `<div id="root"`
  (verified in the live HTML). The injected script appends a floating
  "Computer" button + a 316px right sidebar panel (iframe to
  /desktop) to `document.body`, OUTSIDE React's `#root`, so React
  re-renders can never remove it. Implemented in `proxy()`: for GET
  200 text/html responses containing the SPA marker, inject
  `consolePanelScript()` before `</body>` (defensive try/catch,
  feature-detects `#root`, no-ops if already injected; open/closed
  state in sessionStorage; "Open full" link to /desktop). API JSON,
  SSE streams and assets are untouched. **Harness 30** covers
  injection on the SPA + no injection on API JSON / /status.
  **NOT yet verified in a real browser** — needs the parent's
  logged-in check that the console still loads and the panel appears.

### Chat tool-call display

- The console already lists tool calls inline with per-call status
  ("Completed N steps", expandable) — the gap vs Rakazo's inline
  per-call succeeded/failed list is small and the console's React
  rendering cannot be changed without rebuilding the image. The lever
  that works is the agent instruction: both DriverCards' `description`
  now tells the agent to narrate each desktop action in chat with its
  result, and to raise needs-you when blocked. Policy unchanged.
  Reference copies `computer-use.yaml` / `computer-use-qa.yaml` in
  this folder are synced to the live cards.

### Screen generations + preview in chat

- Generation counter is per-computer in KV (bumped on
  takeover/release, capability-checked) — see "Per-bot computer"
  above.
- Preview: the watcher captures `:1` AND `:2` via scrot every 15 s
  and POSTs the PNGs to `/desktop/__preview-upload?computer=<name>`
  (sync-token gated, 60 s TTL in KV, max 2 MB);
  `GET /desktop/__preview?computer=<name>` (cookie-gated) returns
  the PNG. Verified: KV holds `preview:default` + `preview:qa`. The
  needs-you banner and the side-panel preview use it. The QwenPaw
  chat itself cannot show the preview image without a console patch
  (needs a rebuild) — the preview is shown in the /desktop banner
  and the injected side panel instead; this limit is stated honestly.
  **Harness 26** covers upload/GET per computer + auth.

### Shared infrastructure (extension)

- `DESKTOP_SYNC_TOKEN`: a NEW shared secret for the bridge↔Worker
  and watcher↔Worker channel (NOT an InstaBox or Cloudflare key). Set
  as a Worker secret on both Pages projects (per-key PATCH merges —
  the other secrets survived). Written to
  `/data/home/camoufox/.env` (bridge EnvironmentFile) and
  `/data/home/mcp-proxy/.env` (chmod 600). **Its value must NOT be
  written to git, memory, or reports.** The Worker checks it with a
  constant-time-ish compare on header `X-Desktop-Sync`.
- Worker new KV keys (all in DESKTOP_KV): `needsyou`,
  `preview:default` / `preview:qa` (60 s TTL), `teach-skill:<id>`,
  `computerMode:<agent>`, plus the per-computer `lease:<computer>` /
  `generation:<computer>`.
- **Token rotation (2026-11-15):** the first QA publish tokens were
  briefly exposed in a tool-call error output (a Python syntax error
  echoed the PATCH body). Both QA publishes were deleted (DELETE
  `/v1/machines/{id}/ports/{port}` — the DELETE returns an empty
  204, which the JSON parser reports as "not valid JSON"; the
  publishes were confirmed gone) and re-created with fresh tokens
  (6084 pv-6dnnzvsqjqzfrbwsida6d45x3q, 6085
  pv-zcqckhcx6ezqvm5elgvtbxx4mm), then set as Worker secrets. The
  exposed values are dead.
- **Still needs the parent's real browser:** (a) logged-in /desktop
  — new overlay chrome renders and stays rendered (teach button
  appears only with control; terminal tab; Team/Private select);
  (b) Take control flow (pill, heartbeat, release, held frame);
  (c) Teach a task end-to-end (record → draft editor → Save → skill
  appears in the console; Test copies the run prompt; Add to routine
  with the token); (d) needs-you banner when the agent raises it
  (needs a real blocked-browser session); (e) terminal tab opens a
  shell; (f) side-panel "Computer" button + 316px panel beside the
  chat, console still loads normally; (g) Team→Private switch
  remounts the screen on :2.
- **Still flagged:** `INSTABOX_API_KEY` is UNSET as a Worker secret
  — the "…" maintenance endpoint returns 503 until it is set (then
  redeploy). Do NOT invent the key.

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
