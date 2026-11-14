# #1 — Live computer alternative

Status: **Blocked (no remote desktop) / Done (activity feed).** The honest
finding is that no live-desktop path exists on this machine — and the
activity feed that replaces it is deployed and verified live.

## What was checked live (2026-11-15)

### The desktop exists, but it cannot be seen or controlled remotely

- `Xvfb :1 -screen 0 1280x800x24` is running, with a full XFCE session
  (`xfce4-session`, panel, notification daemon) since boot.
- **No VNC server process is running.** `tigervncserver` is installed,
  but no `Xvnc`/`vncserver` process exists.
- **No listening VNC/noVNC port.** `ss -tlnp` shows only port 22 (SSH)
  and `127.0.0.1:8088` (QwenPaw). No 5900, no 6080, no websockify.
- **No browser is installed** (`chromium`, `google-chrome`, `firefox`:
  none found). The 2026-11-15 cleanup removed chromium/node, which the
  cleanup note itself says degrades InstaBox's built-in
  computer-use/desktop feature.
- `novnc` / `websockify` are not installed.

Conclusion: starting a VNC server would be possible in principle
(`tigervncserver :1` exists as a binary), but it would need a listening
port exposed through InstaBox's proxy (no public port besides 8088 is
documented for this machine), a password, and a browser or viewer — and
it would consume RAM on a machine already running a 4.32 GB QwenPaw
image under an 8 GB cap. That is a new service on the user's only
machine, not a small step, and it was **not** started here: it needs the
user/coordinator to choose it explicitly. InstaBox's own built-in
computer-use streams the desktop through InstaBox's control plane, not
through a port on the machine, and that path cannot be verified from
inside the VM.

## What is built instead (verified live)

**Activity feed Worker: `qwenpaw-infra-activity`**
`https://qwenpaw-infra-activity.qwenpaw-rohan.workers.dev/`

- `GET /` — a live activity page (HTML): QwenPaw status from the STATUS
  KV namespace (written every 5 min by `qwenpaw-keepalive`), last-up time,
  consecutive failures, last check, a live-probe button, a wake button
  (via the keepalive `/wake` endpoint), and a link to take over in the
  console at `https://qwenpawx.pages.dev/`.
- `GET /api/status` — the same data as JSON.
- `GET /api/live` — probes the console URL live (no retry) and updates KV.
- The Worker reads the **same KV namespace** the keepalive uses
  (`STATUS`, `6a91d8099ed8419c88c94b0946186a27`) under its own key
  prefix; it never writes the keepalive's key, so the two cannot corrupt
  each other.
- No secrets, no chat content, no auth: it publishes status only.
  (Machine state via the InstaBox API is an optional extra — it needs an
  `INSTABOX_API_KEY` Worker Secret, which only the coordinator can set
  because the key lives in the connector store, not on the machine.)

Deploy: `workers/activity-feed/index.js` + `metadata.json`, uploaded with
`cf.py put-worker` (Cloudflare API). Verified live after deploy:
`GET /` → 200, `GET /api/status` → the keepalive KV record (`status:
"up"`, `checkedAt` within the last 5 min), `GET /api/live` → live probe
`status: "up", httpStatus: 200`. Two deploy gotchas, recorded in
`metadata.json`: (1) a top-level `vars` object is silently dropped by the
upload API — plain-text vars must be `plain_text` bindings; (2) a freshly
uploaded script has its `workers.dev` route **disabled** (requests get
Cloudflare error 1042 / 404) — enable it with `POST
/workers/scripts/qwenpaw-infra-activity/subdomain {"enabled": true}`
(`PUT` returns 10405 for API tokens; `PATCH …/settings` needs multipart
and does not take `workers_dev`).

## What the feed honestly cannot show

- It cannot show a live desktop, a screenshot, or the XFCE session.
- It cannot show what the agent is doing inside a session (no log access
  from a Worker; the log lives on the paused-or-running machine).
- "Live" means "last keepalive probe + on-demand probe", not a stream.
  During a max-run cooldown the feed correctly shows `cooldown` with the
  retry time — that is the most useful thing it can say.

## If the user still wants a live desktop

The decision needed: (a) accept InstaBox's built-in computer-use as the
only desktop path (verify it in the InstaBox dashboard — outside this
build), or (b) approve running a VNC server on this machine with a
password + an exposed port + a reinstalled browser, accepting the RAM and
security trade-offs. Neither is done here, and neither should be done
without the user choosing.
