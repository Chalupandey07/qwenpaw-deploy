# QwenPaw on InstaBox Free + Cloudflare Worker + Pages

**Final plan — 2026-11-14. Free only. English only. No China endpoints. Cloud LLM only, with your own keys. No local models.**

## ✅ Deployed — live (2026-11-14)

- **QwenPaw console — use this, not the InstaBox URL directly:** https://qwenpawx.pages.dev — root `/` IS the console, served through a Cloudflare Pages reverse proxy (`pages/public/_worker.js`). Backup: https://qwenpaw-frontend.pages.dev — same proxy, same console.
- **Status / wake page:** https://qwenpawx.pages.dev/status (and `/status` on the backup domain) — status, Wake button, Open Console link. The old status page at `/` is gone.
- **Login — read this:** QwenPaw allows exactly one user account. The account that exists on the machine is username `satwik`, created by interactive registration after deploy (auth.json written 2026-11-14 18:27). It was **not** created from the `.env` values, so the password in `/data/home/qwenpaw/.env` does **not** log in (verified: login as `admin` and as `satwik` with the `.env` password both return 401, on localhost, on the InstaBox URL, and through both Pages proxies — the proxy is not the problem, the stored credentials are). Log in with the `satwik` password chosen at registration. If that password is lost, delete `working.secret/auth.json` inside the machine and restart the container — QwenPaw then re-creates the admin from `QWENPAW_AUTH_USERNAME` / `QWENPAW_AUTH_PASSWORD` in `.env` on next boot (see `app/auth.py`: "if [you] forget [your] password, delete auth.json from SECRET_DIR"). That wipes the existing account, so only do it deliberately.
- **QwenPaw console (origin, direct):** https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech — still works, but use the Pages domains; every visit through them also wakes the box.
- **Note:** `qwenpaw.pages.dev` is taken by an unrelated Chinese personal homepage and cannot be claimed. An empty Pages project named `qwenpaw` exists (subdomain `qwenpaw-b71.pages.dev`, nothing deployed to it).
- **Worker keep-alive:** https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev — cron `*/5 * * * *`, `/status` and `/ping` verified returning `status: up`
- **GitHub repo:** https://github.com/Ratulbaba7/qwenpaw-deploy (public, `main`, all 14 files)
- **InstaBox machine:** `m_agq5wqqo2fvypym7rjlpvngc2m` (`qwenpaw`, agent-browser, 4 vCPU / 8 GiB / 20 GiB), running
- **Snapshot:** `qwenpaw-ready` (`sn_agq5wrfmt5jfcqkjhtjqqqw3du`, ready)
- **Cloudflare:** KV namespace `STATUS` (`6a91d8099ed8419c88c94b0946186a27`), Worker `qwenpaw-keepalive`, Pages project `qwenpawx` (proxy deployment `eabd3a30-5868-40a7-bc5f-553c8a4d1a1d`, success), backup project `qwenpaw-frontend` (proxy deployment `58e7aeb2-e099-4fe5-ad3c-1fab3f1c8d5c`, success)

Next step for the user: open the console URL, log in, go to Settings → Models, add your own LLM API key (OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter), set it as Default LLM, and send a test chat.


QwenPaw `agentscope/qwenpaw:v2.3.0` (pinned, Docker Hub only) runs in Docker on a
free InstaBox `agent-browser` machine (Debian 13, 4 vCPU / 8 GiB, 20 GiB `/data`).
A Cloudflare Worker pings it every 5 minutes so it sleeps as little as possible.
Cloudflare Pages is a **reverse proxy in front of the console**: root `/` on
`qwenpawx.pages.dev` (and on `qwenpaw-frontend.pages.dev`) serves the QwenPaw
console itself — SPA, `/api/*`, assets, auth cookies, SSE streaming — all
proxied to the InstaBox origin. `/status` serves the status / Wake page.
Every visit through the proxy hits the public InstaBox URL, which counts as
activity and wakes an auto-paused box; the 5-minute Worker cron is the other
keeper. WebSocket upgrades are passed through untouched (the console itself
uses SSE, not a browser WebSocket — the origin answers WS upgrades on `/`
with 403, and the proxy returns that same 403).

