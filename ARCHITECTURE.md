# ARCHITECTURE.md — how this system actually works

One page you can read in ten minutes and understand the whole deployment.
Everything else in `features/` is detail.

## 1. The problem this architecture solves

InstaBox Free gives you one 4 vCPU / 8 GiB / 20 GiB machine that **pauses
after 30 minutes idle**, has a **120-minute maximum run** (growing to 480 with
use), and cools down 5–135 minutes after a max-run pause. Cloudflare's free
tier fronts it. There is no always-on compute anywhere in the stack.

So the architecture is three layers that each do the one thing they are good
at:

```
        browser
           │  https://qwenpawx.pages.dev
           ▼
┌──────────────────────────────────────────┐
│ Cloudflare Pages + Workers  (always up)   │
│  • reverse proxy to the console           │
│  • auth gate / desktop lease / capabilities│
│  • keep-alive cron (5 min)                │
│  • routines, group chat, board, bot pages │
└──────────────────┬───────────────────────┘
                   │ public port 8088 (a request here WAKES the box)
                   ▼
┌──────────────────────────────────────────┐
│ InstaBox Free machine (pauses when idle)  │
│  • QwenPaw container  :8088               │
│  • Xvfb :1 (Team)  + :2 (Private/QA)      │
│  • noVNC/view-only/terminal websockify    │
│  • computer-use MCP over SSE (8898/8897)  │
│  • lease-watcher (mirrors lease → control │
│    file the MCP proxy honors)             │
│  • Camoufox bridge (8899)                 │
└──────────────────────────────────────────┘
```

**Why a proxy and not just the InstaBox URL:** the box can be paused. Only a
Public-port request wakes it. The Pages proxy absorbs that: it retries once
after 45 s, and if the box is still booting it serves a self-refreshing
"waking up" page. The user never sees an InstaBox hostname.

**Why the keep-alive Worker:** QwenPaw's own scheduler (APScheduler cron jobs
in `jobs.json`) can only fire if the container is running. A 5-minute ping to
the public URL keeps the box awake as much as Free allows, and lets native
cron routines fire.

## 2. Auth model (this is the subtle part)

QwenPaw's auth is **header-based**: `Authorization: Bearer <token>` or
`?token=`. There is **no cookie auth**. A plain browser navigation carries no
credential.

That collides with a proxy: the console is a SPA at `/`, the browser navigates
there with no header, and QwenPaw answers 401.

The solution is a two-stage handshake in `pages/public/_worker.js`:

1. `GET /` → proxy detects 401 → serves a **gate page** (HTML, our domain).
2. The gate page reads the token the console stored in `localStorage` from a
   previous login, POSTs it to `/desktop/__verify`, and the Worker mints an
   **HMAC-signed cookie** (`DESKTOP_SESSION`) scoped to our domain.
3. Every later `/desktop/*` request is authorized by that cookie.

**Never store a QwenPaw token in a cookie directly** — it is a bearer
credential with full console access. The HMAC cookie proves "this browser
completed a login recently" and expires on its own.

## 3. The desktop: view / control split + lease

The hard requirement: an agent and a human must share one screen without
fighting. Rakazo's model, ported here:

- **View** is free. `/desktop/session/view/<exp>.<cap>` → the view-only
  websockify port (6082 / 6084). Anyone logged in can watch.
- **Control** requires a **lease**: a 90-second grant, heartbeat-ed every 15 s
  while the page is visible, released explicitly or by expiry. Only one
  holder.
- **Control-only surfaces** (the interactive VNC port 6081, the terminal
  PTY 6083) are never reachable directly. They are served only through a
  **sealed capability**: AES-256-GCM, bound to `{mode, exp, generation,
  leaseId, computer}`, 60-minute TTL.

The lease is what the **MCP proxy honors**: `lease-watcher.py` (on the box)
polls the Worker every 5 s and writes `human worker-lease <epoch>` into
`/run/user/1000/instabox-control`. While that file exists and is fresh, the
computer-use MCP proxy refuses the agent's input tools and lets it read the
screen. On handback the file is removed and the agent re-reads the screen.

**Generations** exist so a stale link dies: every takeover/release increments
a per-computer generation; a capability minted before the increment no longer
verifies.

## 4. What runs where, and why

