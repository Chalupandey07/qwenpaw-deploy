# Camoufox × QwenPaw — implementation (2026-11-15)

QwenPaw's browser SDK is Chromium-only by construction and **cannot** be
pointed at Camoufox directly (see `../camoufox-research-2026-11-15.md` for
the full seam analysis). This directory is the implemented bridge:
Camoufox runs on the host, the QwenPaw agent drives it over HTTP, and the
browser draws on a VNC display the user can watch.

Status: **working end to end.** x.com loads through the bridge (the old
Chromium browser got HTTP errors there); the public @0xSatwik profile
returns real posts.

## What lives where (on the machine)

| Thing | Location |
|---|---|
| Camoufox venv (Python 3.13, Playwright 1.62.0) | `/data/home/camoufox/.venv` (289 MB) |
| Camoufox browser + GeoIP (v158.0.1-beta.41) | `/data/home/camoufox/cache` (2.5 GB) |
| Bridge service | `/data/home/camoufox/bridge/bridge.py`, systemd `camoufox-bridge.service` |
| Bridge token (chmod 600, **never in git**) | `/data/home/camoufox/.env` (`BRIDGE_TOKEN=…`) |
| Persistent browser profile (logins survive restarts) | `/data/home/camoufox/profile` (77 MB) |
| Screenshots | `/data/home/camoufox/shots/` (+ copy in the QwenPaw workspace media dir) |
| VNC display | Xvnc `:99` 1920x1080, systemd `camoufox-vnc.service` |
| VNC password (obfuscated file + plain copy, chmod 600, **never in git**) | `/data/home/camoufox/.vnc/passwd`, `/data/home/camoufox/.vnc/passwd-plain` |
| noVNC (websockify, localhost-only) | `http://127.0.0.1:6080/vnc.html`, systemd `camoufox-novnc.service` |
| QwenPaw skill | `working/skill_pool/camoufox-browser/SKILL.md` + `working/workspaces/default/skills/camoufox-browser/SKILL.md`, enabled in `working/workspaces/default/skill.json` |
| Bridge token in QwenPaw | encrypted env store: `CAMOUFOX_BRIDGE_TOKEN` (`qwenpaw env set`) |

All services are `Restart=always`, `WantedBy=multi-user.target`, so they
come back after a VM pause/reboot. The bridge waits on the VNC service
(`After=camoufox-vnc.service`) because it draws on `:99`.

## Install sizes (measured, 2026-11-15)

- Disk before: `/` 9.2G avail, `/data` 16G avail.
- Disk after: `/` 8.5G avail, `/data` 13G avail.
- `camoufox fetch` download: **1.3 GB** (much bigger than the 150–350 MB
  research estimate — the Firefox build is large), plus 52.9 MB GeoIP DB.
- venv 289 MB (Camoufox 0.5.9, Playwright 1.62.0, fpgen 1.3.0, numpy…).
- `playwright install-deps firefox`: 40 system packages on `/` (~0.4 GB:
  libasound2, libatk, libdrm, mesa, fonts, ffmpeg libs, …).
- `novnc` 1.6.0 + `websockify` 0.12.0 + `tigervnc-tools` 1.15.0 (for the
  `tigervncpasswd` utility) via apt.
- Total Camoufox footprint on `/data`: ~2.9 GB.

## How the bridge works (Option B)

`bridge.py` is stdlib-only (no FastAPI). One persistent Camoufox/Firefox
browser lives in the process (persistent context, `user_data_dir` =
`/data/home/camoufox/profile`), so cookies/logins survive restarts.

**Threading rule (learned the hard way):** Playwright's sync API is
single-threaded — its greenlets are bound to the creating thread. All
browser calls run on ONE dedicated worker thread behind a job queue;
HTTP handler threads only enqueue work. Calling `page.*` from a handler
thread fails with `Cannot switch to a different thread` (see Bugs).

**Binds:** `127.0.0.1:8899` and the Docker gateway `172.18.0.1:8899`
(the `qwenpaw` container reaches it at `http://172.18.0.1:8899`).
Never publish this port publicly. Every endpoint except `GET /health`
needs `Authorization: Bearer $CAMOUFOX_BRIDGE_TOKEN`.

