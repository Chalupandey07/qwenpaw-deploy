---
name: camoufox-browser
description: "Browse the web through Camoufox (anti-detect Firefox) via the local bridge service: open pages X.com blocks for plain Chromium, read page text, take screenshots, click and fill forms. Use whenever a normal browser fetch fails, X.com/Twitter blocks the page, or the user asks to browse with Camoufox. Requires the camoufox-bridge service on the host and CAMOUFOX_BRIDGE_TOKEN in the environment store."
version: "1.0"
metadata:
  qwenpaw:
    emoji: "🦊"
    requires:
      bins: ["python3", "curl"]
      env: ["CAMOUFOX_BRIDGE_TOKEN"]
---

# Camoufox Browser

Browse the web through **Camoufox** — a fingerprint-spoofing Firefox that
gets past blocks (notably X.com) where QwenPaw's built-in Chromium browser
gets an HTTP error. The browser runs on the host (not in this container)
and is driven through a small HTTP bridge.

## How it works

- Bridge service: `camoufox-bridge.service` on the host, listening on
  `127.0.0.1:8899` and the Docker gateway `172.18.0.1:8899`.
- From inside this container the bridge is `http://172.18.0.1:8899`.
- Every request needs `Authorization: Bearer $CAMOUFOX_BRIDGE_TOKEN`.
  **Never print, log, paste or guess the token.** If it is missing, stop
  and tell the user to set it (see "Token setup" below).
- The bridge keeps ONE persistent browser profile
  (`/data/home/camoufox/profile`) so logins/cookies survive restarts.
  All calls share that one page — calls are serialised in the bridge.
- Screenshots are saved on the host at
  `/data/home/camoufox/shots/<timestamp>-<name>.png` AND copied into this
  workspace at `/app/working/workspaces/default/media/camoufox-<ts>-<name>.png`
  so they can be shown to the user.

## Endpoints

Base: `http://172.18.0.1:8899`. All POSTs send JSON and the Bearer header.
Use `curl` (or `python3` with `urllib`) — there is no SDK for the bridge.

- Health: `GET /health` (no auth needed — only reports alive/title/url).
- Open a page:
  `POST /goto` with `{"url": "https://x.com/", "timeout_ms": 60000}`
  → `{"ok": true, "title": "...", "url": "...", "status": 200}`.
  Wait 2s after navigation before snapshotting (the bridge already
  settles 2s by default).
- Read the page: `POST /snapshot` with `{"max_chars": 20000}`
  → `{"ok": true, "title": "...", "url": "...", "text": "..."}`.
  The text is the visible body text. If it is empty or a login wall,
  say so — do not invent page contents.
- Screenshot: `POST /screenshot` with `{"name": "x-home"}`
  → `{"ok": true, "host_path": "...", "workspace_path": "...",
  "app_path": "/app/working/workspaces/default/media/..."}`.
  Show the user the `app_path` file when they ask what the page looks like.
- Click: `POST /click` with `{"by": "css", "value": "a[href='/home']"}`
  (`by` can also be `text`, `role`, `label`, `placeholder`; for `role`
  add `"name": "..."`).
- Fill a field: `POST /fill` with
  `{"selector": "input[name='text']", "value": "..."}`.
- Run JS: `POST /eval` with `{"expression": "document.title"}`.
- Current page: `POST /state` → title + url.
- Restart the browser (only if pages stop responding):
  `POST /restart`.

Example (open X and read it):

```bash
B=http://172.18.0.1:8899
H="Authorization: Bearer $CAMOUFOX_BRIDGE_TOKEN"
curl -fsSL -H "$H" -H 'Content-Type: application/json' \
  -d '{"url":"https://x.com/"}' $B/goto
curl -fsSL -H "$H" -H 'Content-Type: application/json' \
  -d '{"max_chars": 8000}' $B/snapshot
curl -fsSL -H "$H" -H 'Content-Type: application/json' \
  -d '{"name":"x-home"}' $B/screenshot
```

## Rules

- Prefer the built-in `browser` skill/tool for ordinary sites. Use this
  skill when the built-in browser fails (X.com HTTP errors, bot blocks)
  or the user explicitly asks for Camoufox.
- X.com needs a logged-in session for search/profile pages. If a page
  shows a login wall, stop and tell the user: they must log in once in
  the Camoufox profile (via the watch page / VNC, or by asking the
  operator to run a login flow) — do not try to guess or brute-force
  credentials, and never ask the user to paste an X password into chat.
- Do not use this browser to evade a site's access controls for
  scraping at scale, to create fake accounts, or to impersonate anyone.
  One page at a time, human-paced, for the user's own browsing.
- If the bridge returns 401, the token is missing/wrong: stop and tell
  the user to check it. If it returns 502/connection-refused, the bridge
  service is down: report that (do not restart host services yourself).

## Token setup (for the user, done once)

The bridge token lives in two places only: `/data/home/camoufox/.env`
on the host (chmod 600) and QwenPaw's encrypted environment store.
To set it in QwenPaw, run inside the QwenPaw container:

```bash
qwenpaw env set CAMOUFOX_BRIDGE_TOKEN <token>
```

The value is encrypted at rest in `working.secret/envs.json` and only
injected into the agent's environment at runtime. To remove it:
`qwenpaw env delete CAMOUFOX_BRIDGE_TOKEN`. Until the token is set,
this skill can explain the setup but cannot call the bridge: say so
plainly instead of pretending to have browsed.

## Opening a site on the user's visible desktop

The user can watch the InstaBox desktop screen (and take it over) via the
dashboard stream link. To put a page on THAT screen — so the user sees it
live — use the bridge's desktop endpoint (same token):

```bash
curl -s -X POST -H "Authorization: Bearer $CAMOUFOX_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}' \
  "$B/desktop-open"
```

This opens the URL in the desktop Chromium (display `:1`), as a new tab if
the browser is already running. Use it when the user asks to open a site
and watch / take control — that is the desktop browser, not Camoufox.
Camoufox (this skill's other endpoints) is for anti-detect browsing the
user does NOT need to watch (e.g. x.com, which blocks the desktop Chromium
and QwenPaw's headless browser alike).
