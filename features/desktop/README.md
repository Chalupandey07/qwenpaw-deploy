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

## Current state (2026-11-15 ~03:00 IST, verified live)

- Desktop running, 1920x1080, `controller: agent`, `agentPausable: true`.
- Chromium open on the desktop with two tabs: wordsolverx.com
  ("Daily Puzzle Answers, Solvers & Wordle Tools" — screenshot
  `/data/home/camoufox/shots/desktop-wordsolverx4.png`) and example.com
  (opened via `/desktop-open`, screenshot `desktop-open-test.png`).
- Interactive stream link minted, TTL 24 h (token delivered to the user
  only — never in git or memory).
- noVNC private port published: `https://6080-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech`
  (token in the publish response, user only). No token → 401; with token → 303
  (sets cookie, redirects into the client).
- Camoufox bridge healthy, browser sitting on `https://x.com/0xsatwik`.
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