```
GitHub repo (this repo — source of truth)
  ├─ instabox/  → Docker + systemd on the InstaBox machine, port 8088
  ├─ worker/    → Cloudflare Worker, cron  */5, /status /ping /wake
  └─ pages/     → Cloudflare Pages, _worker.js reverse proxy + status page

Worker ──ping every 5 min──► https://8088-<id>.instabox.tech/api/healthz
Pages  ──GET / ─────────────► proxy ──► https://8088-<id>.instabox.tech/ (console)
Pages  ──GET /status────────► status page (Worker /status, Wake button)
You    ──open qwenpawx.pages.dev ──► QwenPaw login, through the proxy
```

## What Free can and cannot do — read this first

| Limit | Value |
|---|---|
| Idle pause | Fixed 30 min. A public-URL ping counts as activity, so  */5 min pinging should prevent it. |
| Max run | Starts 120 min, extends with use to **480 min max**, even if busy. Cannot be beaten. |
| Cooldown after max-run pause | 1st 5–20 min, 2nd 60–75 min, 3rd+ 120–135 min. Every wake is refused `409 machine_cooldown` during it. |
| Realistic uptime | ~85–95% over a week, outages clustered every ≤8 h. First run of the day ~96%. |
| Tip that actually helps | Let the box idle-pause once a day (e.g. stop the cron overnight). A run ending by idle pause resets the cooldown count to 5–20 min. |

No Tunnel on Free: when the VM pauses, `cloudflared` dies and visitors get
Error 1033/1016, and nothing wakes it — the hit never reaches InstaBox.
The Pages proxy is the outside layer instead. Its limits: on a 503
"Sandbox is waking up" the proxy waits ~45 s and retries once, then serves
an auto-refreshing waking page; on 409 `machine_cooldown` it serves a
cooldown page with the retry time. Set-Cookie domains from the origin are
stripped to host-only so login cookies stick to the Pages domain.

## Repo layout — everything customizable here

| Path | What to change |
|---|---|
| `instabox/docker-compose.yml` | QwenPaw image tag, env, volumes, healthcheck |
| `instabox/.env.example` | Copy to `.env` on the machine, `chmod 600`. Auth + telemetry + disabled China channels. **Never commit a real `.env`.** |
| `instabox/qwenpaw.service` | systemd unit, `docker compose up -d` on every fresh boot |
| `instabox/setup.sh` | One-time install inside the machine |
| `worker/wrangler.toml` | Worker name, cron ` */5 * * * *`, `QWENPAW_URL`, KV binding |
| `worker/src/index.js` | Ping / retry / cooldown / API-wake fallback / `/status` |
| `pages/public/_worker.js` | Pages reverse proxy: `/` + everything → InstaBox origin, `/status` → status page, 503 wake-wait + retry, 409 cooldown page |
| `pages/public/status-page.html` | Status / Wake page served at `/status`: `WORKER_URL`, Open Console is `/` on the same domain |
| `scripts/deploy-pages-proxy.py` | Direct-upload deploy of `pages/public/` (incl. `_worker.js`) to a Pages project: `python3 scripts/deploy-pages-proxy.py qwenpawx` |
| `.github/workflows/deploy-worker-pages.yml` | Deploy Worker + Pages on push |
| `.github/workflows/keepalive-backup.yml` | GitHub Actions cron ping, backup if Worker cron ever misses |
| `scripts/backup.sh`, `scripts/verify.sh` | Off-box backup, post-deploy checks |

## Deploy order

### 1. InstaBox machine + QwenPaw

```bash
instabox create --name qwenpaw --template agent-browser

# Copy this repo's instabox/ files into the machine, then inside it:
#   instabox ssh qwenpaw
#   cd ~/qwenpaw   # = /data/home/qwenpaw
#   cp .env.example .env   # edit it, chmod 600 .env
#   bash setup.sh
# Or run setup.sh from this repo — it does the mkdir, compose, systemd steps.

instabox port publish qwenpaw 8088 --name QwenPaw
# Copy the printed URL verbatim, e.g. https://8088-<id>.instabox.tech/
# PUBLIC port, not --private: a private request without its token gets 401
# and does NOT wake a paused machine. QwenPaw auth is the gate.
```

