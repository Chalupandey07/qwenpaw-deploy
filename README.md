# QwenPaw on InstaBox Free

An AI agent with a **real desktop it can drive**, running on a free-tier VM,
fronted by Cloudflare. You can watch it work, take control, and hand control
back — from the console, in a browser.

**Constraints that shape everything:** InstaBox Free only · Cloudflare free
tier only · English only · no China endpoints · cloud LLM only with your own
keys · no local models.

---

## Start here

| If you want to… | Read |
|---|---|
| Understand the whole system in 10 minutes | **[ARCHITECTURE.md](ARCHITECTURE.md)** |
| Know what is done, in progress, and blocked | **[PLAN.md](PLAN.md)** · [STATUS.md](STATUS.md) |
| Contribute code (rules, tests, quota discipline) | **[AGENTS.md](AGENTS.md)** |
| See every known bug, with severity and fix | **[BUGS.md](BUGS.md)** |
| Find the next thing worth building | **[IMPROVEMENTS.md](IMPROVEMENTS.md)** |
| Know what Muse hit and fixed, in detail | [HANDOFF-AUTOCLAW.md](HANDOFF-AUTOCLAW.md) · `features/desktop/README.md` |

## Live

- **Console (use this):** https://qwenpawx.pages.dev — root `/` **is** the
  QwenPaw console, served through the Pages proxy. Backup:
  https://qwenpaw-frontend.pages.dev
- **Desktop:** https://qwenpawx.pages.dev/desktop
- **Status / wake page:** https://qwenpawx.pages.dev/status
- **Origin (direct, works but no proxy):**
  https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech

**Login:** QwenPaw allows exactly one account. The account on the machine is
`satwik`, created by web registration — **not** from `.env`, so the `.env`
password does not work. Log in with the password chosen at registration.

If that password is lost: delete `working.secret/auth.json` on the machine and
restart the container; QwenPaw recreates the admin from
`QWENPAW_AUTH_USERNAME` / `QWENPAW_AUTH_PASSWORD`. **This wipes the `satwik`
account** — do it deliberately.

> `qwenpaw.pages.dev` is taken by an unrelated site and cannot be claimed. An
> empty Pages project named `qwenpaw` exists (`qwenpaw-b71.pages.dev`).

## What Free can and cannot do

| | Free tier | Consequence for this design |
|---|---|---|
| Idle pause | 30 min | a 5-min Worker cron keeps it awake; a Public-port request wakes it |
| Max run | 120 min → 480 with use | cooldown 5–135 min after a max-run pause; wakes return `409 machine_cooldown` |
| Cooldown after max run | 5–20, then 60–75, then 120–135 min | routines must tolerate a refused wake |
| Cloudflare Tunnel | **not viable** | the Pages proxy is the front door instead |
| Snapshots | max 5, create can 429 | keep one verified restore point |

Cloudflare free limits that actually bite: **KV 1,000 writes/day** (already
burned once), D1 100,000 rows written/day + 5,000,000 rows read/day,
Workers 100,000 requests/day, Durable Objects 100,000 requests/day.
See `AGENTS.md` §6 for the per-service budget rules this repo follows.

## Repo layout

```
AGENTS.md          the working contract (read before coding)
ARCHITECTURE.md    how the system fits together + why each piece is where it is
PLAN.md            roadmap and status (rewritten, not appended)
STATUS.md          implemented vs wanted, one page
BUGS.md            every known defect, severity, fix
IMPROVEMENTS.md    every improvement, by area, ranked
HANDOFF-AUTOCLAW.md  the incident log and root causes from the original build

instabox/          machine deploy: docker-compose, .env.example, systemd, setup.sh
worker/            keep-alive Worker (cron 5m)
pages/public/      the proxy (_worker.js) + desktop chrome + status page
features/desktop/   lease-watcher, PTY server, systemd units, 3 harnesses
features/routines/  wake tick + pending prompts
features/groupchat/ Durable Object thread + machine-side relay
features/board/     ticket board (+ cost / open-work dashboards)
features/botpages/  self-contained page builder
features/memory/    bounded recall, lessons ledger, ReMe doctor, ripwire installer
features/codemode/  Code Mode pilot (measures, does not claim)
features/test-project/  67-test catalogue, runner, preflight, log-check
features/audit-2026-11-15/  the security audit of record
features/research/  research notes the code decisions rest on
```

## Deploy order

The full procedure is in `instabox/setup.sh` and the feature READMEs. In
short:

1. **Machine** — copy `instabox/` onto the box, `cp .env.example .env`
   (chmod 600), `bash setup.sh`. Publish the console as a **public** port
   (a private port without its token does not wake a paused machine).
2. **Keep-alive Worker** — `cd worker && npx wrangler deploy`, set
   `QWENPAW_URL` in `wrangler.toml`.
3. **Pages proxy** — deploy `pages/public/` via the Direct Upload API
   (`scripts/deploy-pages-proxy.py`) or connect the repo in the dashboard
   (framework: none, output: `public`).
4. **Feature Workers** — `features/routines`, `features/groupchat`,
   `features/board` each have a `deploy-*.py` / `wrangler.toml`.
5. **Secrets** — never in git. At minimum: `GROUPCHAT_TOKEN`,
   `ROUTINE_WEBHOOK_TOKEN`, `WAKE_TOKEN`, `DESKTOP_*_TOKEN`,
   `DESKTOP_SYNC_TOKEN`, board key.
6. **Verify** — `python3 features/test-project/preflight.py --probe-write`,
   then `python3 features/test-project/run-tests.py`.

## Testing

```bash
# machine-free suite (harnesses + memory + codemode): 378 checks
python3 features/test-project/run-tests.py --only T46,T47,T48,T62,T63,T64,T66,T67

# before a browser round — checks the KV write budget, machine state,
# watcher throttle and services. Do not skip this: a spent KV quota once
# lost three browser tests invisibly.
python3 features/test-project/preflight.py --probe-write

# full protocol suite (needs the live machine + Cloudflare connectors)
python3 features/test-project/run-tests.py
```

Results are recorded per round in `features/test-project/RESULTS.md`. Browser
(T50–T57) and token (T58–T61) rows are filled by whoever has the browser and
the secrets — never by the coding agent.

## Security notes

- QwenPaw auth is **header-based**; there is no cookie auth. The Pages proxy
  mints its own HMAC session cookie (`DESKTOP_SESSION`) after a real login —
  it never stores a QwenPaw bearer token in a cookie.
- Control of the desktop is a **90-second lease** mirrored into a machine-side
  control file that the computer-use MCP proxy honors. Control-only surfaces
  (interactive VNC, terminal) are reachable **only** through sealed,
  generation-scoped capabilities bound to the lease.
- The 2026-11-15 audit raised 19 findings; 15 are fixed and live-verified. The
  open ones, plus everything found since, are in `BUGS.md` with severity.
- Never commit a token. Never invent a key. If something needs a secret and
  it is missing, stop and say which key and what scope.

## Costs

Everything here is on free tiers. The Cloudflare account has no paid plan; the
InstaBox machine is the free tier. LLM usage is billed by the provider the
user configures, with their own key. `features/board/refresh-cost.py` produces
`cost-data.json` from the live token usage file.
