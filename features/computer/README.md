# Computer — rebuilt from Rakazo's design

**Status: code complete, NOT deployed.** Muse deploys and is the only one who
can call it live. Nothing in here claims to render until Muse has seen it.

## What this is

A rebuild, not a patch. The previous implementation (8,399 lines) was removed
because its *design* was wrong at several layers, and patching it is how it got
to 8,399 lines. This is Rakazo's architecture, ported to this deployment's
constraints.

Source of truth: `elie222/rakazo` @ `d343d83`, read directly —
`apps/web/src/pages/shell/computer-overlay.tsx` (the look),
`apps/web/src/lib/computer-screen.ts` (the state machine),
`apps/web/src/novnc-html.ts` (the shim),
`packages/core/src/node/screen-capability.ts` (the seal),
`packages/core/src/screen-reconnect.ts` (the lease constants).
`rakazo-computer-study.md` beside this file is the analysis.

## The shape

```
pages/public/computer/
  capability.js   AES-256-GCM seal + noVNC shim        (port of screen-capability.ts + novnc-html.ts)
  state.js        lease, generations, needs-you, previews (port of computer-control.ts, on D1)
  router.js       the /computer surface + stream proxy  (port of routes/computer.ts + screen-proxy.ts)
  ui.html         panel + overlay, one self-contained page (port of computer-panel/overlay.tsx)
```

`pages/public/_worker.js` delegates `/computer*` to the router and is otherwise
untouched — it is a console proxy again.

## Three deliberate divergences from Rakazo

| Rakazo | Here | Why |
|---|---|---|
| noVNC proxied by the web server, capability resolved by a **separate API** over a bearer secret | both in one Worker, capability opened in-process | Rakazo splits them because they are different services. We are one Worker; a network hop would exist only to reproduce a boundary we do not have. |
| capability TTL **60 min** | **10 min** | A link here is minted immediately before a frame loads it. Ten minutes survives a slow wake and dies long before a leaked link is useful. |
| recheck every **1 s** through the API | recheck the live lease on **every request** | Same isolate, same D1 call, so the check is free. Rakazo's 1 s recheck exists because its authority is across a network; ours is a local query. |

Everything else is preserved, because each part prevents a specific failure
recorded in `BUGS.md`:

| Preserved | Prevents |
|---|---|
| policy + expiry in the **AAD** | a view link replayed as control |
| scope = `{computer, generation, leaseId}` | a link surviving a takeover or a screen replace |
| the provider token **inside** the seal | a token in a cookie, in a redirect, or in the browser at all (the stale per-port cookie bug) |
| deterministic IV per identical seal | two tabs invalidating each other's handshake |
| `redirect: "manual"` upstream | auto-follow without a cookie jar reporting a healthy desktop as down |
| drop the browser `Cookie` header | a stale per-port cookie 401ing every other port |
| a **held predecessor frame** | the screen blanking on take/release |
| the shim's state reports | a silent frame showing black with no diagnosis |
| `pointer-events: none` until control | driving a screen you do not hold (UI gate; the lease is enforcement) |
| heartbeat only while **visible** | a forgotten tab holding control forever |
| release **names the lease** | a late release from an old page ending newer control |

## Two bugs this rebuild's own harness caught

Both would have shipped broken, and both are why the harness runs before the
commit rather than after the deploy:

1. **The IV was never written into the token.** `crypto.subtle.encrypt` used it
   but the token held only the ciphertext, so every screen link was
   well-formed and dead on arrival. The harness opened a freshly sealed
   capability and got `null`.
2. **The AES-GCM tag split.** `node:crypto` takes the auth tag as a separate
   argument; WebCrypto returns `ciphertext || tag` as one buffer. Porting the
   split verbatim fails every open.

Neither is visible by reading the code — both need the round trip.

## The quota math for this design (measured, not claimed)

The previous implementation's worst case was **17,280 writes/day against a
1,000/day KV budget — 17× over**, and the docs meanwhile claimed it was
"bounded well under 1,000". That false claim is the single most expensive
documentation error in this repo: the migration was sized on it.

The new computer writes to D1 (100,000 rows/day), and the numbers are:

| Component | Rows/day (worst case) |
|---|---|
| Lease heartbeat while control is held 24 h (15 s) | 5,760 |
| Takeover + release (~20/day × 2) | 40 |
| Needs-you raise + resolve (~20/day × 2) | 40 |
| Preview uploads, 2 computers, 120 s floor, screen always changing | 1,440 |
| Preview write when the hash is unchanged | **0** |
| Mode switches (~10/day) | 10 |
| **Total** | **7,290 (7.3% of D1)** |

