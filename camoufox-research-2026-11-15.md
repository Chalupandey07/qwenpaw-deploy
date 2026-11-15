# Camoufox × QwenPaw integration-seam research — 2026-11-15

Research only. Nothing installed, edited, restarted, or snapshotted.
Machine `m_agq5wqqo2fvypym7rjlpvngc2m` (InstaBox Free, Debian 13), QwenPaw
`agentscope/qwenpaw:v2.3.0`, container `qwenpaw` (Up, healthy).
GPT Astra was tried once for a design sanity-check and timed out after 120 s
(no answer); every conclusion below is from source read live on the machine,
not from Astra.

## TL;DR verdict

**No — QwenPaw's SDK cannot be pointed at Camoufox directly.** There is no
config knob, env var, or endpoint that does it. All three "obvious" seams
are dead ends (evidence in §1). A bridge is required. The smallest honest
designs are §2; recommended is **Option C** (Playwright-server + a small
QwenPaw `ControlLink` patch) if patching QwenPaw is acceptable, else
**Option B** (standalone HTTP bridge + a QwenPaw skill) if QwenPaw must stay
pristine. Camoufox itself must run in **its own venv on the host**
(or a sidecar container), never inside QwenPaw's venv/image.

---

## 1. The exact seams (with file:line quotes)

### 1a. QwenPaw only speaks Chromium — by construction

Config — `/app/src/qwenpaw/config/config.py:3294-3362` (`BrowserConfig`):

```python
class BrowserConfig(BaseModel):
    backend: Literal["auto", "launch", "managed_cdp", "connect_cdp"] = "auto"
    ...
    cdp_url: Optional[str] = None
    cdp_port: int = 0
    engine: Literal["auto", "chromium"] = "auto"   # <-- firefox is NOT a value
    channel: Optional[str] = None
    executable_path: Optional[str] = None
```

```python
# config.py, _migrate_unsupported_engine (field_validator on "engine")
if value in {"webkit", "firefox"}:
    logger.warning(
        "browser.engine %r is not supported by the unified browser; "
        "falling back to auto", value,
    )
    return "auto"
```

So `browser.engine="firefox"` is silently rewritten to `"auto"` (= Chromium).
Live config confirms the defaults (`/app/working/config.json`, i.e.
`/data/home/qwenpaw/working/config.json` on the host):

```json
{"backend": "auto", "engine": "auto", "executable_path": null,
 "cdp_url": null, "cdp_port": 0, "channel": null, "headless": "auto", ...}
```

Identity routing — `/app/src/qwenpaw/browser/runtime/identity.py:7-10`:

```python
_ENGINE_VARIANT = {
    "auto": "playwright",
    "launch": "playwright",
    "managed_cdp": "cdp",
    "connect_cdp": "cdp",
}
```

Only two variants exist: `playwright` and `cdp` (plus `chrome` for the
extension identity). There is no firefox variant to select.

### 1b. The Playwright path hard-codes `chromium.launch`

`/app/src/qwenpaw/browser/control_link/playwright/adapter.py:71-95`
(`_build_launch_kwargs`):

```python
engine = str(params.get("engine") or "chromium")
if engine != "chromium":
    raise _fatal(f"engine not wired yet: {engine}", engine)
launch: dict[str, Any] = {"headless": bool(params.get("headless", True))}
channel, executable_path = _resolved_launch_binary(params)
if channel:
    launch["channel"] = channel
elif executable_path:
    launch["executable_path"] = executable_path
```

`/app/src/qwenpaw/browser/control_link/playwright/adapter.py:381,397`
(`_create_session_context` — the only two launch calls in the file):

```python
context = await self._pw.chromium.launch_persistent_context(
    user_data_dir, **launch_kwargs, **context_kwargs)
...
browser = await self._pw.chromium.launch(**launch_kwargs)
```

