# Rakazo computer study — how it works, gaps vs ours, build plan

Date: 2026-11-15. Sources: public repo `elie222/rakazo` commit `0c97840`
(cloned to `/tmp/rakazo-src`, read-only), plus the live session inside
`grokagent.pages.dev` (user signed in himself 04:16–04:20 IST; agent computer
woken and left RUNNING — nothing stopped/reset). No changes made anywhere;
instabox2 never touched.

Repo layout: TypeScript monorepo (pnpm + Turborepo). Web app
`apps/web`, API `apps/api`, worker `apps/worker`, `packages/adapters`
(sandbox providers incl. InstaBox), `packages/core` (screen capability,
desktop runtime), `packages/contracts` (types), `infra/sandboxes/computer`
(the Linux desktop image).

---

## 1. Rakazo computer architecture

### 1.1 Topology

```
Browser ──► Rakazo web server (same origin) ──► /novnc/* proxy ──► sandbox public host:6100
                │                                  (capability-checked, rechecked every 1s)
                ├──► API (oRPC) ──► Postgres (computer row, leases)
                └──► sandbox provider (InstaBox SDK @insforge/instabox-sdk)
```

- One computer **per bot** (`bot.computer`, `ComputerStatus`). Mode
  `team` (default, shared by the space) or `dedicated` (private).
- The computer is a **sandbox VM**, not a browser tab: the agent's work
  happens on a real Linux desktop inside it; the browser only shows a
  live stream of that desktop.
- InstaBox provider (`packages/adapters/src/instabox-sandbox.ts`):
  template `agent-browser` (the same template our machine uses), SDK
  `Sandbox.create/connect/kill`, commands via `commands.run` (10-min
  foreground limit; longer as background jobs), files via the SDK files
  API, ports published via `ports.publish(6100)`.
- **The desktop gateway is port 6100** (`SCREEN_PORT`). The shared Linux
  desktop runtime is installed into the sandbox by `PREPARE_LINUX_DESKTOP`
  (apt-installs Xvfb, xdpyinfo, x11vnc, fluxbox, xdotool, wmctrl, scrot,
  xterm, websockify, noVNC if missing; emoji font; Chromium managed
  policy: no password/address/card prompts, pop-ups allowed).

### 1.2 The desktop inside the sandbox (`packages/core/src/node/desktop-runtime.ts`)

- **Xvfb 1280x800x24**, window manager **fluxbox** (toolbar hidden,
  minimal menu: Browser / Terminal), per-display fluxbox home in /tmp.
- Each bot screen gets a managed slot: displays start at **20**
  (`DISPLAY_START`), ports start at **6100**. `managedDesktopCommand`
  returns `RAKAZO_DESKTOP=<index>:<token>`.
- **Two x11vnc servers per display** (the view/control split is enforced
  at the VNC level, not just in the UI):
  - View: `x11vnc -display :N -forever -shared -viewonly -nopw -rfbport 0 -unixsock <sock>`
  - Control: `x11vnc -display :N -forever -shared -nopw -rfbport 0 -unixsock <sock> -wait 5 -defer 5`
  - Each has its **own websockify gateway** (`viewPort` / `controlPort`
    per display index).
- Tokens are per-target (`/tmp/rakazo/desktop-targets`); a control
  token is the user's control-lease id. Tokens can be revoked per kind
  (view / control / terminal).
- Browser: per-screen Chromium profile
  (`/home/user/rakazo-home/.browser-profiles/<screen>`), launcher
  `rakazo-browser`, focus-or-launch by WM_CLASS via `wmctrl`
  (raise existing window, else spawn; Chrome URLs forward into the live
  window). Team computers share one browser identity (sign-ins
  checkpointed into the shared identity); private computers isolate it.
- Agent observation: `scrot` on the display (+ cursor via
  `xdotool getmouselocation`), base64'd back — **not** AT-SPI.
  (`packages/adapters/src/extra-displays.ts`: `observeExtraDisplayCommand`.)
- Agent actions: `xdotool` (key / click / scroll / type) and browser
  actions via the launcher; page-level tools via CDP
  (`/usr/local/bin/rakazo-page-browser`, `RAKAZO_CDP_PORT`).