A static screen with control held all day costs **5,850 writes**, because the
preview upsert is conditional on `sha256 IS NOT excluded.sha256` — an unchanged
screen writes nothing. That is the actual fix for the burn: not a longer
interval, but making the write conditional on a change.

**The heartbeat is the dominant cost and cannot be reduced** without weakening
takeover, which is why D1 (100k) rather than KV (1k) is the right store. On KV
this design would still be 5.9× over quota while idle.

## The preview uploader (machine side)

`features/computer/preview-uploader.py` + `computer-preview.service`.

This is where the quota burn used to happen. The rule it enforces is the whole
fix, and it is asserted in its own `--selftest`:

| Situation | Uploads/day |
|---|---|
| Static screen | **1** (the first capture; then zero forever) |
| Screen changing every tick | ~720 (capped by the 120 s floor) |
| Human holding control | **0** (the guard runs before the capture) |
| Store returning 429/503 | 0 for 300 s (backoff, not a retry storm) |
| Old unconditional uploader | 5,760–11,500 |

Three details that are easy to get wrong and are covered:

- **Capture with `scrot`**, not AT-SPI. The AT-SPI path returned a bare desktop
  while the window was unmapped — the recorded "phantom desktop" symptom.
- **The control guard runs before the capture**, not after. Capturing while a
  human drives is pure cost; they are already looking at it.
- **A 429/503 sets a 5-minute backoff.** Retrying into a spent budget is how the
  original incident escalated from "slow" to "the desktop is down".

The token is a header (`X-Computer-Token`) and never appears in a URL, and a
browser User-Agent is set because Cloudflare answers 403 to python-urllib's
default.

## Deployment (Muse)

1. **D1 binding.** The router expects `COMPUTER_DB` bound to the
   `qwenpaw-state` database. The schema is created idempotently on first use
   (`state.js::ensureSchema`), so no separate migrate step is needed.
2. **Secrets** (never in git, never in chat):
   `COMPUTER_CAPABILITY_SECRET` (32+ random bytes), `COMPUTER_CONTROL_ORIGIN` +
   `COMPUTER_CONTROL_TOKEN`, `COMPUTER_VIEW_ORIGIN` + `COMPUTER_VIEW_TOKEN`,
   the same four with `QA_` for the second display, and `COMPUTER_SYNC_TOKEN`
   for the agent-facing endpoints.
