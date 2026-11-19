# AgentX Rebrand + Debloat (DOM injection)

The product is **AgentX** now. The upstream console still calls itself
QwenPaw, so the visible rename is done by DOM injection in the browser —
never by rewriting the bundle (immutable, cache-pinned for a year).
Research: `~/workspace/agentx-rebrand-research.md` (DeepSeek + live-bundle
verification, 2026-11-18). Approach B (DOM injection) was chosen over A
(proxy string-rewrite — cache-unsafe) and C (fork — 1–3 weeks + merge tax).

## Build status (2026-11-18)

**Code complete, machine-free tests green, this commit NOT yet deployed.**
Built by Muse (code) from the DeepSeek research report. Files:
`pages/public/_worker.js` (shim + rebrand rules + our strings),
`features/board/worker/src/index.js`, `features/routines/worker/src/index.js`,
`worker/src/index.js` (keep-alive probe note),
`features/infra/workers/activity-feed/index.js` (probe note + title/h1),
`pages/public/{reset/index.html, vault/ui.html, status-page.html,
computer/router.js, computer/ui.html, vault/router.js, reset/ui.js}`,
`features/rebrand/` (this README + harness). Tests: T114
(harness-rebrand.mjs, **174 checks** — 93 before Part 3 below, 174 after),
PASS; fail-first proven (against the
unmodified `_worker.js` it fails 49/51 — the 2 that pass check for the
ABSENCE of a rebrand section, which is vacuously true on the original
file; after the browser-verification fixes below, the extended harness
fails 22/69 against the pre-fix code and passes 69/69 after; after the
China-card fix below, the extended harness fails 13/86 against the
pre-fix code and passes 86/86 after; after the XiaoYi/Yuanbao channel
fix below, the extended harness fails 7/93 against the pre-fix code
and passes 93/93 after; after Part 3 below, the extended harness fails
54/174 against the pre-Part-3 code and passes 174/174 after). Full machine-free suite 21 PASS /
4 known NEEDS-REBUILD. Secret-scan clean. The rebrand v1 + the first two
fix rounds ARE deployed and live-verified (see below); only THIS commit
(the XiaoYi/Yuanbao channel fix) is not deployed yet — the parent
deploys it and re-verifies in a real browser.

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
   WeChat, XiaoYi, Yuanbao) by accessible name as whole cards, with
   case-insensitive matching (see the XiaoYi fix below); a delegated click
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

## China-channel fix (2026-11-18, after third live verification)