- Terminal: separate `rakazo-terminal.py` server, own session URL.
- `releaseScreen`: revoke control and **keep the display + browser warm**
  for the bot's next run, or full teardown.

### 1.3 The stream path (screen URL → browser)

1. Frontend calls `rpc.computer.screenUrl({ botId })`.
2. API `screenUrl` handler (`apps/api/src/routes/computer.ts`):
   - **Everyone in the Space can watch; only the person holding
     control can drive it.** `holder = holdsComputerControl(...)`.
   - `sandbox.connectScreen({ view: "stream", interactive: holder,
     controlToken: holder ? controlLeaseId : undefined })` → provider
     returns `https://<sandbox-host>/vnc.html` (view port or control
     port, with token).
   - The URL is sealed into a **capability**:
     `addScreenProxyCapability(withViewOnly(url, !holder), secret,
     webOrigin, { botId, computerId, botGeneration, computerGeneration,
     controlLeaseId }, headers)`.
3. Capability (`packages/core/src/node/screen-capability.ts`):
   - `AES-256-GCM` seal; path
     `/novnc/session/{view|control}/{expiresAt}.{token}`.
   - TTL **60 min** (`SCREEN_PROXY_TTL_MS`); the sealed payload holds
     the upstream URL, the scope (bot/computer generations +
     controlLeaseId), and optional upstream auth headers — the
     provider's nested socket token **stays sealed server-side** and
     never reaches the browser.
   - The noVNC URL params are set by the sealer:
     `autoconnect=true&resize=scale&view_only=<bool>&path=<capability>/websockify`.
4. The **web server proxies `/novnc/*`** (`apps/web/src/screen-proxy.ts`,
   `standalone-server.ts`): it does NOT decrypt the capability itself —
   it asks the API (`POST /api/internal/screen-target`, bearer secret)
   to resolve the path to a target, then proxies HTTP + WebSocket to it.
   - **Recheck every 1 s** (`SCREEN_RECHECK_MS`) for open streams
     (`watchScreenAuthorization`): a refusal ends the stream at once;
     an unreachable authority is ridden out for at most **6 s**
     (`SCREEN_UNCONFIRMED_MAX_MS`), never past the capability expiry.
   - Fail-closed throughout. Header allowlist only; the browser's
     `Origin` is rewritten to the target's origin (Boat refuses
     cross-origin sockets otherwise).
5. **noVNC shim injection** (`apps/web/src/novnc-html.ts`): the proxy
   fetches uncompressed noVNC HTML (max 1 MB, `accept-encoding:
   identity`, no validators so no 304) and injects a `<script>`:
   - Replaces `localStorage`/`sessionStorage` with in-memory versions
     (the iframe is sandboxed without same-origin, so storage throws).
   - Hides `#noVNC_status` (it names the provider host); in view-only
     mode hides `#noVNC_control_bar_anchor` too.
   - Reports screen state to the parent via `postMessage`
     (`{ rakazoScreen: loading|connecting|connected|failed|disconnected }`,
     with detail on failure) by watching noVNC's CSS classes and status
     bar; also forwards to `ReactNativeWebView` on mobile.
   - Accepts exactly one parent message, `{ rakazoScreenFocus: true }`,
     to focus the canvas after a reconnect.
   - Deletes `window.VideoDecoder` (Android H.264 probe hang), swallows
     browser-extension script errors.
   - Rewritten pages are served `cache-control: no-store, no-transform`,
     no etag/last-modified — never cached.
6. The framed page's **state drives the parent** (`use-computer.tsx`):
   the parent probes the screen URL first (`fetch`, `redirect: manual`;
   403 = "link expired", 502/timeout = "screen did not respond"), and
   auto-reconnects on drop with backoff and per-bot reconnect budgets.
   A **held predecessor frame stays mounted on top** while a new frame
   connects, so taking/releasing control never blanks the screen; the
   held frame is dropped once the new one reports, or after the 15 s
   load timeout (`SCREEN_FRAME_LOAD_TIMEOUT_MS`).

### 1.4 Frontend: where the computer lives

- **Right bot sidebar (~316 px, resizable)** in the Shell, opened by
  clicking the bot name in the chat header. Tabs: **Computer /
  Routines / Pages / Advanced**. Advanced holds the Team vs Private
  computer toggle. The computer is per-bot; switching bots switches the
  computer (per-bot cache, max 20, so switching back paints instantly).