| Endpoint | What it does |
|---|---|
| `GET /health` | `{ok, browser_alive, title, url}` — no auth |
| `POST /goto` `{url, timeout_ms?, wait_until?}` | Navigate; returns title/url/HTTP status |
| `POST /snapshot` `{max_chars?}` | Visible body text (`inner_text`, falls back to HTML) |
| `POST /screenshot` `{name?, include_b64?}` | PNG to `/data/home/camoufox/shots/` **and** copied to `/app/working/workspaces/default/media/` so the agent/user can see it in the console |
| `POST /click` `{by: css\|text\|role\|label\|placeholder, value, name?}` | Click a locator |
| `POST /fill` `{selector?, by?, value}` | Fill a field |
| `POST /eval` `{expression}` | `page.evaluate` |
| `POST /state` | Current title + url |
| `POST /restart` | Relaunch the browser |
| `POST /desktop-open` `{url}` | Open the URL in the InstaBox desktop Chromium (display `:1` — the screen the user watches). New tab if Chromium is already running. Added 2026-11-15; verified live with example.com opening as a second tab next to wordsolverx.com. See `features/desktop/README.md`. |
| `GET /latest.png?token=…` | Latest screenshot (PNG) |
| `GET /watch?token=…` | Auto-refreshing (5 s) screenshot page |

## How the agent calls it

The `camoufox-browser` skill (`skills/camoufox-browser/SKILL.md`) tells
the agent to use `curl` from inside the container:

```bash
B=http://172.18.0.1:8899
H="Authorization: Bearer $CAMOUFOX_BRIDGE_TOKEN"
curl -fsSL -H "$H" -H 'Content-Type: application/json' \
  -d '{"url":"https://x.com/"}' $B/goto
curl -fsSL -H "$H" -H 'Content-Type: application/json' \
  -d '{"max_chars": 8000}' $B/snapshot
```

Registration was verified with QwenPaw's own registry code
(`resolve_effective_skills` on the default workspace): with the token
present, `camoufox-browser` is in the effective skill list (16 skills)
with **no** "Skipping skill" error; without the token it is correctly
skipped (`Environment variable not set: CAMOUFOX_BRIDGE_TOKEN`).
The skill was added to both manifests via QwenPaw's
`reconcile_pool_manifest()` / `reconcile_workspace_manifest()`, then
`enabled: true` in `working/workspaces/default/skill.json`
(reconcile defaults new skills to disabled — that flag is preserved on
later reconciles). **Still to confirm:** the next real agent build in
the running daemon picks the skill up (it reads the env store at build
time); no container restart was done, by design.

## x.com verification (live, 2026-11-15 ~21:15–21:20 UTC)

Direct Camoufox smoke test (`smoke.py`, `smoke-results.json`):

- `https://x.com/` → 200, title `X. It's what's happening / X`
  (logged-out landing page — expected without an X login).
- `https://x.com/0xsatwik` → 200, title
  `Satwik Samanta (@0xSatwik) / X`, snapshot shows the real bio
  (4,959 posts, 894 Following, 605 Followers) and real posts from
  Nov 11 / Nov 9. This is the page the old Chromium browser could not
  open at all.
- `https://x.com/search?q=0xsatwik` → 200 but redirected to the login
  onboarding (`/i/jf/onboarding/web?redirect_after_login=…`) — **search
  needs a logged-in X session**. No login was attempted.

Through the finished bridge (skill → bridge → Camoufox), same results:
`goto` x.com 200, `goto` x.com/0xsatwik 200 with full post text in
`snapshot`, screenshots at
`/data/home/camoufox/shots/20261114-212023-vnc-x-profile.png` and
`/app/working/workspaces/default/media/20261114-212023-vnc-x-profile.png`.

## Watchable screen

- **Live display exists on the machine:** Xvnc `:99` (1920x1080x24),
  and the bridge browser draws on it — `xlsclients -display :99`
  shows the `camoufox` window. noVNC serves it at
  `http://127.0.0.1:6080/vnc.html` (200, `<title>noVNC</title>`,
  websocket upgrade → `101 Switching Protocols`). VNC auth was
  verified end to end with an independent RFB client (challenge–
  response against the password file: pass; wrong-key control: fail).
- **But it is not publicly reachable — exact blocker:** InstaBox Free
  publishes exactly one port per machine through its proxy
  (`127.0.0.1:8088` → the public `…instabox.tech` URL). The machine
  API record exposes no port-publishing option, and Cloudflare Tunnel
  is not viable on Free (the VM pausing kills `cloudflared`). VNC
  (5999), noVNC (6080) and the bridge (8899) all listen on loopback /
  the Docker gateway only, by design. There is no public URL for the
  live desktop today.
- **Closest working alternative (delivered):** the bridge's
  `GET /watch?token=…` page auto-refreshes the latest screenshot
  every 5 s, and every `/screenshot` is also copied into the QwenPaw
  workspace media dir, so the agent can show it in chat and the user
  can see it in the console. If the user has SSH access to the machine,
  `ssh -L 6080:127.0.0.1:6080 <machine>` then opening
  `http://localhost:6080/vnc.html` with the VNC password gives the
  true live screen.