3. **Machine side** (Muse's job, per the brief): the view-only and interactive
   x11vnc/websockify pairs on published ports, and the preview uploader. The
   uploader must be **change-only with a floor** — that is what burned the KV
   quota, and the D1 write budget is now the thing to protect.
4. **Verify in a real browser.** Not with a protocol check. The previous rounds
   that skipped this shipped a broken screen every time.

### Added 2026-11-16 (Terminal + Teach)

5. **`preview_meta` table.** `state.js::ensureSchema` creates it (idempotent,
   `CREATE TABLE IF NOT EXISTS`) on the first request after deploy. It stores
   the preview hash so a 10 s poll reads ~40 bytes instead of re-reading and
   re-hashing the 243-707 KB blob twice. Nothing to run by hand.
6. **Terminal secret and service.** `TERMINAL_SECRET` — 32+ random bytes, the
   SAME value in two places: as a Worker secret (`COMPUTER_CAPABILITY_SECRET`
   is what actually signs; the machine needs its own copy at
   `/data/home/qwenpaw/terminal.secret`, mode 0600) and on the machine.
   `COMPUTER_TERMINAL_ORIGIN` is the published terminal port's URL.
   Sync `features/computer/terminal-server.py` to
   `/data/home/qwenpaw/terminal-server.py` and run it under systemd with a
   `RuntimeDirectory=qwenpaw-terminal`. **Without `terminal.secret` the server
   refuses to start** — it will not serve a shell it cannot lease-bound.
7. **Teach needs no new secret.** `POST /computer/teach` is the authenticated
   UI saving the user's own demonstration; `GET /computer/teach/pending` and
   `/ack` use `COMPUTER_SYNC_TOKEN`, so the agent-side reader needs nothing
   new. The lease-watcher should poll `/computer/teach/pending`, write each
   skill into QwenPaw's skill pool, then `POST /computer/teach/ack {id}`.
8. **Still verify in a real browser.** The terminal especially: a protocol
   check cannot tell you whether xterm renders or whether the prompt is usable.

## Not done

- **Per-bot computers**: the schema has a `computer` row per name and the
  router takes `?computer=`, so the model supports it, but only `default` and
  `qa` are wired.
- **Live verification of any of it.** That is Muse's, and it has not happened.

## The black screen — fixed 2026-11-16 (B-28)

The rebuilt computer loaded, took a lease, minted a capability, served the
noVNC page (200) — and never connected. `proxyScreen()` had no branch for a
**101 WebSocket upgrade**, so the socket that carries the RFB banner never
opened and noVNC waited forever. The page HTML renders either way, which is why
it looked like a noVNC fault rather than a proxy one.

The branch is now there, with minimal headers on the upgrade. T97 drives the
real router with a 101 and asserts the **same socket object** is handed back;
it fails 6/22 without the branch and passes 22/22 with it.

**Two things this fixed the hard way, worth keeping:**

1. **A missing branch cannot be tested by reading the file.** Every existing
   harness asserted text in `router.js`. The fix needed a test that *runs* the
   function and inspects what it returns.
2. **The first version of T97 was itself wrong** — it matched a
   `return new Response(res.body` in `serveUi` rather than in `proxyScreen`,
   so it passed against a broken file. It is now scoped to the function, and
   that scoping is asserted.

## Built 2026-11-16: Terminal and Teach

Both pieces the previous round listed as "deliberately not done" are now
written, with the lease tests the brief required for the shell.

### Terminal (`pages/public/computer/terminal.js` + `features/computer/terminal-server.py`)

A root shell, so the rules are stricter than the screen's and none of them
have a fallback:

| Rule | Why |
|---|---|
| Minting requires the caller's own live `leaseId` | a stale tab must not open a shell against newer control |
| Expiry is `min(60 s, lease.expiresAt + 15 s)` | B-4: the old terminal lived **3,600 s**, so a release left a shell for 59 more minutes |
| Every request re-checks the live lease and the generation | a link is useless the instant control moves |
| The PTY server gets a **signed absolute deadline** | it kills the shell itself, because the Worker is not in the loop for an established WebSocket. A crashed browser cannot hold a shell. |
| The token is a path segment of a sealed capability | B-16: never a query string, never a cookie, never in `Referer` |
| `cols`/`rows` clamped to `1..1000` on both sides; a frame declaring more than 1 MiB closes the connection | B-17 |
| `hmac.compare_digest` on the machine side, hashed constant-time compare in the Worker | B-16: a plain `==` on a token that authorises a shell leaks it by timing |

The terminal tab is inert until control is held, and releasing control closes
the shell locally **and** lets the signed deadline enforce it. T92 (39 checks)
drives the real Worker against real SQLite and the PTY server against a real
PTY; one of its assertions is that an idle but open session ends on its own.

### Teach recording (`pages/public/computer/teach.js`)

The old UI had Start/Stop and a toast saying a draft was saved, with no
recorder behind it. That is worse than a missing feature, because it teaches
the user to trust a false claim. What replaced it:

- `Recorder` holds normalised events (pointer / key / clipboard / scroll /
  nav), bounded at 500 and dropping from the **front** so the end of a
  demonstration — the part that matters — survives.
- `buildPlaybook()` coalesces: a typed run becomes one `Type "..."` step, a
  down/move/up with ≥8 px displacement becomes one `Drag`, a 2 px wobble
  becomes a `Click`. A raw event dump is not a draft.
- Redaction happens at **record** time, not build time, so a raw buffer
  containing a password never exists. Three layers: the Sensitive toggle, the
  `redact()` shape check (passwords, `sk-…` prefixes, card numbers, long
  alphanumeric runs), and URL credential stripping including the `#fragment`.
- The editor shows the 8 fields from the recorded T55 criterion, and `Save`
  validates first — a draft with no steps is refused by the editor **and** by
  `POST /computer/teach`, rather than toasted as saved.

The event source is the shim injected into the noVNC page (`capability.js`):
the parent cannot see into a sandboxed cross-origin frame, so the frame
forwards the events. It sends nothing while recording is off, and no key
values while Sensitive is on.

T93 covers all of it (68 checks), including the two redaction failures its own
first version had — `Enter your API key` and `sk-live-…` both classified as
ordinary text.
