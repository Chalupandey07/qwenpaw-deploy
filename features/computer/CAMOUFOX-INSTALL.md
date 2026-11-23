# Camoufox install — server + desktop browser (verified live 2026-11-23)

Date: 2026-11-23. Machine `m_agq5wqqo2fvypym7rjlpvngc2m` (InstaBox Free,
Debian 13). This is the reproduce-from-scratch record for the Camoufox
install done live on 2026-11-23 (server + desktop switch + Chromium removal
+ TinyFish machine test). Nothing here is guessed — every step below was
run and verified live.

## Source (confirmed by Rohan)

- **Fork:** `https://github.com/gogibeta/camofox-browser` — gogibeta's fork
  of `jo-inc/camofox-browser`. Do NOT use upstream `daijro/camoufox` for
  this server (the daijro install at `/data/home/camoufox/` is the
  separate automation bridge on port 8899 — do not touch it).
- Live checkout: `/data/home/camofox-browser`, commit `fe8004f`,
  package `@askjo/camofox-browser` v1.19.0, `npm start` = `node server.js`.

## 1. Install the server

```bash
cd /data/home
git clone https://github.com/gogibeta/camofox-browser.git camofox-browser
cd camofox-browser
npm install        # node_modules already present on first install (456 entries)
```

On first launch the server **downloads the Camoufox browser binary
automatically** (~1.31 GB) into `/data/home/.cache/camoufox/` (contains
`camoufox-bin`, `browser/`, `camoufox.cfg`, `version.json`).

## 2. Start the server (port 9377)

```bash
cd /data/home/camofox-browser
nohup node server.js > server.log 2>&1 &
```

Verify (all must be 200):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9377/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9377/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9377/openapi.json
```

`/health` returns JSON, e.g.
`{"ok":true,"engine":"camoufox","browserConnected":true,"browserRunning":true,...}`.

### API (verified)

- `POST /tabs` — body **must** include `userId` + `sessionKey`
  (a bare POST returns `{"error":"userId and sessionKey required"}`):
  `{"userId":"test","sessionKey":"test-session","url":"https://example.com"}`
  → `{"tabId":"...","httpStatus":200,"navigationOk":true}`.
- `GET /tabs/:tabId/snapshot?userId=…&sessionKey=…` → page snapshot
  (real content; example.com returned English/Arabic/Chinese/French/
  Russian/Spanish paragraphs + "Learn more" link).

### Memory-pressure restart (expected behaviour, not a failure)

The server restarts its browser when browser RSS exceeds 1500 MB
(log: `"browser rss pressure, restarting browser"`,
`browserRssMb: 1634, thresholdMb: 1500`). During that restart `/health`
briefly returns **503**; afterwards it returns 200 with
`browserConnected: true, browserRunning: true`. Do not treat a single
503 as the server being down — re-check `/health`.

## 3. Desktop browser switch (Chromium → Camoufox)

Launch the Camoufox GUI on the desktop display `:1`:

```bash
DISPLAY=:1 /data/home/.cache/camoufox/camoufox-bin \
  --profile /data/home/.camoufox/desktop-profile \
  --no-first-run --start-maximized https://wordsolverx.com &
```

Verify the window exists and is the only browser:

```bash
DISPLAY=:1 xwininfo -root -tree | grep -i camoufox
ps aux | grep camoufox-bin | grep -v grep
```

### Remove Chromium (this is what stops it coming back)

Killing the Chromium process alone does **not** work — the InstaBox
template/init supervisor relaunches it within minutes (observed: a new
Chromium process with the identical command line reappeared after
`pkill`). Remove the package instead:

```bash
sudo apt-get remove -y chromium chromium-common
```

This freed 400 MB and the binary is gone (`/usr/bin/chromium` no longer
exists), so the supervisor can no longer relaunch it. After removal the
window list shows only Camoufox windows and no live Chromium processes
remain (only defunct/zombie entries, which are harmless).

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
  the GUI launch): `curl http://127.0.0.1:8899/` → **401** (up and
  enforcing auth — expected; an earlier "healthy 200" was with a token).
- **noVNC 6080–6085**: all return **200**.
- **Camoufox server 9377**: `/health` 200, `ok: true`.
- **QwenPaw container**: `qwenpaw` (`qwenpaw-agentx:2.3.0-source7`) still Up.

## 5. Anti-detect verification (T3.6, live 2026-11-23)

Loaded `https://bot.sannysoft.com/` through the Camoufox server
(tab created, 200, `navigationOk: true`). Snapshot shows:

- User-Agent: `Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0`
- **WebDriver (New): "missing (passed)"**
- **WebDriver Advanced: "passed"**
- Plugins Length: 5, PluginArray: passed
- "Chrome (New) missing (failed)" is expected — that test is
  Chrome-specific, not a bot signal for a Firefox-based browser.

## 6. TinyFish machine live test (2026-11-23, same session)

Monid CLI installed **inside the QwenPaw container**
(`docker exec qwenpaw npm install -g @monid-ai/cli@latest`, v0.1.9,
`/usr/local/bin/monid`). Host also has it at `/opt/node/bin/monid`
(npm prefix `/opt/node` — add that to PATH or use the full path).
Note: the container install does **not** survive an image rebuild —
bake `@monid-ai/cli` into the next image (source8) for permanence.

The key (`TINYFISH_API_KEY`) is stored **encrypted** (`ENC:`) in
`working.secret/envs.json`. It is decrypted at runtime by QwenPaw's own
`load_envs()` and synced into the agent process `os.environ`; a fresh
`docker exec` process does **not** see it (and `/proc/<pid>/environ`
only shows the startup environment). The live test used QwenPaw's own
`load_envs()` inside the container to obtain the decrypted key, then
the skill's private-`XDG_CONFIG_HOME` bootstrap (0700 temp dir, 0600
credential files, deleted afterwards). The key never entered argv and
was never printed.

Results (real key, from the machine, 2026-11-23 ~12:04 IST):

- `/free/search` — **COMPLETED**, runId
  `01M83G3DH7ZM8HH6WADZ6ZYJX5`. Query "Camoufox browser
  anti-detection" returned real results (camoufox.com, github.com, …).
- `/free/fetch` — **COMPLETED**, runId
  `01M83G3GVXSFZE7D53PGRH2Y92`. `https://example.com` → title
  "Example Domain", real text, latency ~943 ms, `errors: []`,
  httpStatus 200. **Price: `$0.00`** (`price.value: 0 USD`,
  `billing.reportedCost.value: 0 MICRO_DOLLAR`).

Only the two free endpoints were called. The paid `/search` (`$0.00175`)
and `/fetch` (`$0.001`) are hard-blocked by the skill and were never used.

Still to verify (needs a live browser — not done here): run a TinyFish
search + fetch from a real console chat, and check the Settings → Search
section still shows the key field and saves correctly.