A repo-wide grep over `/app/src/qwenpaw/browser/*.py` finds **zero**
occurrences of `firefox`, zero of `connect_over_cdp`, zero of any
`playwright.*.connect(` call. The string `firefox` appears only as
`firefox_user_prefs` in Camoufox's own docs, never in QwenPaw code.

**Dead end 1 — `executable_path` → Camoufox binary:** the path is passed to
`chromium.launch()`. Playwright would exec a Firefox binary with Chromium
flags/expectations and fail. It is a Chromium-binary knob, not a
bring-your-own-engine knob.

**Dead end 2 — `connect_cdp` → Camoufox:** the CDP backend is Chromium CDP,
not a generic remote-browser endpoint.
`/app/src/qwenpaw/browser/control_link/cdp/adapter.py:378-390`
(`_m_open_session`, `backend == "connect_cdp"`):

```python
await self._connect(owner[0], str(params["cdp_url"]))
version = await self._transport_for(owner[0]).send("Browser.getVersion", {}, ...)
headless = str(version.get("product", "")).startswith("HeadlessChrome")
```

`/app/src/qwenpaw/browser/control_link/cdp/transport.py:18-24,26-46`
(`CdpTransport.connect`): an `http(s)://` URL is resolved via
`GET <base>/json/version` → `webSocketDebuggerUrl`; otherwise a raw `ws://`
is used. `/app/src/qwenpaw/browser/control_link/cdp/launch.py:44-72`
(`spawn_managed_chromium`) launches
`[executable, --remote-debugging-port=<port>, --user-data-dir=<dir>]`
(+ `--headless=new`). The adapter then issues Chromium-only CDP domains
(`Target.createBrowserContext`, `Page.*`, `Browser.getVersion` with a
`HeadlessChrome` product check). Firefox implements no Chromium CDP endpoint
(`/json/version`, `Target.*`); Camoufox exposes no `--remote-debugging-port`
CDP server at all. It speaks Playwright's Juggler protocol for Firefox.

**Dead end 3 — Camoufox `launch_server` ws endpoint:** Camoufox's server
(`python/src/camoufox/server.py`, `launch_server(**kwargs)`) blocks
(`NoReturn`), prints a ws endpoint, and is implemented by
`python/src/camoufox/launchServer.js`, which calls
`playwright.firefox.launchServer(options)` and prints
`browserServer.wsEndpoint()`. The only client is
`playwright.firefox.connect(endpoint)` (Playwright protocol, not CDP, not
HTTP). QwenPaw has no such call anywhere, so the endpoint is unreachable
from the SDK as shipped. Note also: `launch_server` rejects persistent
contexts outright (`ValueError` for `persistent_context` / `user_data_dir`).

### 1c. What the tool returns (what a bridge must reproduce)

Entry: `/app/src/qwenpaw/browser/tool_entrypoint.py` — `run_browser_tool(code)`
sends the agent's `code=` program to a subprocess worker kernel
(`execution/kernel.py`, `execution/worker.py`); the SDK in scope is `Browser`
(`Browser.connect()`, `browser.open(url)`, …). `Browser.connect()` signature:
`/app/src/qwenpaw/browser/sdk/facade.py:274-334` —
`connect(*, identity: Literal["auto","user","avatar","guest"] = "auto")`.

Per page (`/app/src/qwenpaw/browser/sdk/page.py:84-181`, and the skill doc
`/app/venv/lib/python3.11/site-packages/qwenpaw/agents/skills/browser-en/SKILL.md`):