| Thing | Where | Why not elsewhere |
|---|---|---|
| Console (QwenPaw) | InstaBox container | it *is* the app; needs the box's GPU-less CPU and disk |
| Desktop (Xvfb/noVNC) | InstaBox | needs the same box as the app + the MCP |
| computer-use MCP | InstaBox, SSE on `172.18.0.1:8898` | must drive the local X server; exposed to the container over the Docker gateway |
| Reverse proxy + gate | Cloudflare Pages | must be up when the box is asleep |
| Keep-alive cron | Cloudflare Worker | a cron on a paused box cannot fire |
| Routines | Worker (wake) + QwenPaw native cron (execution) | the Worker cannot hold a QwenPaw login; native cron is the scheduler of record |
| Group chat | Worker + Durable Object | needs strong consistency for turn-taking; a DO is single-threaded |
| Ticket board | Worker + KV today, D1 planned | see BUGS.md — single-key KV loses updates |
| Bot pages | Pages project | static, free, fast |
| Memory recall | inside the container (`history.db` FTS5) | the DB is already there and indexed |

## 5. Data flow: one control action

```
user clicks "Take control"
  → POST /desktop/__takeover {computer}
      Worker: read lease (KV/D1) → if active, 409
              write lease {leaseId, holder:"user", expiresAt:+90s, fence+1}
              bump generation
      → 200 {leaseId, expiresAt, generation}
  → chrome POSTs /desktop/__screen {mode:"control", leaseId, gen}
      Worker: verify lease alive + leaseId matches
              seal capability {mode, exp, gen, leaseId, computer}
      → {url: /desktop/session/control/<exp>.<cap>}
  → iframe loads that URL
      Worker: verify capability (decrypt, check exp, generation, lease)
              fetch the private origin WITH its token, redirect:"manual",
              follow the 303 server-side with the Set-Cookie
      → proxied noVNC page → websockify WS → x11vnc :1 → the screen
  → every 15 s while visible: POST /desktop/__heartbeat {leaseId}
  → "Release": POST /desktop/__release {leaseId} → delete lease, bump gen
      → lease-watcher sees no lease → removes the control file → agent may act
```

Two details that cost hours to find, both documented in
`features/desktop/README.md`:

- **`redirect: "manual"` is mandatory.** Workers `fetch()` auto-follows the
  InstaBox proxy's `303 + Set-Cookie` *without a cookie jar*, so the follow-up
  401s and the Worker reports a healthy desktop as down.
- **Drop the browser's `Cookie` header entirely on origin fetches.** The
  private-port proxy honors the *first* `__Host-instabox_port_auth` cookie,
  and a browser holds one value per name — so a stale cookie for one port
  401s every other port. Proxy-auth cookies stay server-side only.

## 6. Failure modes and what the system does

| Failure | Symptom | Handling |
|---|---|---|
| Box auto-paused | origin 503 | proxy waits 45 s, retries, then serves "waking" page |
| Max-run cooldown | origin 409 `machine_cooldown` | cooldown page with a retry window |
| Desktop up, X frame unmapped | black screen | `desktop-window-watch.service` re-maps every 10 s |
| Spend KV write quota | every write 500s, reads fine | `kvTry` → honest 503 `store_unavailable`; D1 migration removes the class |
| Store unreachable | capability check throws | 502 "try again", never "link expired" |
| Stale capability | 403 | chrome re-mints once, then reports honestly |
| Agent blocked on a login wall | needs-you banner | agent raises needs-you FIRST; never works around it |

## 7. Where the design is weak (read before extending)

1. **KV is the wrong store** for leases, modes, and previews — eventually
   consistent, 1,000 writes/day, last-writer-wins. The D1 migration (see
   `features/storage/`) is the fix. Until then, treat every KV write as a
   scarce resource.
2. **The board keeps all tickets in one KV value.** Lost updates under any
   concurrency. D1 fixes it.
3. **A terminal capability outlives its lease** (60 min vs 90 s) — see
   BUGS.md #3.
4. **Preview images are stored base64 in KV.** They are 243–707 KB each.
   They belong in R2.
5. **The agent's own loop cannot use Code Mode.** QwenPaw is Python; Code
   Mode is TypeScript/Workers. The pilot measures a *separate* Worker agent,
   which is honest but is not a QwenPaw speedup.
