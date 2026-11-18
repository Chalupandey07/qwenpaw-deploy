# AgentX Rebrand + Debloat (DOM injection)

The product is **AgentX** now. The upstream console still calls itself
QwenPaw, so the visible rename is done by DOM injection in the browser —
never by rewriting the bundle (immutable, cache-pinned for a year).
Research: `~/workspace/agentx-rebrand-research.md` (DeepSeek + live-bundle
verification, 2026-11-18). Approach B (DOM injection) was chosen over A
(proxy string-rewrite — cache-unsafe) and C (fork — 1–3 weeks + merge tax).

## Build status (2026-11-18)

**Code complete, machine-free tests green, NOT yet deployed, NOT yet
live-verified.** Built by Muse (code) from the DeepSeek research report.
Files: `pages/public/_worker.js` (shim + rebrand rules + our strings),
`features/board/worker/src/index.js`, `features/routines/worker/src/index.js`,
`worker/src/index.js` (keep-alive probe note),
`features/infra/workers/activity-feed/index.js` (probe note + title/h1),
`pages/public/{reset/index.html, vault/ui.html, status-page.html,
computer/router.js, computer/ui.html, vault/router.js, reset/ui.js}`,
`features/rebrand/` (this README + harness). Tests: T114
(harness-rebrand.mjs, 86 checks), PASS; fail-first proven (against the
unmodified `_worker.js` it fails 49/51 — the 2 that pass check for the
ABSENCE of a rebrand section, which is vacuously true on the original
file; after the browser-verification fixes below, the extended harness
fails 22/69 against the pre-fix code and passes 69/69 after; after the
China-card fix below, the extended harness fails 13/86 against the
pre-fix code and passes 86/86 after). Full machine-free suite 21 PASS /
4 known NEEDS-REBUILD. Secret-scan clean. NOT deployed — the parent
deploys after the model-loop browser test finishes, so the Pages proxy
is untouched by this commit.

What changed, in order:
1. **Freeze upstream.** The machine's `/data/home/qwenpaw/docker-compose.yml`
   pins `agentscope/qwenpaw:v2.3.0` by digest
   (`@sha256:46a782f4b39b673eac399c90294244e348e71a01bdf032f8e78b00776be3c87d`,
   read live via `docker image inspect`). Validated with
   `docker compose config --quiet`; backup
   `docker-compose.yml.bak-20261118-agentx`. No container restart. This is
   what makes the text-matching rules safe.
2. **Security headers** in `_worker.js` on the console HTML response:
   `Content-Security-Policy-Report-Only: img-src 'self' data: blob:` (kills
   the 17 alicdn.com illustration URLs) + `Referrer-Policy: no-referrer`
   (overrides the `same-origin` set by `rewriteHeaders` for this HTML
   response only). Report-Only first — nothing is blocked yet; no
   `report-uri` is set (no endpoint exists), so violations are only logged
   to the DevTools console. Promote to enforcing after a day of reports.
3. **Early classic inline shim** (`headShim()` beside
   `computerPanelScript()`): patches `window.fetch` so ONLY
   `https://pypi.org/pypi/qwenpaw/json` is answered with
   `{info:{version:"2.3.0"}}` (the pinned version, so the hourly update
   checker always sees "up to date") and patches `window.open` to swallow
   `qwenpaw.agentscope.io` and `github.com/agentscope-ai/QwenPaw`
   (return null, do not open). Everything else falls through to native.
   Both wrapped in try/catch. The shim is classic (no async/defer/module)
   and injected before `</body>`, so it runs before the deferred module
   bundle — that is how the patches win the race.