A third live browser re-verification (satwik, qwenpawx.pages.dev,
11:47–11:50 IST, commit 83c3003 deployed) passed the provider hiding
(the settled Models list shows 14 healthy non-China cards — OpenAI,
DeepSeek, Anthropic present — and SiliconFlow / ModelScope / Aliyun /
DashScope are all 0, by list and by search), passed the /status note
("AgentX console answered"), and passed the logo + test message — but
found ONE China channel card still visible: **XiaoYi** ("xiaoyi XiaoYi
Configure", second row, first card in Settings > Channels > Available).
DingTalk, Feishu, QQ, WeChat and WeCom are all absent. The same check
also surfaced **Yuanbao** (Tencent's AI assistant) as an available
channel card — the original research listed only six China channels and
missed it, although the machine's docker-compose.yml already disables it
via `QWENPAW_DISABLED_CHANNELS`.

Diagnosis, proven against the LIVE main bundle
(`/assets/index-DZrIuh3B.js`, fetched 2026-11-18, 1,011,949 bytes):

- The channel-name map in the bundle is
  `xiaoyi:"XiaoYi", yuanbao:"Yuanbao"` (id → display name). The label
  list spelled it **"Xiaoyi" — which occurs ZERO times in the bundle**,
  while the console renders "XiaoYi" (display name, once) and "xiaoyi"
  (channel id, three times). `agentxHideByName` compared
  case-sensitively, so it could never match either path. The other five
  China channels hide because their display names match the labels
  exactly ("DingTalk", "Feishu", "QQ", "WeChat", "WeCom"); only XiaoYi
  differs in case. That is why five of six hid and one survived.
- The available-channel button carries the name on TWO paths, and the
  second one is also case-mismatched: the button is
  `<button class="availableItem">` (no aria-label) with the icon
  component rendering `<img alt={channelKey}>` — the alt is the
  LOWERCASE channel id ("xiaoyi") — plus `span.availableItemName`
  ("XiaoYi") and a Configure action. The button's own textContent is
  "XiaoYiConfigure", which matches nothing. The name span is the path
  that works once the spelling is fixed; the img alt is the path that
  only case-insensitive matching covers.
- The XiaoYi setup guide in the bundle confirms it is Huawei's channel
  ("Please create an agent on Huawei Developer Platform and get AK/SK
  and Agent ID"), and its icon is an alicdn.com URL (already covered by
  the CSP-Report-Only img-src rule).

Fix: `agentxHideByName` now compares case-insensitively (name and label
both lowercased, for the exact, word, and multi-word-substring matches);
the label list spells the channel "XiaoYi" (the real display name) and
adds "Yuanbao". iMessage is also in the compose disabled list but is
Apple's, not a China channel — it is NOT hidden (harness checks it
stays visible). T114 grew 86 → 93 checks: the 6 new dynamic checks use
the REAL channel DOM (including the img alt = lowercase id, as the live
icon component renders it) — a XiaoYi / Yuanbao available button and
configured card, a XiaoYi channel matched ONLY by its img alt
(this check fails with only the spelling fix, so it proves the
case-insensitive match does real work), and iMessage NOT hidden — plus a
static check for the case-insensitive comparison. Fail-first proven
7/93 against the pre-fix code (the 2 static checks and the 5
XiaoYi/Yuanbao hides; the iMessage negative passes on both, as it
should), 93/93 after.

Tab-count oddity, assessed and LEFT ALONE: while searching for a hidden
provider, the "Cloud Providers" group heading shows a count (2 for
SiliconFlow, 1 for ModelScope, 5 for Aliyun, 5 for DashScope) even
though zero cards render. The count is computed by the app from the
search-filtered list before our hiding. Rewriting it would mean finding
the group heading's count element and recomputing it from the visible
cards after every hide pass — but the heading's render site is in a lazy
chunk and the i18n key (`cloudGroup`) is referenced dynamically, so the
heading's DOM structure cannot be grounded in the bundle, and a blind
rewrite risks corrupting the heading. Cosmetic only (it only disagrees
while searching for a hidden provider); the cards themselves are
correctly hidden. Not chased.

## Part 3 rebrand gaps (2026-11-19, code + tests only — NOT deployed, NOT live-verified)

The machine is suspended and Cloudflare Workers are down (1027 daily
quota, reset 05:30 IST 2026-11-19), so this round is code + harness
only: 22 new rules (the task brief said "18 net new" but enumerates
22 — all 22 were built; the rule table is now 19 + 22 = 41 rules),
four merges into existing rules, and T114 grew 93 → 174 checks
(fail-first 54/174 against the pre-Part-3 code, 174/174 after).
Baseline note: the pre-Part-3 harness in this repo was 89/93, not
93/93 — three of its static checks had gone stale (rule count said 13
while the table already had 19, the observer pattern had changed to
`vaultMenuObserver`, and the logo mock gave the img no width so the
size gate never fired). Those checks and the mock were fixed in this
round; they are harness fixes, not product changes.

New rules (all in `pages/public/_worker.js`, helpers +
`AGENTX_RULES`; all React-safe — text-node values only or
`display:none` on a specific row/card, never moving/creating/removing
nodes inside React-owned subtrees):

- **footer-rebrand** — renames QwenPaw text in `<footer>` /
  `[role='contentinfo']` only (text nodes).
- **block-links-v2** — extends `agentxBlockUpstreamLinks`: the click
  guard now matches by host substring (`AGENTX_UPSTREAM_HOSTS`:
  qwenpaw.com, qwenlm.github.io, github.com/QwenLM, discord.gg,
  alibabacloud.com, dashscope.aliyuncs.com, chat.qwen.ai, plus the two
  hosts the old prefix check covered: qwenpaw.agentscope.io,
  github.com/agentscope-ai) and checks href AND data-url AND
  data-href AND form action — a link can show a harmless href while
  its data-url points upstream. Same-origin links and the deploy repo
  (github.com/Ratulbaba7) are not blocked. Install-once, shared with
  the existing block-links rule.
- **hide-powered-by** — hides "Powered by QwenPaw" / "Powered by
  AgentX" badges (whole container). Both spellings are listed because
  rename-text runs first and already made it "AgentX".
- **hide-feedback** — hides Feedback / "Send feedback" affordances
  (exact accessible-name match, so prose mentioning feedback stays).
- **settings-about** — renames "About QwenPaw" rows to "About AgentX"
  inside Settings (pathname `/settings`, else a Settings-marked
  ancestor). The hide-about capture listener (click → /status) is
  untouched.
- **settings-language** — hides a Settings row whose visible label is
  exactly "Language" (broader than hide-language's aria-label/title
  match; "Language: English" stays).
- **settings-providers** — renames QwenPaw provider/section labels in
  Settings > Models (text only; never provider IDs or API values).
- **settings-integrations** — renames QwenPaw mentions in Settings >
  Integrations (text only).
- **hide-upgrade** — hides Upgrade / "Upgrade to Pro" buttons and
  upsell cards.
- **account-card** — renames QwenPaw mentions in the account/user card
  (text only; the satwik username and avatar are never touched).
- **workspace-switcher** — renames QwenPaw in the workspace switcher
  (text only).
- **sidebar-help** — hides sidebar Help/docs links that point upstream
  (reuses the block-links host list); same-origin sidebar links stay,
  and upstream links outside the sidebar stay visible here
  (block-links still blocks their clicks).
- **model-labels** — DISPLAY-ONLY text map to AgentX-1 / AgentX-1-Mini
  (see the mapping judgment call below). Only text nodes inside the
  model picker/composer (ancestor must carry a model/picker/composer
  marker); never option value attributes, never input values, never
  anything sent to the API. A label matching neither mapping is left
  alone.
- **title-observer** — wires the existing `agentxWatchTitle()` into a
  rule (install once + rename the title immediately); no second
  observer is ever installed.
- **head-rebrand** — renames og:title / twitter:title / og:description
  / twitter:description meta content, renames the inline
  application-name meta, and sets the favicon
  (`link[rel~="icon"]`) href to an inline data-URI SVG with the "AX"
  mark (no external URL). Manifest note below.
- **export-rebrand** — hides community-share / "Share to community"
  controls; for `a[download]` links rewrites the DISPLAYED text only,
  never the href or download filename.
- **hide-run-in** — hides "Run in QwenPaw" / "Open in QwenPaw"
  buttons (both QwenPaw and AgentX spellings, as with
  hide-powered-by).
- **auth-rebrand** — renames QwenPaw on sign-in/auth screens (text
  only; never tokens, inputs, or form actions).
- **error-rebrand** — renames QwenPaw in error boundary / error toast
  text (text only, scoped to error/toast/alert containers).
- **hide-onboarding** — hides first-run onboarding / tutorial overlay
  cards ("Getting started" docs links stay).
- **hide-update-banner** — hides the "update available" banner (the
  pinned-version shim already answers the version check; "Updated …"
  notes stay).
- **hide-shortcuts-dialog** — hides the keyboard-shortcuts dialog
  trigger/row in help menus. Only the trigger UI is hidden — the
  shortcuts themselves (key handlers) are never touched, so every
  shortcut keeps working.

Merges (edits to existing rules, no separate rules):

- **thinking-text → thinking-selector**: the selector's toolbar text
  renames live inside the thinking-selector rule
  (`agentxRenameTextIn(toolbar)`).
- **toast-text → rename-text**: verified — toasts live inside
  `document.body` (Ant Design mounts its message/toast container
  under the body), so rename-text's `createTreeWalker(document.body)`
  already covers them; no root extension was needed. NOT live-verified
  against this console (machine down at build time); if a toast ever
  renders outside the body, rename-text's root must be extended.
  error-rebrand adds scoped coverage for `role="alert"` toasts.
- **rename-attrs-v2 → rename-attrs**: now also covers `alt` and
  `data-tooltip` (in addition to aria-label, placeholder, title).
  Ownership split, and why: `img` elements are SKIPPED by
  rename-attrs — the logo rule owns img attributes. If rename-attrs
  renamed the logo img's alt first, rename-logo's
  `img[alt*="QwenPaw"]` selector would never match and the logo would
  never be swapped for the wordmark.
- **rename-logo-v2 → rename-logo**: also matches
  `img[title*="QwenPaw"]` and `img[aria-label*="QwenPaw"]` with the
  same displayed-width size gate; non-img elements matched by
  title/aria-label get an attribute rename only (no swap).

Shared helpers added: `agentxIsUpstreamHref`,
`agentxHideRowByText` (LEAF-ONLY — an element with element children
is skipped, so a big container whose text merely contains the label is
never hidden; multi-word labels match as substrings, single-word
labels must match the whole trimmed text, so "Upgrades" never matches
"Upgrade"), `agentxRenameScoped` / `agentxRenameNeedleInBody`
(text-node renames with a scope marker), `agentxScopeMarker`
(class/aria-label/title only — deliberately NOT textContent: a shared
ancestor's text contains every label in its subtree, so a menu that
also holds an About row would false-positive on "Settings"; this was
caught by the harness — the first version used a textContent heading
check and renamed the About row outside Settings too).

### Model-labels mapping — documented judgment call, needs user confirmation

`deepseek-v4.1-flash-free` display text → **AgentX-1-Mini**;
`nex-n2.6` display text → **AgentX-1**. Reasoning: flash = small/fast
tier, so it maps to the Mini tier; nex-n2.6 is the full serving model,
so it maps to the base tier. This is a naming guess, not a measured
fact — the real model ids are unchanged upstream and nothing sent to
the API changes. Rohan should confirm (or rename) the mapping; until
then the rule ships with these two pairs and leaves every other label
alone.

### Head-rebrand manifest — no-op, documented

`link[rel="manifest"]` points at an EXTERNAL file, so the rule does
NOT fetch it (fetching a manifest to rewrite it would be a network
request on every console load, and the file is served from the origin
bundle). The only inline renames are the meta contents and the
application-name meta; if no inline name exists, the manifest part is
a no-op. Renaming the external manifest file itself is a separate
decision (it lives in the upstream bundle).

## Later rule additions (after Part 3 — rule table 41 → 44)

- **hide-native-thinking** (2026-11-19, QA round 20): hides the
  console's own "Thinking intensity" control when the injected
  thinking selector exists. Rule table 41 → 42.
- **queue-takeover** (2026-11-19, post-reset-verify cron Step 10):
  adds a "Take over sending" button on the queue-only banner in a
  non-owner tab and hides the dead "Interrupt & send" button there;
  the button posts `release-ownership` on the `qwenpaw:queue`
  BroadcastChannel, which the patched console bundle
  (`features/queue-takeover`) answers by aborting the owner tab's
  ownership AbortController. Rule table 42 → 43. Its own tests live
  under `features/queue-takeover`; only its presence is asserted in
  the T114 harness.
- **settings-white-area** (2026-11-19 ~08:1x IST): the outer settings
  `<main>` renders ~819px tall in a 998px viewport on Pages, so a
  ~179px white body strip shows below its cream (browser-verified on
  qwenpawx.pages.dev/settings/general at 1919x998; the direct origin
  has no strip). The rule stretches the nav-anchored shell
  (`nav[aria-label="Settings"]` → closest `main`) to 100dvh and
  paints `<html>` + `<body>` with the shell's own computed background
  (cream in light mode, the dark surface in dark mode — never a
  hard-coded colour), walks up ancestors when the shell itself is
  transparent, no-ops off /settings and before the nav mounts, and
  removes the fill on leaving Settings. Rule table 43 → 44;
  T114 186 → 195 checks, T144 is the 9-check subset. Round 2
  (~08:4x IST): the paint source is the console's --app-bg theme
  variable (#f9f8f4 light / #141414 dark, class fallback), never the
  shell's background, with !important, and the stretch runs up the
  ancestor chain; T114 195 → 198, T144 9 → 12. Round 3 (~09:0x
  IST): round 2 changed nothing live — the shell (.page-content) is
  transparent inside a WHITE full-height
  .index-module__mainContentLayout wrapper (background:
  var(--app-surface)) that covers the html/body paint, so the rule
  now paints the shell AND every ancestor with the theme paint, and
  writes a TEMPORARY visible diagnostic line (AX-DIAG,
  elementFromPoint strip probes) readable as page text for the
  browser check; T114 198 → 205, T144 12 → 19. Round 4 (~09:0x
  IST): the live check read the line (rule=ran, shell h=998,
  body/html bg rgb(249,248,244)) and confirmed the fix — light
  cream to y=998, 0px strip; the AX-DIAG line and its probe are
  removed here, paint + stretch untouched; T114 205, T144 19.
  Live browser re-verification (line gone AND cream still fills,
  light + dark, top scroll and max scroll) is pending with Muse
  after the Pages deploy.

## Live verification (deployed 83c3003; this commit NOT yet deployed)

- **Deployed: v1 + fix rounds 1–2 (commit 83c3003, both Pages).**
  Live-verified three times in a real browser (satwik):
  #1 (11:13–11:18 IST) partly live — titles/About/no-update-prompt pass,
  menu buttons and China cards only blanked, About click dead, logo
  still QwenPaw, /status note still QwenPaw; #2 (11:30–11:34 IST) 5 of 7
  pass — no icon buttons, About opens /status, logo AgentX, title no
  flash, test message replied; the /status note read "QwenPaw" only
  because the check ran ~2 min after the worker deploy, before the next
  5-min probe wrote the fresh note (verified "AgentX console answered"
  by direct query right after); SiliconFlow / ModelScope / Aliyun still
  present because the old climb hid the whole list. #3 (11:47–11:50 IST)
  — provider hiding PASS (settled list 14 healthy non-China cards,
  SiliconFlow / ModelScope / Aliyun / DashScope all 0, by list and by
  search), /status note PASS ("AgentX console answered"), logo + test
  message PASS, no "QwenPaw" text anywhere in the visible UI — but the
  XiaoYi channel card still visible and Yuanbao present (this fix).
- **This commit NOT yet deployed.** After deploy, verify live in a
  real browser (check #4): Settings > Channels shows NO XiaoYi and NO
  Yuanbao card, the other five China channels still absent, and
  Telegram / Slack / iMessage still visible; Settings > Models still
  shows the 14 non-China provider cards with SiliconFlow / ModelScope /
  Aliyun / DashScope at 0. The harness (T114) proves the mechanism
  against mocks; only a real browser proves it against the live console.

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