## Option C verdict: NOT viable as-is (proven, not assumed)

`camoufox.server.launch_server(headless="virtual", port=1234,
ws_path="camoufox", host="172.18.0.1")` runs fine, and a matching
Playwright 1.62 client connects and loads pages. But the container's
Playwright **1.65** client is hard-rejected by the 1.62 server:

```
BrowserType.connect: WebSocket error: ws://172.18.0.1:1234/camoufox
428 Precondition Required
Playwright version mismatch:
  - server version: v1.62
  - client version: v1.65
```

Two findings inside that: (1) `launch_server` binds `[::1]` by
default — the container gets `ECONNREFUSED` until `host="172.18.0.1"`
is passed (it forwards through to `playwright.firefox.launchServer`);
(2) the 1.62↔1.65 wire protocol is incompatible, so Option C would
need QwenPaw's Playwright downgraded to 1.62 (image change, fragile
across upgrades) — **do not pursue without that decision**. The test
server was stopped afterwards; nothing of Option C is left running.
Option B (this bridge) is the shipped path.

## Bugs found and fixed

1. **Firefox wouldn't launch: `libasound.so.2: cannot open shared
   object file`** — the host lacked Firefox's system libraries.
   Fixed with `playwright install-deps firefox` (after `apt-get
   update`; apt lists were empty). The `libnss3.so: version NSS_3.113
   / NSS_3.126 not found` lines in `ldd` output are a red herring —
   Camoufox bundles its own `libnss3.so` and the binary resolves it
   at runtime.
2. **Bridge greenlet crash: `Cannot switch to a different thread`** —
   Playwright sync API called from HTTP handler threads. Fixed by
   moving all browser work onto one dedicated worker thread with a
   job queue (see "Threading rule" above). Re-tested: health/goto/
   snapshot/screenshot/click-path all pass.
3. **Screenshot copy `Permission denied`** —
   `/data/home/qwenpaw/working/workspaces/default/media` was
   root-owned 755. Fixed with `chown user:user` on that one (empty)
   directory; the container runs as root so it is unaffected.
4. **VNC password file: hand-rolled DES didn't work** — all 8
   key/data/bit-reversal variants of the classic fixed-key DES
   scheme failed against TigerVNC 1.15. Fixed by installing
   `tigervnc-tools` and using the official `tigervncpasswd -f`
   (Debian names it `tigervncpasswd`, not `vncpasswd`). Verified with
   an independent RFB client.
5. **Skill silently absent until manifests reconciled** — dropping
   `SKILL.md` into `skill_pool/` is not enough; the skill must be in
   `skill.json` (pool + workspace) and `enabled: true`. Fixed via
   QwenPaw's own `reconcile_*_manifest()` + enabling the entry.

## What still needs the user

- **X login for search (and any logged-in X use):** search/profile
  actions that need a session redirect to login. Someone must log
  into X once inside the persistent Camoufox profile
  (`/data/home/camoufox/profile`) — via the VNC display once it is
  reachable, or by an operator-driven login flow. Never paste an X
  password into chat.
- **Live-screen access:** no public URL exists for VNC/noVNC (see
  blocker above). If the user has an SSH path to the machine, the
  tunnel command above works; otherwise the screenshot feed is the
  watch mechanism.
- **Next agent build:** confirm `camoufox-browser` appears in the
  agent's skills on the user's next chat (registry check already
  passes; this is the last live-build confirmation).
- **Secrets delivery:** the bridge token and the VNC password were
  delivered to the user only. They live in `/data/home/camoufox/.env`
  (600) and `/data/home/camoufox/.vnc/` (600) on the machine and in
  QwenPaw's encrypted env store. They are **not** in this repo, in any
  report, or in memory.

## Files in this directory

- `bridge/bridge.py` — the bridge service (stdlib-only).
- `skills/camoufox-browser/SKILL.md` — the QwenPaw skill.
- `systemd/camoufox-bridge.service` — bridge unit (draws on `:99`).
- `systemd/camoufox-vnc.service` — Xvnc `:99` unit.
- `systemd/camoufox-novnc.service` — websockify/noVNC unit.

## Ops

```bash
# status / logs
sudo systemctl status camoufox-bridge camoufox-vnc camoufox-novnc
sudo journalctl -u camoufox-bridge.service -f
# restart the bridge (browser profile persists)
sudo systemctl restart camoufox-bridge.service
# health (no auth) / authenticated smoke
curl -s http://127.0.0.1:8899/health
T=$(grep BRIDGE_TOKEN /data/home/camoufox/.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"url":"https://x.com/0xsatwik"}' http://127.0.0.1:8899/goto
```