4. **Our own strings** in `_worker.js`: waking page title/h1, cooldown page
   title/h1, the 502 texts ("AgentX origin unreachable", "AgentX console
   temporarily unavailable"), the 409 text, the Computer button tooltip.
   The console `<title>` is rewritten at the proxy layer
   (`QwenPaw Console` → `AgentX Console`); the observer renames it again
   if React changes it.
5. **MutationObserver rule table** (extends the existing Vault-menu
   observer, same file): renames visible "QwenPaw" text (title,
   aria-labels, placeholders, toasts, dialogs) to AgentX; hides the header
   menu items (Tutorial, Feature Demos, Changelog, FAQ, GitHub, the
   Documentation dropdown, Import) by accessible name — the whole button,
   not just its text — via `agentxHideByName` + `agentxClimbToContainer`;
   renames "About QwenPaw" to "About AgentX" and intercepts its click
   with a delegated capture listener that opens our `/status` page;
   replaces the sidebar logo img with an "AgentX" text label; watches
   the `<title>` element so the title is renamed the moment the app sets
   it; hides the language switcher, the desktop-install prompt, the
   Codex/Qoder profile rows, the voice/Whisper section; hides the China
   provider cards (DashScope, SiliconFlow, ModelScope, Alibaba, Alibaba
   Cloud, Aliyun) and China channel cards (WeCom, DingTalk, Feishu, QQ,
   WeChat, Xiaoyi) by accessible name as whole cards; a delegated click
   listener neutralises any `<a>` to the upstream hosts (covers the
   "View guide"/"Documentation" links in settings). Each rule in its own
   try/catch with a `console.debug` naming the rule. The pass is
   throttled (leading + trailing, 400 ms). Kill switches: worker env
   `AGENTX_REBRAND=0` or `?rebrand=0` in the page URL.
6. **Our workers' visible text**: board worker title/h1/help text and the
   "Sent to" / "Post to" strings; routines worker title/h1/notes and the
   history table header; keep-alive worker probe note ("AgentX console
   answered" — the note the /status page renders); activity-feed worker
   probe note + page title/h1; page titles "Reset — AgentX", "Vault — AgentX",
   "AgentX — Status" (plus the status page h1, Wake button, footer);
   computer/vault gate error details; reset Logs hint.

## Browser-verification fixes (2026-11-18, after first deploy)

A live browser check (satwik, qwenpawx.pages.dev, 11:13–11:18 IST) found
the first version only PARTLY working. All six findings are fixed in
this commit; the harness grew from 51 to 69 checks for them.

1. **Menu buttons only blanked, not removed.** `agentxHideExact` only
   matched leaf elements whose visible text exactly equalled the label,
   so icon-only buttons (accessible name only, no text) never matched,
   and when a name leaf did match, `closest()` often found no card/menu
   ancestor, so only the name was hidden. Fix: `agentxHideByName`
   matches by accessible name (aria-label, then title, then alt, then
   text) and `agentxClimbToContainer` hides the whole button/card —
   closest() first, then a fallback climb for containers with no
   matching class. The hide-menu and hide-china rules use it now.
2. **About click did nothing.** The old rule required the label to be
   exactly "About QwenPaw" / "About AgentX", but the real label carries
   the version ("About QwenPaw v2.3.0"), so the listener was never
   attached — the harness mock used the exact label, which is why it
   passed. Fix: a delegated capture-phase listener on document, prefix
   match ("About QwenPaw" / "About AgentX", version suffix allowed),
   walking up from the click target; it opens /status in a new tab and
   closes the menu with a best-effort Escape keypress (the menu's own
   handler never runs, because the click is stopped in capture).
3. **Sidebar logo still "QwenPaw".** New `rename-logo` rule: finds
   `img[alt*="QwenPaw"]`, renames the alt to AgentX, and replaces the
   img with an "AgentX" text span in the same brand slot, so the
   sidebar layout does not shift.
4. **/status note still "QwenPaw console answered".** The note comes
   from the keep-alive Worker's probe result
   (`worker/src/index.js`), which the /status page renders — renamed
   to "AgentX console answered". The deployed activity-feed Worker had
   the same string (plus a QwenPaw title/h1); renamed there too. The
   routines Worker was already AgentX.
5. **Settings title flashed "Settings · QwenPaw".** A title change does
   not mutate the body, so the body MutationObserver never saw it and
   the rename waited for the next re-render. Fix: `agentxWatchTitle()`
   observes the `<title>` element itself, so the rename is immediate.
   A brief flash can still occur if the app sets the title between the
   observer's microtask and the rename — documented as a known
   limitation, not chased with a timer loop.
6. **China cards only blanked, not hidden.** Same root cause as (1):
   the name leaf was hidden but the card stayed. Fix: the hide-china
   rule now uses `agentxHideByName` (accessible name + whole-card
   climb). "Aliyun" (Alibaba Cloud's visible brand) and "Alibaba
   Cloud" were added to the label list — "Aliyun" was never in it.

## China-card fix (2026-11-18, after second live verification)

A second live browser re-verification (satwik, qwenpawx.pages.dev,
11:30–11:34 IST) found SiliconFlow, ModelScope and Aliyun STILL present
in Settings > Models > Cloud Providers (17 cards: OpenCode, SiliconFlow
FREE, Zhipu, AgentScope, Aliyun, Anthropic, Azure, DeepSeek, Google
Gemini, Kimi, MiniMax, ModelScope, OpenAI, OpenRouter, TypeSafe,
Volcengine, Xiaomi MiMo; DashScope 0). The diagnosis, proven by
replaying the REAL card DOM in the harness, was worse than "not hidden":

- **The rule hid the WHOLE provider list, not the card.** The provider
  card's class is a hashed CSS module,
  `index-module__groupCardGlass__-GYEf` — "Card" with a capital C — so
  the case-sensitive `[class*='card']` never matched the card, while
  `[class*='provider']` matched the LIST container
  (`index-module__providerCards__fYCGM`) and `closest()` climbed past
  the card to the list. The settled page then showed NO provider cards
  at all and no search box — the transient snapshots (right after
  navigation/reload, before the rule ran) caught the list with
  SiliconFlow / ModelScope / Aliyun still counted. DashScope was 0 in
  the transient snapshots too, so it is absent from the rendered list
  (not proven hidden by the rule); it stays in the label list, so its
  card is hidden if it ever renders.
- **The harness mock was fictional.** It used class `provider-card`,
  which the real bundle never emits, so it passed while the live rule
  failed. The mock is now the real DOM (hashed classes from the served
  chunks: `RemoteProviderCard-CFfBXPIy.js` + `index.module-D02jL-aA.js`).
- **Available-channel buttons were only blanked.** The available
  channel item (`button.availableItem`, name in `span.availableItemName`)
  has no lowercase "card"/"item"/"provider"/"channel" in any class
  (all CamelCase: `availableItem`, `availableItemName`,
  `availableGrid`), so the old climb found no container and hid only
  the name span, leaving an unnamed icon + Configure button. The
  configured channel card DID hide (its class `channelCard` contains
  lowercase "channel", so the old fallback climb found it) — the
  Channels page showing no cards at all was ambiguous (an empty/failed
  load, not proof the rule worked).

Fix: new `agentxClimbToChinaCard(el)` — structural and case-insensitive.
The card is the ancestor that is a direct child of the list/grid (the
provider list `providerCards`, the channel grid `availableGrid` /
`channelsGrid`, a `role=list`, a `ul`/`ol`, or a class containing
"list"/"grid"), or — failing that — the first ancestor whose lowercased
class names the card itself (`groupCardGlass` = provider card,
`channelCard` = configured channel card, `availableItem` =
available-channel button), skipping the name-bearing leaves
(`groupCardName` / `cardTitle` / `availableItemName`). The list/grid
container itself is never returned, so non-China providers (OpenAI,
Anthropic, DeepSeek, …) are never hidden with it. `agentxHideByName`
takes an optional climb function; the hide-china rule passes
`agentxClimbToChinaCard`, the hide-menu rule keeps the generic climb.
`agentxClimbToContainer`'s fallback class checks are now
case-insensitive too (lowercased before matching). The observer already
re-runs on mount (it watches the whole body subtree with a 400 ms
throttle + trailing timer), so the async list mount is covered — the
harness now simulates it (empty list on the first pass, cards appended,
re-run after the throttle window). T114 grew 69 → 86 checks; fail-first
proven 13/86 against the pre-fix code, 86/86 after.

## Live verification (NOT yet done — parent deploys)

- **NOT deployed.** The Pages proxy and both Workers are untouched by
  this commit on purpose: a browser test for the model-loop fix is using
  the live console right now, and deploying `_worker.js` mid-test would
  interfere. The parent deploys after that test finishes.
- **After deploy, verify live in a real browser:** console title is
  "AgentX Console"; no "Update Available" badge after ~2 h; the header
  menu has no Tutorial / Feature Demos / Changelog / FAQ / GitHub /
  Documentation items; "About AgentX" opens /status; no menu item opens
  qwenpaw.agentscope.io or github.com/agentscope-ai/QwenPaw; the
  China provider/channel cards are hidden AND the non-China cards and
  the provider list itself are still visible (the last fix hid the
  whole list — check the list is present, not just that the China names
  are gone); the waking page says AgentX.
  The harness (T114) proves the mechanism against mocks; only a real
  browser proves it against the live console.

## Never-rename allowlist — do not touch these

Renaming any of these breaks auth, styling, install instructions, or a
live integration. They are load-bearing, not branding.

| Item | Why it must stay |
|---|---|
| `qwenpaw_auth_token`, `qwenpaw-agent-storage`, `qwenpaw-last-used-agent` (localStorage) | The console's auth/session keys. Renaming logs the user out / loses state. |
| `qwenpaw:*` events (`qwenpaw:auth-changed`, `qwenpaw:plugins-changed`, `qwenpaw:chunk-reload-build`) | Internal event bus. Renaming silences auth/plugin updates. |
| `qwenpaw-` CSS prefix (`qwenpaw-popover-inner`, `qwenpaw-menu-item`, … — 369 occurrences in the main CSS) | Ant Design component class overrides. Renaming breaks ALL styling. |
| `QWENPAW_AUTH_ENABLED` (env var) + terminal banner `QWENPAW_AUTH_ENABLED=true` | The real env var. Renaming it in instructions makes them wrong. |
| `~/.qwenpaw/workspaces` path hint | The real filesystem path. Renaming misleads. |
| `Install qwenpaw[codex]`, `Install qwenpaw[whisper]`, `uv pip install 'qwenpaw[whisper]'` | Literal, correct pip commands. Renaming breaks the install. |
| API paths (`/api/console/chat`, `/api/cron/jobs`, …) + `/api/tickets/:id/qwenpaw-task` | Real routes. |
| Element IDs (`qwenpawComputerBtn`, `qwenpawVaultPopup*`, `qwenpawRestBtn`, `qwenpawComputerOpen`) + `data-qwenpaw-vault-menu` | Our own injected elements; other code (and tests) find them by these IDs. |
| `KEEPALIVE_URL` (`qwenpaw-keepalive.qwenpaw-rohan.workers.dev`) + `qwenpawx.pages.dev` / `qwenpaw-frontend.pages.dev` | Real subdomains. Renaming them is a separate Cloudflare project/DNS decision. |
| D1 columns (`qwenpaw_session`, `sent_to_qwenpaw_at`) + JSON keys (`sent_to_qwenpaw_at`, `qwenpaw: <status>`) + the `qwenpaw-board` source key + `qwenpaw-board-key` localStorage key | Storage/API contract. Renaming corrupts or orphans data. |
| Agent name `QwenPaw_QA_Agent_0.2` (workspace/agent id) | The real agent identifier on the machine. |
| UA `qwenpaw-routines/1.0` + worker names (`qwenpaw-routines`, `qwenpaw-board`, `qwenpaw-keepalive`) | Identifiers. Renaming them is a separate decision. |
| Docs/tests/audit reports in the repo (~2,326 lines) | Historical evidence, not the product. Do NOT rename. |
| Multi-window safety prompts ("Close QwenPaw?", "still in use in other windows") | NOT hidden — only their product name is renamed. Suppressing them risks suppressing real safety prompts. |

The text pass enforces the allowlist at runtime: any text node whose own
or parent text contains `qwenpaw[codex]`, `qwenpaw[whisper]`,
`QWENPAW_AUTH_ENABLED`, `~/.qwenpaw`, `qwenpaw_auth_token`,
`qwenpaw-agent-storage`, `qwenpaw-last-used-agent`, `qwenpaw:` or
`qwenpaw-` is skipped, so setup instructions stay truthful.

## What this does NOT do (honest limits)

- **No debloat.** ~10.5 MB of JS still ships; routes stay reachable by
  deep link even if nav is hidden; first paint can flash "QwenPaw" before
  the observer renames it. Only a fork (approach C) actually deletes code
  or shrinks the bundle. The settings-title flash is reduced by the
  `<title>` observer, but a brief flash can still occur if the app sets
  the title between the observer's microtask and the rename — that is a
  known limitation, not chased with a timer loop.
- **About opens /status in a new tab; the menu is closed with a
  best-effort Escape keypress.** The click is stopped in capture phase,
  so the menu's own handler never runs. If the Escape dispatch does not
  close the menu in some browser, the menu stays open behind the new
  tab — cosmetic, the navigation still happens.
- **No "no China data" guarantee.** DOM hiding is cosmetic. An egress
  allowlist on the InstaBox VM is the only control that covers
  integrations not yet enumerated. (Note: the China channels
  dingtalk/feishu/wechat/qq/wecom/yuanbao/xiaoyi/imessage are ALREADY
  disabled in the machine's docker-compose.yml via
  `QWENPAW_DISABLED_CHANNELS`, so those cards should not render at all;
  the hide rules are belt-and-braces. The agent's active model provider
  mosicn is the user's existing choice and is out of scope here.)
- **Public URLs are unchanged** (`qwenpawx.pages.dev`,
  `qwenpaw-frontend.pages.dev`, `qwenpaw-keepalive.*`,
  `qwenpaw-routines.*`). Renaming them needs new Cloudflare projects +
  binding/DNS updates — a separate decision.
- **The language-switcher rule is best-effort**: it hides elements with
  an aria-label/title containing "Language". If the real label differs,
  the rule silently does nothing (safe no-op). Not live-verified.
- **The desktop-install prompt rule is best-effort**: it hides a
  dialog/banner containing "is ready to install". If the prompt renders
  as a plain div, the rule misses it (safe no-op). Not live-verified.
- **The voice-section rule hides by content** (`qwenpaw[whisper]`): it
  hides the closest section/card ancestor of the command string. If the
  section structure differs, it may hide too little or too much — the
  rule only hides, never deletes, and the command string itself is left
  intact. Not live-verified.

## File layout

- `pages/public/_worker.js` — `headShim()` (fetch/window.open patches),
  `computerPanelScript(rebrandEnabled)` (rebrand rule table + observer),
  `agentxHideByName` / `agentxClimbToContainer` (hide by accessible name,
  whole button/card) / `agentxClimbToChinaCard` (structural China-card
  climb that never returns the list), `agentxAboutRule` (delegated About click),
  `agentxWatchTitle` (title observer), `PINNED_QWENPAW_VERSION` /
  `PYPI_QWENPAW_URL` / `UPSTREAM_DOC_ORIGIN` / `UPSTREAM_GITHUB_URL`
  constants, proxy injection + title rewrite + CSP-Report-Only /
  Referrer-Policy headers, waking/cooldown/502/409 strings, Computer
  button tooltip.
- `worker/src/index.js` (keep-alive) — probe note "AgentX console
  answered" (feeds the /status page).
- `features/infra/workers/activity-feed/index.js` — probe note + page
  title/h1 ("AgentX — Live activity").
- `features/board/worker/src/index.js` — title/h1/help text + "Post to" /
  "Sent to" strings (D1 columns, JSON keys, `qwenpaw-board` key kept).
- `features/routines/worker/src/index.js` — title/h1/notes + history table
  header (JSON keys, UA kept).
- `pages/public/reset/index.html`, `pages/public/vault/ui.html`,
  `pages/public/status-page.html` — titles + visible strings.
- `pages/public/computer/router.js`, `pages/public/computer/ui.html`,
  `pages/public/vault/router.js`, `pages/public/reset/ui.js` — gate error
  details + Logs hint.
- `features/rebrand/harness-rebrand.mjs` — T114 harness (static + VM
  dynamic, fail-first proven).

## Test plan

- `node features/rebrand/harness-rebrand.mjs` (T114): static checks on
  the real `_worker.js` (fetch patch targets exactly the PyPI URL,
  window.open swallows exactly the two upstream hosts, kill switch
  exists, each rule in its own try/catch) + dynamic VM runs of the real
  shim and the real rebrand rules with mocks (PyPI fetch stubbed, other
  fetches pass through; window.open swallowed for upstream hosts,
  passes through for others; a sample menu item hidden; a load-bearing
  text node left alone).
- Machine-free suite subset before every commit (see AGENTS.md §5).
- Live browser check after deploy (see "Live verification" above).