- **Side-panel preview** (`computer-panel.tsx`): a 16:10 iframe
  ("Bot screen preview", `pointerEvents: none`, always view-only) with
  an "Open" pill on hover. Idle computers show "Asleep" + **Wake**
  button (an idle computer only wakes from its button, never from a
  click on the preview, because a boot costs money). Disk-full warning
  inline (Clean up / Dismiss).
- **Full-window view** (`computer-overlay.tsx`): a **full-viewport
  overlay on the chat page, not a new tab** (`fixed inset-0 z-30`);
  the URL stays on the chat page. Header: bot avatar + "Team
  Computer" / "<Bot>'s computer", Stop button while a run is active,
  **Take control** (or release actions while holding), Teach a task,
  X Close computer. Closing returns to the side panel; it does **not**
  stop the machine (Esc also closes).
- The live screen is an **iframe** (`sandbox="allow-scripts
  allow-pointer-lock"`, `allow="clipboard-read; clipboard-write;
  fullscreen"`). Its `pointerEvents` is `"none"` unless the user holds
  control — **that is the take-control gate in the UI**: the screen is
  strictly view-only until you take control. (No separate fullscreen
  button — the overlay IS the fullscreen.)
- Booting shows "Booting live desktop…" with a spinner, inline.
  Stopped/suspended shows "Computer is asleep / stopped" + Start.
  Errors show "Screen not connected" + the error + **Retry screen**.

### 1.5 Take control — the lease

(`apps/api/src/computer-control.ts`, `apps/api/src/routes/computer.ts`,
`packages/adapters/src/computer-control.ts`)

- Control is a **lease row on the computer** in Postgres:
  `controlHolder` (`bot`/`user`/`none`), `controlLeaseId` (UUID),
  `controlLeaseExpiresAt`, `controlBotId`, `controlUserId`,
  `controlFence` (incremented on every grant — a fencing token).
- `takeComputerControl` (RPC `computer.takeover`):
  - Requires the computer running; refuses if another person holds it
    (`CONFLICT "Someone else is using this computer"`).
  - Grants **atomically**: `updateMany` where `controlHolder !=
    "user"` and `controlLeaseId == null`; a bot action already running
    may finish, but **every action after the grant is refused** (the
    executor checks the fence/lease before acting).
  - Lease lifetime **90 s** (`COMPUTER_CONTROL_LEASE_MS = 90_000`),
    renewed by the holder's page heartbeat every **15 s**
    (`COMPUTER_CONTROL_HEARTBEAT_MS`; plain heartbeat 60 s).
    **Only a visible page checks in** — a hidden/forgotten tab lapses
    control ~90 s after it was hidden. A scheduled job revokes expired
    leases.
  - The grant emits a `computer.takeover.granted` event in the thread.
- Release (RPC `computer.release`): on overlay close, chat switch,
  pagehide (with `keepalive: true`), or Done/Skip on a needs-you card.
  **The release names the lease id**, so a late release from an old
  page can never end newer control. Releasing schedules the computer's
  idle sleep.
- After handback the bot **re-reads the screen before acting**; taking
  over one bot never blocks others (one holder per computer).
- The screen URL is **re-read on takeover/release**, because the
  capability policy flips view↔control (a new capability URL → a new
  frame; the held-frame logic covers the swap).

### 1.6 Needs-you flow (bot asks for help)

- When the agent hits sign-in / CAPTCHA / passkey / payment, its run
  goes to status **`waiting_takeover`** and a **ComputerCard** appears
  in chat: "Needs you" + the bot's message + a **live screen preview
  image** (RPC `computer.preview` — an `observe` screenshot, only
  while the run still waits, refetched on window focus, `gcTime: 0` so
  a later request never paints an earlier screen) + buttons **Skip**,
  **I'm done**, **Take control** (opens the computer with control).
- Answering (Done/Skip) releases control first, then resolves the run
  and enqueues the takeover continuation; a refused answer changes
  nothing. Settled cards fold to one line ("Done · …" / "Skipped · …")
  with an Open button.
