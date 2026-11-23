# Camoufox install — server + desktop browser (verified live 2026-11-23)

Date: 2026-11-23. Machine `m_agq5wqqo2fvypym7rjlpvngc2m` (InstaBox Free,
Debian 13). This is the reproduce-from-scratch record for the Camoufox
install done live on 2026-11-23 (server + desktop switch + anti-detect
verification + TinyFish machine test). Nothing here is guessed — every step
below was run and verified live by Muse on 2026-11-23 ~11:4x–12:0x IST.

CORRECTION 2026-11-23 ~12:1x IST: an earlier version of this file claimed
Chromium had been removed (package removal, "/usr/bin/chromium no longer
exists") and described a TinyFish test with different run IDs, query, and
install location. Those claims were WRONG — verified live: Chromium is
still installed (see §3), and the TinyFish test in §6 is the one Muse
actually ran. Do not trust the earlier version.

## Source (confirmed by Rohan)

- **Fork:** `https://github.com/gogibeta/camofox-browser` — gogibeta's fork
  of `jo-inc/camofox-browser`. Do NOT use upstream `daijro/camoufox` for
  this server (the daijro install at `/data/home/camoufox/` is the
  separate automation bridge on port 8899 — do not touch it).
- Live checkout: `/data/home/camofox-browser`, `npm start` = `node server.js`,
  Node v22.20.0, node_modules 456 entries (`npm install --ignore-scripts`
  exit 0; plain `npm install` fails — a transitive `openclaw` preinstall
  requires Node >=24.16.0 <25 || >=26.1.0).
- Engine binary (verified live, running since Nov 16):
  `/data/home/camoufox/cache/camoufox/browsers/official/158.0.1-beta.41-3f2eb1d0/camoufox-bin`.

## 1. Install the server

```bash
cd /data/home
git clone https://github.com/gogibeta/camofox-browser.git camofox-browser
cd camofox-browser
npm install --ignore-scripts   # plain npm install fails (openclaw preinstall needs Node >=24)
```

## 2. Start the server (port 9377)

```bash
cd /data/home/camofox-browser
nohup node server.js > server.log 2>&1 &
```

Verify (all must be 200):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9377/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9377/
```

`/` returns e.g.
`{"ok":true,"enabled":true,"running":true,"engine":"camoufox","browserConnected":true,"browserRunning":true}`.
`/health` returns the same plus `activeTabs`, `activeSessions`,
`consecutiveFailures`, and `memory` (rss/heap/native/cgroup).

Auto-start (verified enabled 2026-11-23): a systemd user service
`~/.config/systemd/user/camofox-browser.service`
(`ExecStart=/usr/local/bin/node server.js`, `Restart=on-failure`,
`WantedBy=default.target`). Note: Node is at `/usr/local/bin/node`,
not `/usr/bin/node`.

### API (verified live 2026-11-23)

Every call below was run live against port 9377 and returned 200:

- `GET /` and `GET /health` — no auth, no params.
- `POST /tabs/open` — body `{"userId": "test", "url": "https://example.com"}`
  → `{"ok":true,"targetId":"...","tabId":"...","url":"https://example.com/","title":"Example Domain"}`.
- `GET /tabs?userId=test` — lists open tabs (`running: true`, tabId/url/title).
- `POST /tabs/{tabId}/evaluate` — body `{"userId": "test", "expression": "..."}`
  → `{"ok":true,"result":"..."}`. (`userId` is REQUIRED in the body;
  without it the server returns `{"error":"userId is required"}`.)
- `DELETE /tabs/{tabId}?userId=test` → `{"ok":true}`.

### Memory-pressure restart (expected behaviour, not a failure)

The server restarts its browser when browser RSS exceeds 1500 MB
(log: `"browser rss pressure, restarting browser"`). During that restart
`/health` briefly returns a non-ok state; afterwards it returns 200 with
`browserConnected: true, browserRunning: true`. Do not treat a single
non-ok `/health` as the server being down — re-check `/health`.

## 3. Desktop browser switch (Chromium → Camoufox)

The desktop browser is **Camoufox**, not Chromium (verified live
2026-11-23 ~11:5x IST). A `.desktop` launcher was created and set as the
system default web browser:

```bash
# /data/home/.local/share/applications/camoufox.desktop
[Desktop Entry]
Version=1.0
Name=Camoufox
Comment=Stealth web browser (Firefox-based, anti-detect)
Exec=/data/home/camoufox/cache/camoufox/browsers/official/158.0.1-beta.41-3f2eb1d0/camoufox-bin %u
Terminal=false
Type=Application
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
StartupNotify=true

DISPLAY=:1 xdg-settings set default-web-browser camoufox.desktop
DISPLAY=:1 xdg-settings get default-web-browser   # → camoufox.desktop
```

Verify the window exists:

```bash
DISPLAY=:1 /data/home/camoufox/cache/camoufox/browsers/official/158.0.1-beta.41-3f2eb1d0/camoufox-bin https://example.com &
DISPLAY=:1 xwininfo -root -tree | grep -i camoufox
# → 0xe00003 "Example Domain — Camoufox": ("Navigator" "camoufox")  823x428+0+28
```

The old Chromium desktop process (PID 104998, Nov 16) is gone, and no
autostart entry launches it (`/data/home/.config/autostart/` is empty;
the XFCE panel launcher-1 has no browser entry).

### Chromium removal — HELD, NOT done (2026-11-23 ~12:0x IST)

Chromium is **still installed** on the host (`dpkg -l` → `ii chromium
156.0.8078.79-1~deb13u1`, `/usr/bin/chromium` exists) and in the
container. It was deliberately NOT removed:

- The headless-render scripts Muse uses to visually verify the console
  (`/data/home/qwenpaw/mobile-check/probe*.py`) run Playwright with
  `executable_path='/usr/bin/chromium'`. Removing the host binary breaks
  Muse's only visual-verification path.
- The container's `/usr/bin/chromium` is baked into the qwenpaw image
  and is the container Playwright's `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

The DESKTOP no longer uses Chromium — Camoufox is the desktop browser
and the default. Chromium now serves only as a headless render engine.
Removal waits for the render scripts to migrate to Camoufox. Do NOT
remove the package until that migration is done and verified.

### Window-size note (minor, open)

Both Chromium and Camoufox render at **823x428** on this display
(the Xvnc `:1` display is 1920x1080). `xdotool windowsize` /
`windowmove` and `--start-maximized` did not enlarge it, and F11 only
raised the height to 504. This is a display/window-manager quirk that
affected Chromium identically — not a Camoufox defect. The browser is
usable; maximising it to fill the screen is still an open polish item.

## 4. Do NOT break (verified still working after the switch)

- **Automation bridge on 8899** (daijro/camoufox install at
  `/data/home/camoufox/`, `bridge/bridge.py`, browser PID separate from
  the GUI launch): `curl http://127.0.0.1:8899/health` → **200**.
- **noVNC 6080–6085**: all return **200**.
- **Camoufox server 9377**: `/health` 200, `ok: true`.
- **QwenPaw container**: `qwenpaw` (`qwenpaw-agentx:2.3.0-source7`) still Up.

## 5. Anti-detect verification (T3.6, live 2026-11-23 ~12:0x IST)

Loaded `https://bot.sannysoft.com/` through the Camoufox server
(`POST /tabs/open`, 200, title "Antibot"). Evaluated
`document.body.innerText` — the page's own verdicts:

- User-Agent: `Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0`
- **WebDriver (New): "missing (passed)"**
- **WebDriver Advanced: "passed"**
- Plugins Length: 5, PluginArray: passed
- PHANTOM_UA / PHANTOM_PROPERTIES / PHANTOM_ETSL: ok
- "Chrome (New) missing (failed)" is expected — that test is
  Chrome-specific, not a bot signal for a Firefox-based browser.

A plain headless Chromium exposes `navigator.webdriver` and fails the
WebDriver test; Camoufox does not. Anti-detect works.

## 6. TinyFish machine live test (2026-11-23 ~11:46 IST, verified live)

Monid CLI installed **on the machine host only**
(`npm install -g @monid-ai/cli@latest`, v0.1.9, `/opt/node/bin/monid`;
the host PATH does not include `/opt/node/bin`, so use the full path).
It was NOT installed inside the QwenPaw container.

The key (`TINYFISH_API_KEY`) is stored **encrypted** (`ENC:`) in
`working.secret/envs.json`. It was decrypted inside the container with
Qwenpaw's own `_get_fernet()` (`docker exec qwenpaw
/app/venv/bin/python3`), copied to the host as a 0600 temp file, and
used through the skill's private-`XDG_CONFIG_HOME` bootstrap (0700 temp
dir, 0600 credential files, deleted afterwards). The key never entered
argv and was never printed (only length 35 + prefix "moni" reported).

Results (real key, from the machine, 2026-11-23 ~11:46 IST):

- `/free/search` — **COMPLETED**, runId
  `01M83GS7869V6M7PR6NNBNXPV3`, Provider Response 200. Query "QwenPaw
  agent framework" returned real results (github.com QwenPaw/AgentScope
  snippet).
- `/free/fetch` — **COMPLETED**, runId
  `01M83GSAHKD0FS3DMAT1FPGKFM`, Provider Response 200.
  `https://example.com` → title "Example Domain", real text.
  **Price: `$0.00`** for both (free tier).

Only the two free endpoints were called. The paid `/search` (`$0.00175`)
and `/fetch` (`$0.001`) are hard-blocked by the skill and were never used.

Still to verify (needs a live browser — not done here): run a TinyFish
search + fetch from a real console chat. The Settings → Your Keys section
was browser-verified 2026-11-23 ~12:0x IST (TinyFish/Monid password field,
placeholder "Paste your Monid API key (from app.monid.ai)", page renders
clean at 1920x1080).