- `await page.goto(url)` → result dict (raw navigation facts)
- `await page.snapshot(query=None)` → `Observation`, read `.text` — an
  accessibility-tree + visible-DOM-text projection
  (`runtime/observation/__init__.py`: "this snapshot captures the
  accessibility tree plus visible DOM text; visual-only, off-screen,
  closed-shadow-root, and cross-iframe completeness is unverified")
- `await page.screenshot()` → `{"path": ...}` — PNG persisted into the
  active workspace (`control_link/cdp_verbs.py:165-171`,
  `persist_screenshot_async`: `browser_screenshot_<sha8>.png`)
- locators are a **subset** of Playwright's locator API
  (`get_by_role/text/label/placeholder`, `locator()`, `frame_locator()`,
  `click/fill/type/press/check/hover/scroll/wait_for/bounding_box`, …);
  "element_handle / raw CDP unavailable" (SKILL.md:166)
- `wait_for_load_state("networkidle")`: Playwright backend waits for true
  quiescence; CDP backends degrade to `document.readyState == "complete"`
  + 500 ms (SKILL.md:109-110)

So a bridge must supply at minimum: navigate, AX/DOM-text snapshot,
screenshot-to-workspace-file, and locator click/fill — or the agent loses
the SDK surface it is written against.

### 1d. The intended extension point (this is the real seam)

`/app/src/qwenpaw/browser/runtime/ports.py` — the `ControlLink` protocol:

```python
@runtime_checkable
class ControlLink(Protocol):
    @property
    def variant(self) -> str: ...
    def is_available(self) -> bool: ...
    async def request(self, method, params, *, timeout=None) -> Mapping[str, Any]: ...
    def on_event(self, sink: EventSink) -> Callable[[], None]: ...
```

`/app/src/qwenpaw/browser/runtime/links.py`:

```python
def register_local(link: "ControlLink", *, priority: bool = False) -> None: ...
def bind_external(source: Callable[[], Iterable["ControlLink"]]) -> None: ...
def link_for(variant: str) -> "ControlLink | None": ...
```

`Engine.connect` (`runtime/engine.py`, `connect()`) does:
`load_config().browser` → `resolve_identity(...)` → `link_for(variant)` →
`resolve_launch_env(config)` → `build_session(link, ..., launch=launch, ...)`.
A new variant (e.g. `"camoufox"`) would need: a `ControlLink`
implementation, registration via `register_local`/`bind_external`, a new
`backend` literal in `BrowserConfig`, and an entry in `_ENGINE_VARIANT`.
That is a source patch to QwenPaw, not a config change — but it is the
designed seam, and the Playwright adapter's verb implementations
(`_m_navigate`, `_m_snapshot`, `_m_screenshot`, `_m_input`, … in
`control_link/playwright/adapter.py`, ~900 lines) operate on Playwright
`Page`/`Locator` objects and are largely engine-agnostic once a `Page`
exists; only the two `chromium.launch*` calls (§1b) are engine-specific.

---

## 2. Verdict and bridge designs

**Direct pointing: NO.** `executable_path` → Chromium only; `connect_cdp` →
Chromium CDP only; no `firefox.launch` / `firefox.connect` anywhere in
QwenPaw. A bridge is required.

### Option A — New QwenPaw `ControlLink` variant (in-process Camoufox)
Implement a `CamoufoxControlLink` mirroring
`control_link/playwright/adapter.py`, but calling
`playwright.firefox.launch(executable_path=<camoufox-bin>, **camoufox.launch_options(...))`
(Camoufox `sync_api.NewBrowser` / `launch_options()` — see §4) in the
browser worker subprocess, register it with `register_local`, add
`backend="camoufox"` + `_ENGINE_VARIANT` entry.
- Pros: full SDK preserved (snapshot, locators, screenshots, sessions,
  identity model); no second service; lowest latency.
- Cons: biggest patch (new backend literal, identity mapping, verb
  parity for the CDP-tree/AX snapshot path, which is Chromium-flavoured);
  **must run in a venv with Playwright <1.63** (§3) — i.e. it cannot live
  in QwenPaw's `/app/venv` (Playwright 1.65.0); requires forking/patching
  the `agentscope/qwenpaw:v2.3.0` image or a bind-mounted source overlay,
  which then has to be maintained across QwenPaw upgrades.

### Option B — HTTP bridge service + QwenPaw skill (no QwenPaw patch)
Camoufox runs standalone (own venv, §3) as a small HTTP service
(e.g. FastAPI + `camoufox.sync_api.Camoufox`) exposing
`POST /goto, /snapshot, /screenshot, /click, /fill, /eval` with a
token header; the QwenPaw agent calls it from a new skill via plain
`httpx` inside `browser`-tool code (or a normal tool). State (contexts,
cookies, logins) lives in the bridge process.
- Pros: zero QwenPaw source changes; survives container recreate and
  QwenPaw upgrades; independently restartable; fastest path to a working
  x.com fetch.
- Cons: agent loses the `Browser` SDK surface — snapshot/locator semantics
  must be re-implemented in the bridge (AX tree → text, screenshot files
  into `/app/working` via a shared bind or returned base64); two
  lifecycles to keep alive; bridge needs auth (token; bind to
  `127.0.0.1` + the Docker gateway only — see §3 networking note).

### Option C — Camoufox Playwright server + minimal QwenPaw patch (RECOMMENDED if patching is OK)
Run `camoufox.server.launch_server(headless="virtual", port=<p>)` as a
sidecar/host service; add the smallest possible QwenPaw `ControlLink`
that does `playwright.firefox.connect(ws://…)` and then **reuses** the
existing `PlaywrightControlLink` verb handlers (they only need a `Page`).
- Pros: smallest code delta of the in-SDK options (one new launch path,
  ~all verbs reused); full SDK preserved; browser process is isolated
  and independently restartable; Camoufox keeps its own Playwright
  version inside its own process.
- Cons: still a QwenPaw source patch (new variant + registration); the
  Playwright ws endpoint has **no auth** — it must be bound to
  `127.0.0.1`/gateway-only and never published; client/server Playwright
  versions must stay protocol-compatible (verify at install time);
  no persistent contexts over the server (Camoufox rejects them —
  logins/cookies need a bridge-side persistent profile or re-login).

**Recommendation:** prove the premise first with a direct Camoufox smoke
test against x.com (§5 step 2). If Camoufox unblocks x.com, build **C**
if the user accepts maintaining a small QwenPaw patch, otherwise **B**.
Do not attempt `executable_path`/`connect_cdp` shortcuts — they are
proven dead ends above.

---

## 3. Where Camoufox should run (disk, deps, survival)

### Playwright version trap (decisive)
- Container `/app/venv`: **Playwright 1.65.0**, Python 3.11, Node v22.23.4.
  Driver `browsers.json` knows `firefox` rev 1572 / FF 159.0, but **no
  Firefox binary is downloaded** (`~/.cache/ms-playwright` does not exist,
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`,
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`; system
  Chromium is 156.0.8078.79, Debian bookworm build).
- Camoufox `python/pyproject.toml:41`: `playwright = "<1.63"`,
  package version 0.5.7. **Camoufox cannot run in QwenPaw's venv.**
  It needs its own venv with its own Playwright (<1.63); `server.py`
  also imports the private `playwright._impl._driver` API, so the pin
  matters. Host Python is 3.13.5 (Camoufox needs ≥3.10) with `venv`
  available; host has **no Node** — irrelevant, `launch_server` uses the
  Playwright driver-bundled Node from its own venv
  (`server.py:get_nodejs()` → `compute_driver_executable()[0]`).

### Placement options
| Place | Verdict |
|---|---|
| Inside the `qwenpaw` container (pip/apt into running container) | **No.** Image is immutable upstream; anything installed in the running container is **lost on `docker compose up -d` recreate / image update**. Also Playwright-version conflict (§ above). |
| Sidecar container (new service in `docker-compose.yml`) | Viable, cleanest isolation (own image, own Playwright). Needs a small custom image or a `python:3.13` image + install steps; must join the same Docker network so QwenPaw reaches it by service name. |
| Host venv + systemd service (`/data/home/camoufox/`) | **Recommended for this machine.** Simplest, no image build, `camoufox fetch` + venv live on `/data` (survives container recreate). Needs a systemd unit (or a line in the existing pattern) because the VM pauses and host processes die with it. |

### Survival analysis
- `docker-compose.yml` (`/data/home/qwenpaw/docker-compose.yml`): single
  service `qwenpaw`, `restart: always`, port `127.0.0.1:8088:8088`,
  binds `/data/home/qwenpaw/working{,.secret,.backups}` →
  `/app/working{,.secret,.backups}`. `qwenpaw.service`:
  `Type=oneshot, RemainAfterExit=yes`,
  `ExecStart=/usr/bin/docker compose -f /data/home/qwenpaw/docker-compose.yml up -d`,
  `WorkingDirectory=/data/home/qwenpaw`.
- Anything added to that compose file (sidecar service) or to
  `/data/home/*` **survives container recreate and snapshot restore**
  (it lives on `/data`, `/dev/vdb`, not in the image). Anything installed
  inside the container does not. Host systemd units in
  `/etc/systemd/system/` survive snapshot restore (root disk) but are
  not in the GitHub deploy repo — record them in the repo.
- Free-tier caveat: the VM pauses (30 min idle, ≤120–480 min/run, then
  5–20 min cooldown). A host Camoufox service dies on pause and must be
  restarted on boot (systemd `WantedBy=multi-user.target`, `Restart=always`)
  and re-warmed by the keep-alive Worker pattern; a persistent browser
  profile on `/data` survives the pause, the live browser process does not.

### Disk / resources (live)
- `/`: 16G, 5.7G used, **9.2G avail**; `/data`: 20G, 4.1G used,
  **16G avail**. Docker root `/var/lib/docker` (on `/`); image
  `agentscope/qwenpaw:v2.3.0` = 4.32 GB disk usage.
- Camoufox download size is **not pinned anywhere in the repo source**
  (no byte size in `pkgman.py`/`__main__.py`/README; `fetch` streams
  the paired release asset with a progress bar). Estimate only, to
  verify at install time: a Firefox-based build is typically on the
  order of 150–350 MB download / ~0.5–1 GB installed, plus the fpgen
  model. Either way it fits comfortably in 9.2G/16G headroom.
- RAM 7.8 Gi total, 6.4 Gi available; 4 vCPU, x86_64. A headed Firefox +
  Xvfb is fine; do not run Chromium and Camoufox headed simultaneously
  for long.

### Container → host networking (verified live)
From inside the container, TCP connect to the Docker gateway
`172.18.0.1:8000` returns `111 ECONNREFUSED` — i.e. packets **route to
the host** (refused = reached host, no listener). Container IP is
`172.18.0.2`. So a bridge/server on the host is reachable from QwenPaw
code via `http://172.18.0.1:<port>` / `ws://172.18.0.1:<port>` — but
bind it to the gateway interface only, never `0.0.0.0` + a public port.

### Camoufox data dir / overrides (from `python/src/camoufox/`)
- `pkgman.py:63`: `INSTALL_DIR: Path = Path(user_cache_dir("camoufox"))` →
  `~/.cache/camoufox` on Linux (platformdirs; `XDG_CACHE_HOME` respected).
  `multiversion.py:21-24`: `BROWSERS_DIR = INSTALL_DIR/"browsers"`,
  `CONFIG_FILE = INSTALL_DIR/"config.json"`. **There is no
  `CAMOUFOX_DATA_DIR` env var** (grep finds none); to relocate, set
  `XDG_CACHE_HOME` or `HOME` for the service user. `camoufox path`
  prints the dir; `camoufox remove` deletes it.
- Overrides that do exist: `CAMOUFOX_EXECUTABLE_PATH` (`utils.py:1334`),
  the `browser` launch option / `camoufox set` (pin a build), and
  `user_data_dir` with `persistent_context=True`.
- `camoufox fetch` installs the paired build + fpgen model (sha256-pinned);
  it makes one GitHub API call to read the release — set `GITHUB_TOKEN`
  to avoid rate limits. A first launch auto-downloads if the build is
  missing.
- `headless="virtual"` (`virtdisplay.py`): Linux only, needs **`Xvfb`
  and `setpriv`** (`CannotFindXvfb` / `VirtualDisplayNotSupported`
  otherwise); Xvfb is started via
  `[setpriv, --pdeathsig, TERM, Xvfb, -screen, 0, <size>, -ac, -nolisten, tcp, ...]`
  so it dies with its launcher. Default display is **1x1x24**; override
  with `CAMOUFOX_VIRTUAL_DISPLAY_SIZE="1920x1080x24"`. Software rendering
  only (Mesa llvmpipe, `LIBGL_ALWAYS_SOFTWARE=1`). `headless="virtual-gpu"`
  is irrelevant here (no GPU).
- `launch_server` also honours `headless="virtual"` via
  `start_virtual_display()` (`server.py`).
- Firefox profile dir: `pkgman.py:99` — Camoufox ensures `~/.camoufox`
  exists before launch (created 0700); on a read-only HOME this stalls
  startup.

---

## 4. Watchable-screen feasibility on this one Free machine

**Screenshots: already work.** `page.screenshot()` returns a PNG path in
the workspace — that is the reliable "watching" mechanism today, on any
backend.

**Live screen: feasible with workarounds, not out of the box.** Blockers:

1. **No VNC server for Xvfb is installed anywhere.** Container: no
   `x11vnc`/`novnc`/`websockify`/`vncserver`. Host: no `x11vnc`/`novnc`/
   `websockify` either — and `apt-cache policy x11vnc novnc websockify`
   returns **nothing** (host apt lists are effectively empty:
   `/var/lib/apt/lists/` holds only `auxfiles/lock/partial`; the box has
   likely never run `apt-get update`, so availability in Debian 13 repos
   is unverified — check after an update, do not assume).
2. **But TigerVNC is installed on the host**: `tigervnc-standalone-server`
   1.15.0, binaries `/usr/bin/Xvnc`, `vncserver`, `Xtigervnc`. And
   Camoufox has a seam for it: the `virtual_display` launch option —
   "Use an existing X display, e.g. `\":99\"`" (README launch-options
   table). So: run `vncserver :99 -geometry 1920x1080` (TigerVNC's Xvnc
   *is* the X server) on the host, then launch Camoufox with
   `virtual_display=":99"`. A native VNC client can then watch it.
   (Caveat: this path bypasses Camoufox's own Xvfb wrapper; verify the
   identity still draws correctly — canvas/WebGL will still be software
   rendered, which the launcher already expects on Linux.)
3. **Browser-based watching (noVNC) is the missing piece.** It needs
   `novnc` + `websockify` (not installed; apt availability unverified
   per blocker 1; `pip install websockify` + a static noVNC checkout is
   the fallback).
4. **Exposure.** A VNC/noVNC port must be reachable by the user: InstaBox
   Free currently publishes only `127.0.0.1:8088`; whether extra ports
   can be exposed, and how (InstaBox proxy vs Cloudflare Tunnel — note
   Tunnel is not viable on Free per prior research, since the VM pausing
   kills `cloudflared`), is **unverified** and is the biggest open
   question for live watching. Do not publish VNC without a password +
   token gate — VNC auth alone is weak.
5. **Free-tier lifecycle.** Any live display dies when the VM pauses
   (30 min idle). Watching is only meaningful while the machine is awake;
   screenshots + the bridge survive as the durable record.
6. **Display size.** Camoufox's own virtual display defaults to 1x1 —
   always set `CAMOUFOX_VIRTUAL_DISPLAY_SIZE=1920x1080x24` (or the Xvnc
   geometry) or the "watchable" screen is a 1×1 framebuffer.

Bottom line: **watch via screenshots now; live VNC is a "possible, needs
the VNC-exposure question answered" — use Xvnc `:99` + `virtual_display=":99"`,
not x11vnc-over-Xvfb.**

---

## 5. Exact next commands (NOT run — research only)

```bash
# --- 0. Prove the premise: does Camoufox actually unblock x.com? ---
# On the host (as the service user; everything under /data so it survives):
python3 -m venv /data/home/camoufox/.venv
/data/home/camoufox/.venv/bin/pip install -U "camoufox[geoip]"
/data/home/camoufox/.venv/bin/camoufox fetch
/data/home/camoufox/.venv/bin/camoufox version        # check build + sizes
# Smoke test, virtual display (software rendering):
CAMOUFOX_VIRTUAL_DISPLAY_SIZE=1920x1080x24 \
  /data/home/camoufox/.venv/bin/python - <<'EOF'
from camoufox.sync_api import Camoufox
with Camoufox(headless="virtual", os="linux") as browser:
    page = browser.new_page()
    page.goto("https://x.com/", timeout=60000)
    print(page.title(), page.url)
    page.screenshot(path="/data/home/camoufox/x-smoke.png")
EOF

# --- 1. Server mode smoke (for Option C) ---
# Terminal A (host):
/data/home/camoufox/.venv/bin/python - <<'EOF'
from camoufox.server import launch_server
launch_server(headless="virtual", port=1234, ws_path="camoufox")
EOF
# Terminal B (from inside the container, with its own playwright — verify
# client/server protocol compat; expect a page title, not an exception):
# docker exec -u 0 qwenpaw /app/venv/bin/python - <<'EOF'
# from playwright.sync_api import sync_playwright
# with sync_playwright() as p:
#     b = p.firefox.connect("ws://172.18.0.1:1234/camoufox")
#     pg = b.new_page(); pg.goto("https://example.com"); print(pg.title()); b.close()
# EOF

# --- 2. Watchable screen (only after step 0 passes) ---
# sudo apt-get update && apt-cache policy x11vnc novnc websockify   # check availability first
# vncserver :99 -geometry 1920x1080 -localhost no   # TigerVNC, already installed; set a strong password
# then launch Camoufox with virtual_display=":99" instead of headless="virtual"

# --- 3. Wiring (only after step 0 + 1 pass; needs a user decision) ---
# Option C: add a "camoufox" ControlLink (ports.py/links.py seam) + backend
#   literal + _ENGINE_VARIANT entry; register via register_local().
# Option B: build the HTTP bridge service + systemd unit
#   /etc/systemd/system/camoufox-bridge.service (Restart=always,
#   WorkingDirectory=/data/home/camoufox, bind 127.0.0.1 + 172.18.0.1 only,
#   token auth), and a QwenPaw skill that calls it.
# In both cases: keep the Camoufox venv + profile on /data, add the new
# service(s) to /data/home/qwenpaw/docker-compose.yml or a systemd unit,
# and record them in the qwenpaw-deploy GitHub repo.
```

## Open / unverified items
- Camoufox `fetch` download/installed size (no size in source; check
  `camoufox version` output at install time).
- Whether `x11vnc`/`novnc`/`websockify` exist in Debian 13 repos for this
  host (apt lists empty; needs `apt-get update` first).
- How a VNC/noVNC port would be exposed publicly from InstaBox Free.
- Playwright client (1.65.0 in container) ↔ Camoufox server (Playwright
  <1.63 in its venv) wire-protocol compatibility — verify with the
  step-1 smoke test, do not assume.
- Whether Camoufox's identity/fingerprint stays coherent on a TigerVNC
  X display (`virtual_display=":99"`) vs its own Xvfb wrapper.
- Astra was unavailable (120 s timeout, 2026-11-15 ~02:34 IST); no
  Astra input is reflected in this report.