- Only the person the bot asked can answer ("The bot is waiting for
  someone else").

### 1.7 Wake / boot / sleep

- Opening the Computer panel **auto-boots** a non-running computer
  (`bootComputer`, `force: true`): RPC `computer.boot` acquires an
  **execution lease** (retries 20×250 ms if a run just finished, so a
  boot racing a run's end is not refused as busy), then provisions
  (create or resume the sandbox) + prepares the desktop runtime.
- `scheduleComputerSleep` after activity; idle-sleep + a 2 h active cap
  on billed providers. On InstaBox, stopping = suspend with memory and
  InstaBox's own 30-min idle pause applies.
- Maintenance (`…` menu → `ComputerMaintenanceActions`):
  **Stop computer** (`computer.stop`), **Recover** (recreate a broken
  computer), **Reset** (restore the last saved workspace),
  **Update** (save the workspace and install current software) — via
  `computer.replace` modes `recover`/`reset`/`update`, with a confirm
  dialog for reset/recover. Stopping/resetting/updating while someone
  else holds control is refused.

### 1.8 Teach a task (teach-by-showing)

- "Teach a task" button → popover "What result will you demonstrate?"
  → Start recording. While recording, the user's inputs on the screen
  are captured via RPC `computer.input` (pointer / key / clipboard /
  scroll, each with a `sensitive` flag for passwords and an optional
  `skillId`) and recorded by `taught-skills.ts`.
- Stopping the recording opens a **draft skill editor**: Name, When to
  use, Inputs, Steps, How to check, What to return, Approval
  boundaries, Failure handling — with **Save / Test / Add to routine**.
  (The overlay shows a recording chrome while active; `TeachCaptureOverlay`
  draws the capture region.)

### 1.9 Chat relation

- The computer is the agent's workspace; the **chat is the
  record/control surface**. Every tool call is listed inline in chat
  with per-call succeeded/failed status: Computer observe/act, Browser
  navigate/snapshot/act, Shell, List files, Read file, Write file, Open
  path, Launch app; also "User computer shell/observe/act" and "Request
  takeover" (the agent asking for help).
- The computer view **does not auto-open while the agent works** — the
  user opens it manually.
- The agent runs a tool-call loop (Pi agent runtime) over
  OpenAI-compatible requests; the live session's backend was described
  as orchestrating requests to `gpt-6-astra` in that loop.

### 1.10 Mapping: live session (04:16–04:20 IST) → mechanism

| Observed | Mechanism (repo) |
|---|---|
| Right sidebar 316 px, tabs Computer/Routines/Pages/Advanced; computer per-bot; Team vs Private toggle in Advanced | Shell right panel (`panel === "computer"`); `ComputerMode` team/dedicated; per-bot `computerCacheRef` |
| Asleep + Wake → "Booting live desktop…" | Idle preview + `bootComputer({force:true})` via `computer.boot` + execution lease |
| Side-panel preview rendered BLACK this session; full-window was reliable | Preview and overlay frame the same capability URL; a frame that never reports "connected" shows nothing (black). The overlay remounts a fresh frame with its own probe/reconnect cycle, so it recovers where the preview stayed black. (Known weak spot: the preview has no separate retry beyond the shared reconnect budget.) |
| Transient black frame right after opening and after releasing control, recovering in 1–2 s | Takeover/release changes the capability policy (view↔control) → new URL → new frame mounts; the held predecessor frame is dropped after the 15 s timeout or on error, and the new frame takes ~1–2 s to connect. The black flash is the gap between frames. |
| Full-window is an overlay, URL stays on chat; closing returns to side panel, machine keeps running | `ComputerOverlay` (`fixed inset-0 z-30`); Close only sets `computerOpen=false`; stop is a separate action |
| "Take control" → green "You have control" pill, button becomes "Release control"; mouse/keyboard drive the desktop | `takeComputerControl` lease (90 s, 15 s heartbeat); `hasControl` flips iframe `pointerEvents` none→auto and swaps the header buttons; release names the lease |
| No separate fullscreen button | The overlay IS the fullscreen |
| "…" menu: Stop / Recover / Reset / Update | `ComputerMaintenanceActions` → `computer.stop` / `computer.replace` (recover/reset/update) |
| Teach a task popover → recording → draft skill editor (Name/When/Inputs/Steps/How to check/What to return/Approval boundaries/Failure handling) + Save/Test/Add to routine | `TeachComputerOverlayControl` goal popover; `computer.input` recording; taught-skill draft |
| Tool calls listed inline with status; "Request takeover" | Run tool-call list; agent takeover request → `waiting_takeover` run + ComputerCard |
| Computer does not auto-open while the agent works | By design: `computerOpen` only set by explicit user action |

---

## 2. Gap list — Rakazo vs our system

Our system today: QwenPaw console on InstaBox Free behind
`qwenpawx.pages.dev`; real XFCE desktop (Xvfb :1, Xvnc :1/:99,
websockify 6080/6081); embedded `/desktop` (noVNC via a Pages worker
gate + 12 h HMAC cookie, token = `DESKTOP_ORIGIN_TOKEN` Worker secret);
dashboard stream link (InstaBox `desktop/stream`, 24 h token);
Camoufox bridge (`POST /desktop-open`); QwenPaw→desktop computer-use
MCP (`mcp-proxy`, DriverCard `computer-use.yaml`, `open-computer-use`
1.1.4). `/desktop` renders and stays rendered (verified live).

| # | Gap | Ours today | Rakazo |
|---|---|---|---|
| G1 | **No take-control lease.** No fencing token, no expiry/heartbeat, no lease-named release, no "you have control" state in the UI. | InstaBox `desktop` takeover action flips `controller: human/agent` (30 s idle handback); the MCP proxy refuses input tools while a human holds it. But: the dashboard viewer shows **no take-control button at all**; `/desktop` noVNC is **always interactive** for anyone who reaches it; nothing distinguishes watch vs drive. | Lease row (UUID, 90 s, fence counter, atomic grant, 15 s visible-page heartbeat, release names the lease, bot actions refused after grant, re-read on handback). |
| G2 | **No view/control split.** One websockify, one VNC server, no password, no `view_only`. | 6081 serves `:1` with `SecurityTypes None`; anyone with a valid desktop cookie drives the desktop. | Separate view-only + control x11vnc servers and websockify ports per display; `view_only` param; capability policy in the URL; iframe `pointerEvents: none` unless holding control; control bar hidden in view-only. |
| G3 | **Screen capability is coarse.** No scope, no short TTL, no recheck, no revocation on lease change. | 12 h HMAC cookie (`qwenpaw_desktop`, keyed by the origin token) minted by `/desktop/__verify` after a QwenPaw-token check. Valid until expiry regardless of takeover/release; no per-request re-authorisation. | AES-256-GCM sealed capability, 60-min TTL, scope `{botId, computerId, botGeneration, computerGeneration, controlLeaseId}`, authority recheck every 1 s, stream killed on denial, old generations invalid. |
| G4 | **No screen state machine / probe / reconnect / held-frame.** | noVNC `autoconnect=true&resize=scale&reconnect=true` does all of it; the worker does not probe the screen URL, does not read noVNC state, and has no held frame. (This is exactly the class of bug that produced our /desktop fallback-to-chat and transient-black issues.) | Pre-probe (`redirect: manual`; 403 = expired, 502 = no response), `rakazoScreen` postMessage states, auto-reconnect with backoff and per-bot budgets, held predecessor frame during view↔control swaps, keyboard refocus after reconnect. |
| G5 | **No needs-you flow.** The agent cannot ask for help in chat; no waiting state, no preview card, no Done/Skip. | Nothing. (Our ticket board / groupchat could carry the card, but no wiring exists.) | `waiting_takeover` run + ComputerCard with live preview image + Skip / I'm done / Take control. |
| G6 | **No wake/boot from the UI.** No Asleep state, no Wake button, no booting spinner in `/desktop`. | `/desktop` assumes the desktop is up. If the VM paused, the user gets the keep-alive Worker's wake page via the console route, not from `/desktop`. | Idle preview ("Asleep" + Wake), auto-boot on panel open, "Booting live desktop…" spinner, Start for stopped/suspended. |
| G7 | **Agent screenshot path differs** (separate fix already running — do not duplicate). | Agent screenshot via AT-SPI `get_app_state` (open-computer-use); the "screenshot of the desktop" call still returns a bare desktop while the live view shows the window. | Agent observes via `scrot` on the display (+ cursor); the same composited framebuffer VNC shows. |
| G8 | **No teach-by-showing.** No input recording, no draft-skill editor. | Nothing. (Skill pool exists; no recorder.) | `computer.input` recording (pointer/key/clipboard/scroll + `sensitive` flag) → draft skill editor → Save/Test/Add to routine. |
| G9 | **No per-bot computers / Team vs Private.** | One shared desktop for the single default agent. | Per-bot computers; Team (shared files/browser identity, one driver at a time) vs Private (isolated home + browser identity). |
| G10 | **No maintenance actions in the UI.** | Stop/Recover/Reset exist only as InstaBox API actions via `ib.py`; no UI. | `…` menu: Stop / Recover / Reset / Update (with confirm dialogs for reset/recover). |
| G11 | **No terminal in the computer view.** | No terminal tab. (The Camoufox bridge has no terminal UI either.) | `terminalUrl` — separate terminal session, control-holder only. |
| G12 | **No screen preview in chat.** | Agent screenshots exist as chat attachments only when asked. | `computer.preview` — live screenshot thumbnail inside the needs-you card, refetched on focus. |
| G13 | **Heavier desktop stack.** | XFCE at 1920x1080 on `:1`. Works, but heavier than Rakazo's. | fluxbox at 1280x800, toolbar hidden — lighter, and matches Rakazo's own image. (Not a functional gap; a weight choice.) |
| G14 | **No screen generation / fencing.** Old screen URLs stay valid until the 12 h cookie expires. | Cookie only. | `botGeneration`/`computerGeneration` in the capability scope; replacing a screen invalidates old URLs. |
| G15 | **Chat tool-call display.** (Verify, not assumed.) | QwenPaw console lists tool calls in chat; whether computer-use calls show with succeeded/failed status like Rakazo's inline list needs one look at a live chat. | Every tool call listed inline with per-call status, incl. "Request takeover". |

---

## 3. Build plan (prioritised)

### P0 — make take-control real and safe

1. **View/control split for `/desktop`** — the single biggest behavioural
   gap. Run a second, view-only x11vnc + websockify for `:1`
   (mirror Rakazo: `-viewonly` VNC on its own port), serve it as the
   default `/desktop` view, and require an explicit Take Control to
   switch to the interactive port. Enforce `view_only` at the noVNC
   level too (Rakazo sets it on `/vnc.html` via `screenPolicyPath`).
   Files: new systemd unit `desktop-novnc-view.service` (machine),
   `pages/public/_worker.js` (`/desktop` branch: view vs control
   origin), `features/desktop/README.md`. Also publish the view port
   private (like 6081) and keep its token server-side only.
2. **Take-control lease in the Worker** — implement Rakazo's lease in
   Cloudflare KV: `POST /desktop/__takeover` mints a lease
   (`leaseId` UUID, 90 s expiry, fence counter); the visible `/desktop`
   page heartbeats `POST /desktop/__heartbeat` every 15 s (only while
   `document.visibilityState === "visible"`); `POST /desktop/__release`
   with the lease id on Close / pagehide (`keepalive: true`) / tab
   switch. The MCP proxy refuses input tools unless the *agent* holds
   the lease (agent holds it while running; a user takeover revokes it
   and the agent re-reads the screen on handback — mirroring Rakazo's
   execution-lease fence). Files: `pages/public/_worker.js`,
   `features/desktop/mcp-computer-use.service` (proxy side),
   `features/desktop/computer-use.yaml` (policy note).
3. **Capability URLs with scope + short TTL + recheck** — replace the
   12 h HMAC cookie with a sealed capability (AES-GCM via WebCrypto in
   the Worker): 60-min TTL, scope `{leaseId, generation}`, path
   `/desktop/session/{view|control}/{expiresAt}.{token}`. Bump a
   generation counter in KV on every takeover/release/screen replace so
   old URLs die. The worker re-validates the capability on every
   request (and, for the WebSocket, on a 1 s recheck that closes the
   socket on denial — Rakazo's `watchScreenAuthorization` pattern).
   Files: `pages/public/_worker.js`, `features/desktop/harness-desktop-gate.mjs`
   (extend: capability mint/verify, generation bump, WS recheck).

### P1 — UX parity (the things the user actually saw on grokagent.pages.dev)

4. **Overlay chrome on `/desktop`** — the embedded view currently
   redirects straight to bare `vnc.html`. Serve a Rakazo-style header
   above the iframe instead: bot/agent name, **Take control** /
   green **"You have control"** pill → **Release control**, Teach a
   task (P3), `…` menu (P1 item 7), X Close (back to `/chat`, machine
   keeps running). The iframe gets `pointer-events: none` until control
   is held (G1/G2 make this meaningful). Files: `pages/public/_worker.js`
   (serve the chrome page; the iframe keeps `/desktop/vnc.html`).
5. **noVNC shim injection in the worker** — copy Rakazo's
   `injectNovncStorageShim`: rewrite `vnc.html` responses (uncompressed
   only, `no-store, no-transform`): in-memory storage shim, hide
   `#noVNC_status` (it leaks the origin host) and the control bar in
   view-only mode, post `rakazoScreen`-style state messages
   (loading/connecting/connected/failed/disconnected) to the parent,
   accept only a focus message back. The chrome page uses those states
   for "Connecting… / Connected / Screen not connected + Retry" and for
   auto-reconnect with backoff; keep a held predecessor iframe during
   view↔control swaps so the screen never blanks (this directly fixes
   the transient-black class of bug). Files: `pages/public/_worker.js`,
   `features/desktop/harness-desktop-gate.mjs`.
6. **Wake / Asleep / booting states in `/desktop`** — when the desktop
   or VM is down, show "Computer is asleep" + **Wake** (calls the
   existing keep-alive wake path) and "Booting live desktop…" while it
   wakes; auto-wake on opening `/desktop` is optional (Rakazo auto-boots
   on panel open; on Free, a wake costs run time, so keep it a button
   first). Files: `pages/public/_worker.js` (status via the keep-alive
   Worker's KV status), `features/desktop/README.md`.
7. **Maintenance actions in the `…` menu** — Stop / Recover / Reset /
   Update, calling the InstaBox desktop API through a Worker endpoint.
   Needs `INSTABOX_API_KEY` as a Worker secret (currently NOT set on
   the keep-alive Worker — the wake path works without it; this needs
   it). Confirm dialogs for Reset/Recover, as Rakazo does. Files:
   `pages/public/_worker.js` (new `POST /desktop/__action`), Worker
   secret setup, `features/desktop/README.md`.

### P2 — agent-side parity

8. **Needs-you card (minimal)** — when the agent hits a sign-in/CAPTCHA
   it needs a way to ask. Minimal version without a QwenPaw patch: a
   skill/bridge endpoint the agent calls (`POST /desktop-open`-style)
   that writes a "needs-you" record to KV; `/desktop` and the console
   status page show a banner with the agent's message + a live preview
   (screenshot via the bridge) + **Skip / I'm done / Take control**.
   Answering releases control and tells the agent to continue (via the
   existing groupchat/routines channel or a new chat message). Files:
   new bridge endpoint + skill text, `pages/public/_worker.js`
   (banner + preview), `features/board/` (reuse the ticket board
   pattern for the card store). Full parity (run state
   `waiting_takeover` + in-chat card) needs a QwenPaw-side change and
   is out of scope for this round.
9. **Agent observe via `scrot`** — align the agent's screenshot with
   Rakazo's (composited framebuffer, not AT-SPI). **Coordinate with the
   screenshot fix already running (user said yes 04:12 IST); do not
   duplicate it.** Files: bridge / MCP proxy (whichever that fix lands
   in).
10. **Terminal tab** — Rakazo's `terminalUrl` is a separate session for
    the control holder. Minimal: a "Terminal" button in the `/desktop`
    chrome that opens a terminal on `:1` (e.g. `xterm` via the bridge,
    or a ttyd-style page if one is added). Needs design; defer until
    P0–P1 land.

### P3 — later / out of scope for now

11. **Teach-by-showing** — record user inputs on `/desktop` (pointer/
    key/clipboard/scroll + a `sensitive` flag for passwords) and draft
    a skill in an editor (Name / When / Inputs / Steps / How to check /
    What to return / Approval boundaries / Failure handling) with
    Save / Test / Add to routine. Big lift; needs the P0 lease (so
    recording knows who is driving) and a skill-draft store. Defer.
12. **Team vs Private toggle** — single user, single desktop today;
    skip. (Revisit if a second agent/desktop is ever added.)
13. **Side-panel preview beside the chat** — would need a QwenPaw
    console patch (the console is a Docker image, not our code). The
    `/desktop` overlay is the equivalent; skip.
14. **Fluxbox / 1280x800** — optional weight saving; XFCE at 1920x1080
    works and the user already watches it. Do not churn a working
    desktop for this.

### Suggested order of work

P0-1 (view/control split) → P0-2 (lease) → P0-3 (capability) → P1-4
(chrome + Take control button) → P1-5 (shim + state machine) → P1-6
(wake states) → P1-7 (maintenance) → P2-8 (needs-you card) → P2-10
(terminal) → P3-11 (teach). Each step is independently verifiable in
a real browser before the next starts (the rule from the last three
fix rounds: never hand a link to the user until it renders).

---

## 4. Unknowns (what the repo alone cannot settle)

- **Hosted vs repo drift**: `grokagent.pages.dev` ("AgentX") may run a
  different build than repo HEAD `0c97840` (newer, older, or forked).
  The black side-panel preview in the live session could be a
  hosted-only quirk or a real preview-frame weakness — the repo's
  preview shares the overlay's reconnect logic, so a re-check on the
  live site (open the panel again after the computer is warm) would
  settle it.
- **Which sandbox provider the hosted site uses**: the repo supports
  E2B, Novita, Daytona, CreateOS, Boat, boxd, Railway, InstaBox, local
  Docker, etc. The live session did not reveal the provider; the
  mechanisms above are provider-independent, but timings (boot speed,
  idle sleep) differ per provider.
- **The InstaBox dashboard viewer's take-control**: the dashboard
  stream link is InstaBox's own viewer, not Rakazo's — the repo says
  nothing about whether/how it offers take-control (the parent's live
  check found no take-control button in it). The Rakazo answer is the
  in-app overlay, not the dashboard link.
- **Teach recording internals**: `taught-skills.ts` (draft generation
  from recorded inputs) was not read in full; the editor fields are
  known from the live session, the draft-generation heuristics are not.
- **Exact noVNC version / shim deltas on the hosted site** vs the repo's
  `injectNovncStorageShim` — the live overlay behaved as the repo
  describes, so any delta is cosmetic.

## 5. File index (repo paths behind the claims above)

- Frontend state + controls: `apps/web/src/pages/shell/use-computer.tsx`
- Overlay + panel: `apps/web/src/pages/shell/computer-overlay.tsx`,
  `apps/web/src/pages/shell/computer-panel.tsx`,
  `apps/web/src/pages/shell/computer-view.tsx`
- Screen URL/probe/reconnect/held-frame: `apps/web/src/lib/computer-screen.ts`
- noVNC proxy + shim: `apps/web/src/screen-proxy.ts`,
  `apps/web/src/novnc-html.ts`, `apps/web/src/standalone-server.ts`
- Capability seal/verify: `packages/core/src/node/screen-capability.ts`
- API surface: `apps/api/src/routes/computer.ts`,
  `apps/api/src/computer-control.ts`
- Take-control lease + expiry: `packages/adapters/src/computer-control.ts`,
  `packages/core/src/screen-reconnect.ts` (90 s lease, 15 s/60 s heartbeats)
- InstaBox provider: `packages/adapters/src/instabox-sandbox.ts`
  (template `agent-browser`, gateway port **6100**)
- Shared desktop runtime: `packages/adapters/src/remote-desktop-sandbox.ts`,
  `packages/adapters/src/linux-desktop.ts`,
  `packages/core/src/node/desktop-runtime.ts`
- Agent observe/act: `packages/adapters/src/extra-displays.ts`
  (`scrot` + cursor; `xdotool` actions)
- Needs-you card: `apps/web/src/components/ComputerCard.tsx`
- Maintenance menu: `apps/web/src/components/ComputerMaintenanceActions.tsx`
- Teach: `apps/web/src/components/teach/TeachComputerOverlay.tsx`,
  `apps/api/src/taught-skills.ts`
- Types: `packages/contracts/src/computer.ts` (`ComputerStatus`)
- Desktop image: `infra/sandboxes/computer/` (Dockerfile, fluxbox,
  `rakazo-browser`, `rakazo-page-browser`, `embed.html`)