Verify from the **public URL, not localhost** (localhost bypasses auth):
1. Login page appears — if the console opens without login, STOP and fix auth.
2. Sign in, Settings → Models → your provider (OpenAI / Anthropic / Gemini /
   DeepSeek / OpenRouter) → paste **your** key → set as Default LLM.
   Do not set `DASHSCOPE_API_KEY`. Do not enable DashScope / ModelScope.
3. Language `en`, your timezone, approval STRICT/SMART (never OFF).
4. Send a test chat.
5. `instabox snapshot save qwenpaw --name qwenpaw-ready`

### 2. Cloudflare Worker

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create STATUS   # paste id into wrangler.toml
# Edit wrangler.toml: QWENPAW_URL = your public InstaBox URL
# Optional secrets only:
#   npx wrangler secret put INSTABOX_API_KEY   # API-wake fallback only
#   npx wrangler secret put PORT_TOKEN         # private port only — not used in the public-port design
npx wrangler deploy
curl -s https://qwenpaw-keepalive.<your-subdomain>.workers.dev/ping
curl -s https://qwenpaw-keepalive.<your-subdomain>.workers.dev/status
```

Worker free limits: 100,000 req/day, 10 ms CPU/invocation, 5 cron triggers,
50 subrequests. This design uses ~288 cron + a few hundred `/status` reads/day.

### 3. Cloudflare Pages (reverse proxy — the console's front door)

```bash
# Deploy pages/public/ (status page + _worker.js proxy) via the Direct Upload API:
python3 scripts/deploy-pages-proxy.py qwenpawx
python3 scripts/deploy-pages-proxy.py qwenpaw-frontend
# Live at https://qwenpawx.pages.dev  (root / = console, /status = status page)
# Backup: https://qwenpaw-frontend.pages.dev (same proxy, same console)
# Or connect the repo in the Cloudflare dashboard: Pages → Connect to Git,
# Framework: None, build command: (empty), output: public
# (Git-connected deploys also pick up _worker.js from public/.)
```

### 4. Tests to run once

- 35-min idle test: status stays UP, no wake needed.
- Wake test: pause the machine, open `https://qwenpawx.pages.dev/` — the proxy
  waits ~45 s, retries, and the login page loads. `/status` shows the same.
- Proxy tests (run after every Pages deploy):
  `curl https://qwenpawx.pages.dev/` → QwenPaw Console HTML, 200;
  `curl https://qwenpawx.pages.dev/api/auth/status` → `{"enabled":true,"has_users":true}`;
  `curl https://qwenpawx.pages.dev/status` → status page with Wake button;
  same three on `qwenpaw-frontend.pages.dev`.
- Reboot test: `instabox stop qwenpaw && instabox start qwenpaw` — container
  must come back via systemd with no manual commands.
- Cooldown test (once, when it happens naturally): the proxy serves a
  `cooldown` page with a retry time. Do not hammer Wake during it.

## Security notes

- Auth is **off by default** in QwenPaw. Set `QWENPAW_AUTH_ENABLED=true` +
  a long random password **before first boot and before publishing the port**.
- Bind `127.0.0.1:8088:8088` inside the machine only. Never `0.0.0.0:8088`.
- `QWENPAW_TELEMETRY_DISABLED=true` before first boot. Telemetry endpoint in
  source is an Alibaba Cloud Function URL.
- Never `agentscope-registry.ap-southeast-1.cr.aliyuncs.com/agentscope/qwenpaw`.
  Docker Hub `agentscope/qwenpaw:v2.3.0` only. Never run `install.sh` — it
  falls back to `mirrors.aliyun.com/pypi/simple/`.
- No secrets in this repo. `.env`, tokens, API keys live in Worker secrets,
  GitHub Actions secrets, or the machine's `/data/home/qwenpaw/.env` (`600`).

## Costs

$0/mo. Worker <1,000 req/day of 100k, Pages 1 static file, InstaBox Free
1 machine / 100 GiB egress/mo. Optional custom domain ~$10/yr.
