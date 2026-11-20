# Multi-PC Computer (E1) — Rakazo-style "one computer per bot" on ONE machine

Rebuilds QwenPaw's Computer from a single shared desktop (hardcoded
`COMPUTERS = ["default","qa"]`) into a Rakazo-style multi-PC model: one
computer per bot, created on demand, listed and switched in the UI.

**Hard constraint honoured:** InstaBox Free is ONE machine (4 vCPU / 8 GiB /
20 GiB). Every PC is a display + noVNC port ON THAT MACHINE, drawn from the
existing websockify pool **6080–6085** — so the ceiling is **6 PCs**. No second
machine, no paid plan. The registry refuses to over-allocate (`machine_full`)
rather than failing downstream.

## Files

| File | Role |
|---|---|
| `pages/public/computer/registry.js` | the multi-PC model: port pool, one-PC-per-bot, active switching, status |
| `pages/public/computer/router.js` | `/computer/computers` now returns the dynamic registry list (plus the built-ins); `/computer/state` accepts registry PCs |
| `features/computer/multi-pc/test-registry.mjs` | 17 checks over an in-memory D1 stub |
| `features/computer/rakazo-computer-study.md` | the Rakazo architecture study this is derived from |

## Rakazo → QwenPaw mapping

| Rakazo | here |
|---|---|
| `Computer` row per bot (`bot.computer`, `ComputerStatus`) | `pcs` row keyed by name, `bot_id` UNIQUE |
| `provider.provision({ botId })` (idempotent per bot) | `obtainForBot(botId)` → existing row or create |
| sandbox published port (6100) | `vnc_port` from the fixed pool 6080–6085 |
| display index (20, 21, …) | X display `:1`…`:6` (`port - 6079`) |
| `ComputerStatus` | `asleep \| booting \| running` |
| side-panel list/switch | `listComputers` / `setActive` / `getActive` |
| Postgres + Prisma | the same D1 (`env.COMPUTER_DB`) the Computer surface already uses |

Port maths: 6080→`:1`, 6081→`:2`, … 6085→`:6`. The machine already runs
websockify on 6080–6085 and Xvfb on `:1`/`:2`, so a PC's `vnc_port` + `display`
are directly usable by the machine-side provisioner with no renumbering.

## API surface (via `pages/public/computer/router.js`)

- `GET /computer/computers` → `{ computers: [names], pcs: [full rows] }` —
  the union of the two built-ins and every provisioned PC, active first.
- `GET /computer/state?computer=<name>` → accepts a registry PC name as well
  as the built-ins (previously only the hardcoded two were allowed).
- Registry API (importable, used by the router and available for the machine
  provisioner): `createComputer`, `obtainForBot`, `listComputers`,
  `getComputer`, `getForBot`, `getActive`, `setActive`, `setStatus`,
  `deleteComputer`, `ensureSchema`, `displayForPort`.

`obtainForBot` is the single entry point the "open this bot's computer" path
should call — it is idempotent per bot and enforces the cap.

## Known bugs — status in this rebuild

- **Fullscreen VNC iframe covered the sidebar — already fixed, kept fixed.**
  The overlay is `#overlay{position:fixed;top:0;right:0;bottom:0;left:316px}`
  (`ui.html`), i.e. it starts *after* the 316 px rail instead of `inset:0`, so
  the sidebar stays visible and clickable. The comment block at `ui.html`
  L108–120 records why the fix is structural (layout), not a z-index/timer
  patch. The multi-PC overlay inherits this.
- **Slow open — already fixed, kept fixed.** The proxy serves content-hashed
  `/assets/*` as `Cache-Control: public, max-age=31536000, immutable`
  (`_worker.js`, hashed-asset block), so the 1 MB entry bundle is not
  re-downloaded every load. HTML and API stay `no-store`.
- **P0 auth hole — already fixed, kept fixed** (capability re-validated
  against the live lease on every request and on the WebSocket upgrade).

## What is NOT in this round (honest scope)

The registry + router wiring is the backend backbone. Rakazo's *provisioner*
(that actually starts a Chromium/Xvfb container per PC) and the *list/switch/
create UI* are the next layers:

- The machine-side provisioner that turns a `pcs` row into a running desktop
  on the allocated `vnc_port`/`display` is a **machine step** (it needs Docker
  + the existing noVNC units on the box).
- The console UI (list/switch/create buttons) needs a browser to verify.

## Muse — live verification steps

1. Deploy the Pages proxy (ships `registry.js` + the router wiring).
2. `curl -s https://qwenpawx.pages.dev/computer/computers` → expect
   `computers` to include `default`, `qa` and, once a bot has obtained one, a
   `*-pc` name; `pcs` lists the full rows with `vncPort`/`display`.
3. On the machine, confirm the port pool is really free before provisioning a
   second PC: `ss -ltnp | grep -E '608[0-5]'` — each allocated PC must own
   exactly one of 6080–6085, and the count must never exceed 6.
4. Provision a second PC for a second bot and confirm its `display`/`vnc_port`
   differ from the first (no collision), then that a 7th is refused.
5. Browser: open the Computer surface, confirm the sidebar is still visible
   and clickable while the overlay is open (the `left:316px` regression
   guard), and that switching PCs repaints the screen.

## Run the tests

```
node features/computer/multi-pc/test-registry.mjs     # 17 checks
node features/computer/harness-computer.mjs           # 88 checks (regression)
node features/computer/harness-worker-load.mjs        # worker still loads
```
