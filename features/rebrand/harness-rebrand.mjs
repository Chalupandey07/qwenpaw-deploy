#!/usr/bin/env node
/**
 * Harness T114 — AgentX rebrand (DOM injection).
 *
 * THE CHANGE (2026-11-18, features/rebrand/README.md)
 *
 * The product is AgentX; the upstream console still calls itself QwenPaw.
 * The visible rename is done by DOM injection in the browser, never by
 * rewriting the bundle (immutable, cache-pinned for a year):
 *
 *   (a) headShim() — an early classic inline script that patches
 *       window.fetch so ONLY https://pypi.org/pypi/qwenpaw/json is
 *       answered with {info:{version:"2.3.0"}} (the pinned version, so
 *       the hourly update checker never nags) and patches window.open
 *       to swallow the two upstream hosts (docs + upstream GitHub).
 *       Everything else falls through to native.
 *   (b) A MutationObserver rule table (AGENTX_RULES) inside
 *       computerPanelScript that renames visible "QwenPaw" text and
 *       hides the upstream menu items, the China provider/channel cards,
 *       and the rest of the debloat list. Each rule in its own try/catch.
 *   (c) Our own strings (waking/cooldown pages, 502/409 texts, button
 *       tooltip, board/routines titles) renamed to AgentX; the console
 *       <title> rewritten at the proxy layer.
 *
 * WHAT THIS ASSERTS
 *
 *   Static, on the real pages/public/_worker.js:
 *     - the fetch patch targets exactly the PyPI URL (and only it);
 *     - the window.open patch swallows exactly the two upstream hosts;
 *     - the kill switch exists (worker env AGENTX_REBRAND=0 and
 *       ?rebrand=0 at runtime);
 *     - the rule table exists (44 rules: the original 13 plus the
 *       later fix-grammar / sidebar-ellipsis / chat-input-fixes /
 *       thinking-selector / page-bottom-padding / pill-positions rules
 *       plus the 22 Part 3 rules plus hide-native-thinking,
 *       queue-takeover and settings-white-area) and each rule runs
 *       in its own try/catch with a console.debug naming the rule;
 *     - the CSP-Report-Only + Referrer-Policy headers are set on the
 *       console HTML response, and the <title> is rewritten;
 *     - the shim is injected before the panel script, and the observer
 *       calls the rebrand pass;
 *     - the keep-alive Worker and the activity-feed Worker report the
 *       note "AgentX console answered" (the /status page shows it).
 *     - Part 3 (2026-11-19): the upstream-host list, the model-label
 *       display map, the inline AX favicon, the no-fetch manifest note,
 *       rename-attrs alt/data-tooltip, rename-logo title/aria-label,
 *       rename-text covering in-body toasts, the thinking-selector
 *       toolbar rename, the title-observer rule, and the leaf-only
 *       row-hide helper.
 *   Dynamic, in a VM with mocks:
 *     - the real shim (extracted from the file, run with the file's own
 *       constants): PyPI fetch is stubbed, other fetches pass through;
 *       window.open is swallowed for the upstream hosts and passes
 *       through for others; ?rebrand=0 leaves fetch/open unpatched.
 *     - the real rebrand rules (extracted between the AGENTX-REBRAND
 *       markers, run against a mock DOM): the title is renamed, a
 *       "Tutorial" menu item is hidden (and "Settings" is not), an
 *       icon-only button matched by its accessible name ("GitHub",
 *       "Documentation") is hidden as a whole button, a "QwenPaw" text
 *       node is renamed while a load-bearing node is left alone, an
 *       aria-label is renamed, and the China cards are hidden on the
 *       REAL card DOM (hashed CSS-module classes from the live bundle:
 *       a DashScope / SiliconFlow / ModelScope / Aliyun provider card
 *       is hidden as a whole card, a DashScope card matched only by its
 *       settings-button aria-label and a SiliconFlow card matched only
 *       by its icon img alt are hidden as whole cards, a non-China
 *       provider (OpenAI) is NOT hidden, the provider list container is
 *       NOT hidden, a WeCom / DingTalk configured channel card and a
 *       Feishu / QQ / WeChat available-channel button are hidden as
 *       whole cards/buttons, a XiaoYi / Yuanbao channel (available
 *       button and configured card, real DOM) is hidden, a XiaoYi
 *       channel matched only by its icon img alt (lowercase id
 *       "xiaoyi") is hidden (this proves the case-insensitive match
 *       does work the label spelling alone cannot do), a non-China
 *       channel (Telegram / Slack / iMessage) is NOT hidden, the
 *       channel grid is NOT hidden, and the China cards
 *       are hidden when the provider list mounts after the initial pass
 *       — the old mock used class "provider-card", which the real
 *       bundle never emits, so it passed while the live rule hid the
 *       whole list), the About item ("About QwenPaw v2.3.0")
 *       is renamed to "About AgentX v2.3.0" and clicking it opens our
 *       /status page, the sidebar logo img (alt "QwenPaw") is replaced
 *       by an "AgentX" text label, a title change is renamed
 *       immediately by the title observer, and an upstream link click is
 *       blocked while a normal link is not.
 *     - Part 3 (2026-11-19), one rule at a time on small mock DOMs
 *       (via agentxRunRuleNow, extracted from the file): each new rule
 *       hides/renames its target and leaves a non-target alone, e.g.
 *       block-links-v2 blocks qwenpaw.com + chat.qwen.ai + data-url /
 *       data-href / form-action upstream targets but NOT the console's
 *       own origin or pages.dev; model-labels renames the picker label
 *       text but NOT the option value or an API payload string;
 *       hide-upgrade hides the upsell but not a "Settings" row;
 *       rename-attrs covers alt + data-tooltip (img alt stays for the
 *       logo rule); rename-logo covers title/aria-label imgs.
 *       settings-white-area (2026-11-19) stretches the settings
 *       shell to the viewport and paints the shell and every
 *       ancestor with the console's --app-bg theme variable (cream
 *       #f9f8f4 in light mode, #141414 in dark mode), never the
 *       shell's own background (the shell is transparent inside a
 *       WHITE full-height mainContentLayout wrapper that covers the
 *       html/body paint); round 3 added a TEMPORARY visible
 *       diagnostic line (AX-DIAG, elementFromPoint strip probes)
 *       readable as page text, which round 4 removed after the
 *       values were read live (rule=ran, shell h=998, 0px strip);
 *       does nothing off /settings or before the nav renders, and
 *       removes the fill on leaving Settings.
 *
 * The live half (a real browser on the deployed console: title is
 * "AgentX Console", no update badge, no upstream menu items, no upstream
 * navigation, China cards hidden) is verified by Muse after deploy.
 *
 * Run: node features/rebrand/harness-rebrand.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUBLIC = resolve(REPO, "pages/public");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const worker = readFileSync(resolve(PUBLIC, "_worker.js"), "utf8");

// ---------- extractors ----------
// Extract a top-level `function name(...) { ... }` by brace matching,
// treating strings / template literals / comments as opaque. The template
// literals in these functions contain ${...} interpolations with no braces
// inside them, so treating a template literal as opaque is safe here.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const brace = src.indexOf("{", start);
  if (brace === -1) return "";
  let depth = 0;
  let i = brace;
  let mode = null; // null | "'" | '"' | "`" | "//" | "/*"
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1] || "";
    if (mode === "//") {
      if (c === "\n") mode = null;
    } else if (mode === "/*") {
      if (c === "*" && next === "/") { mode = null; i += 1; }
    } else if (mode === "'" || mode === '"' || mode === "`") {
      if (c === "\\") { i += 1; }
      else if (c === mode) mode = null;
    } else if (c === "'" || c === '"' || c === "`") {
      mode = c;
    } else if (c === "/" && next === "/") {
      mode = "//";
    } else if (c === "/" && next === "*") {
      mode = "/*";
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i += 1;
  }
  return "";
}

function parseConst(src, name) {
  const m = new RegExp(`const ${name} = "([^"]*)";`).exec(src);
  return m ? m[1] : null;
}

const PYPI_URL = parseConst(worker, "PYPI_QWENPAW_URL");
const PINNED_VERSION = parseConst(worker, "PINNED_QWENPAW_VERSION");
const DOC_ORIGIN = parseConst(worker, "UPSTREAM_DOC_ORIGIN");
const GITHUB_URL = parseConst(worker, "UPSTREAM_GITHUB_URL");

const shimSrc = extractFunction(worker, "headShim");
const rebrandStart = worker.indexOf("/* AGENTX-REBRAND-START */");
const rebrandEnd = worker.indexOf("/* AGENTX-REBRAND-END */");
const rebrandSrc = (rebrandStart !== -1 && rebrandEnd !== -1)
  ? worker.slice(rebrandStart + "/* AGENTX-REBRAND-START */".length, rebrandEnd)
  : "";

console.log("static: the shim patches exactly the upstream hosts");
{
  check("headShim exists", shimSrc.length > 0);
  check("the PyPI URL constant is exactly the update-check URL",
    PYPI_URL === "https://pypi.org/pypi/qwenpaw/json", `got ${PYPI_URL}`);
  check("the fetch patch targets exactly the PyPI URL (and only it)",
    /var u = typeof input === "string" \? input : \(input && input\.url\) \|\| "";\s*if \(u === PYPI_URL\)/.test(shimSrc),
    "a substring match would stub unrelated fetches");
  check("the fetch stub returns the pinned version",
    /info: \{ version: PINNED_VERSION \}/.test(shimSrc));
  check("the pinned version is 2.3.0 (the digest-pinned image)",
    PINNED_VERSION === "2.3.0", `got ${PINNED_VERSION}`);
  check("the docs origin constant is exactly the upstream docs host",
    DOC_ORIGIN === "https://qwenpaw.agentscope.io", `got ${DOC_ORIGIN}`);
  check("the GitHub constant is exactly the upstream repo",
    GITHUB_URL === "https://github.com/agentscope-ai/QwenPaw", `got ${GITHUB_URL}`);
  check("the window.open patch swallows exactly the two upstream hosts",
    /if \(u\.indexOf\(DOC_ORIGIN\) === 0 \|\| u\.indexOf\(GITHUB_URL\) === 0\) return null;/.test(shimSrc),
    "a substring match would swallow same-origin links that merely contain the host");
  check("both patches fall through to native on unmatched input",
    /return nativeFetch\.apply\(this, arguments\);/.test(shimSrc) &&
    /return nativeOpen\.apply\(this, arguments\);/.test(shimSrc));
}

console.log("static: the kill switch exists at both layers");
{
  check("the shim checks ?rebrand=0 at runtime",
    /new URLSearchParams\(location\.search\)\.get\("rebrand"\) === "0"/.test(shimSrc));
  check("the worker env AGENTX_REBRAND=0 gates the injection",
    /env\.AGENTX_REBRAND !== "0"/.test(worker));
  check("the rebrand rules check the baked-in flag and ?rebrand=0",
    /if \(!AGENTX_REBRAND_ENABLED\) return true;/.test(rebrandSrc) &&
    /get\("rebrand"\) === "0"/.test(rebrandSrc));
}

console.log("static: the rule table is data-driven and guarded");
{
  const ruleIds = [...rebrandSrc.matchAll(/\{ id: "([^"]+)", run: function/g)].map((m) => m[1]);
  check("the rule table exists with 44 rules",
    ruleIds.length === 44, `got ${ruleIds.length}: ${ruleIds.join(", ")}`);
  check("the expected rules are all present",
    ["rename-title", "rename-attrs", "rename-text", "fix-grammar", "sidebar-ellipsis",
     "chat-input-fixes", "thinking-selector", "hide-native-thinking", "queue-takeover",
     "settings-white-area", "page-bottom-padding", "pill-positions",
     "rename-logo", "hide-menu", "hide-about", "hide-language", "hide-desktop-prompt",
     "hide-codex-qoder", "hide-voice", "hide-import-text", "hide-china", "block-links",
     "footer-rebrand", "block-links-v2", "hide-powered-by", "hide-feedback",
     "settings-about", "settings-language", "settings-providers", "settings-integrations",
     "hide-upgrade", "account-card", "workspace-switcher", "sidebar-help", "model-labels",
     "title-observer", "head-rebrand", "export-rebrand", "hide-run-in", "auth-rebrand",
     "error-rebrand", "hide-onboarding", "hide-update-banner", "hide-shortcuts-dialog"].every((id) => ruleIds.includes(id)),
    `got ${ruleIds.join(", ")}`);
  // Settings white-area fix (2026-11-19, browser inspection): on
  // /settings the outer settings <main> renders ~819px tall in a 998px
  // viewport on Pages, so a ~179px white body strip shows below its
  // cream background. The rule is scoped to /settings and paints
  // <html> + <body> with the console's own --app-bg theme variable
  // (cream #f9f8f4 light, #141414 dark), never with the shell's
  // computed background — round 1 copied the shell, and the shell is
  // a .page-content whose background is var(--app-surface), white in
  // light mode, so round 1 painted the body white and the strip
  // survived (browser-verified PARTIAL 2026-11-19 ~07:5x IST: cream
  // ends ~894, ~104px white strip left in light mode; dark filled).
  // The stretch runs up the ancestor chain because the shell alone
  // cannot beat the .ant-layout max-height:100vh + overflow:hidden
  // clip in the served bundle. Round 3 added a TEMPORARY visible
  // diagnostic line (AX-DIAG) so the parent could read the live
  // geometry in the cloud browser; round 4 removed it after the
  // values were read (rule=ran, shell h=998, 0px strip), so the
  // rule must contain no diagnostic text, div, probe, or state.
  check("the settings-white-area rule is scoped to /settings pages",
    /id: "settings-white-area"[\s\S]*?indexOf\("\/settings"\) !== 0/.test(rebrandSrc),
    "a fill that ran on /chat would paint the chat background too");
  check("the settings-white-area rule paints from the --app-bg theme variable, never from the shell's background",
    /id: "settings-white-area"[\s\S]*?getPropertyValue\(["']--app-bg["']\)/.test(rebrandSrc) &&
    /id: "settings-white-area"[\s\S]*?setProperty\(["']background-color["']/.test(rebrandSrc) &&
    /id: "settings-white-area"[\s\S]*?setProperty\(["']min-height["']/.test(rebrandSrc) &&
    /id: "settings-white-area"[\s\S]*?data-agentx-settings-stretch/.test(rebrandSrc) &&
    !/id: "settings-white-area"[\s\S]{0,4000}body\.style\.backgroundColor = fill/.test(rebrandSrc) &&
    !rebrandSrc.includes("#f9f7f2"),
    "round 1 copied the shell's white .page-content background onto the body; round 2 reads the theme variable instead");
  // Round 3 (2026-11-19 ~08:4x IST): round 2 changed nothing live
  // even though its code shipped — the paint on <html>/<body> is
  // invisible because the white .index-module__mainContentLayout
  // wrapper between them and the shell covers the body paint. The
  // rule must paint the shell AND every ancestor.
  check("the settings-white-area rule paints the shell and its ancestors, not only html and body",
    /id: "settings-white-area"[\s\S]*?agentxSetBg\(shell\)/.test(rebrandSrc) &&
    /id: "settings-white-area"[\s\S]*?agentxSetBg\(anc\)/.test(rebrandSrc),
    "the white mainContentLayout wrapper covers the body paint; only painting the shell + ancestors reaches the strip");
  // Round 4 (2026-11-19 ~09:0x IST): the round-3 browser check
  // read the diagnostic line (rule=ran, shell h=998, body/html bg
  // rgb(249,248,244)) and confirmed the fix — light mode cream to
  // y=998, 0px strip, top and max scroll; dark filled. The
  // diagnostic line and its probe are removed here; the rule must
  // contain no AX-DIAG text, no diag div, no elementFromPoint
  // probe, and no window/body diagnostic state.
  const settingsRuleSrc = rebrandSrc.slice(
    rebrandSrc.indexOf('id: "settings-white-area"'),
    rebrandSrc.indexOf('id: "page-bottom-padding"'));
  check("the settings-white-area rule writes no diagnostic line (AX-DIAG removed in round 4 after the values were read)",
    settingsRuleSrc.length > 0 &&
    !settingsRuleSrc.includes("AX-DIAG") &&
    !settingsRuleSrc.includes("agentxSettingsDiag") &&
    !settingsRuleSrc.includes("__agentxSettingsDiag") &&
    !settingsRuleSrc.includes("elementFromPoint") &&
    !settingsRuleSrc.includes("data-agentx-settings-diag"),
    "the temporary diagnostic was read live (rule=ran, shell h=998) and must not ship; it covers the header row while scrolling");
  // Logo-flash guard (2026-11-19 QA round 20): the header logo img
  // painted before the rebrand observer renamed it. The injection hides
  // QwenPaw-alt imgs until rename-logo processes them.
  check("a QwenPaw-alt logo img is hidden until the rebrand processes it (no logo flash)",
    /img\[alt\*="QwenPaw"\]:not\(\[data-agentx-logo\]\)\{visibility:hidden/.test(worker));
  // Hide-native v2 (2026-11-19 DOM inspection): the native composer
  // control is labelled "Thinking level for this chat", identical to
  // ours — the rule must match that label (not just "Thinking
  // intensity") and tell the two apart by data-agentx-thinking only.
  check("the hide-native rule matches the native control's real label ('Thinking level for this chat')",
    /hide-native-thinking[\s\S]*?thinking level for this chat/.test(rebrandSrc));
  // Truncated rename (2026-11-19 DOM inspection): the Models card
  // renders "AgentScope Plat…" in the DOM, never the full phrase.
  check("the rename handles the truncated 'AgentScope Plat…' card name",
    rebrandSrc.includes("AgentScope Plat…"));
  check("each rule runs in its own try/catch",
    /try \{ AGENTX_RULES\[i\]\.run\(\); \} catch/.test(rebrandSrc),
    "one rule throwing must not take down the whole pass");
  check("a failed rule is logged with its id",
    /console\.debug\("\[agentx\] rule failed: " \+ AGENTX_RULES\[i\]\.id/.test(rebrandSrc));
  check("the rebrand section has no ${ interpolations (it is extractable)",
    !rebrandSrc.includes("${"),
    "an interpolation would make the extracted section unevaluable");
  check("the menu-hide list covers the upstream items",
    /"Tutorial", "Feature Demos", "Changelog", "FAQ", "GitHub", "Documentation", "Import"/.test(rebrandSrc));
  check("the China-hide list covers the providers and channels, including Aliyun, XiaoYi and Yuanbao",
    /"DashScope", "SiliconFlow", "ModelScope", "Alibaba", "Alibaba Cloud", "Aliyun", "WeCom", "DingTalk", "Feishu", "QQ", "WeChat", "XiaoYi", "Yuanbao"/.test(rebrandSrc),
    "XiaoYi is the console's real display name (the old 'Xiaoyi' occurs nowhere in the live bundle); Yuanbao is Tencent's channel, missed by the original research");
  check("the load-bearing allowlist is enforced by the text pass",
    /"qwenpaw\[codex\]", "qwenpaw\[whisper\]", "QWENPAW_AUTH_ENABLED", "~\/\.qwenpaw"/.test(rebrandSrc) &&
    /agentxIsLoadBearing\(t\)/.test(rebrandSrc) &&
    /agentxIsLoadBearing\(parent\.textContent\)/.test(rebrandSrc));
  check("the multi-window safety prompts are not hidden (only renamed)",
    !/Close QwenPaw\?/.test(rebrandSrc.split("hide-")[0]) &&
    !rebrandSrc.includes('"Close QwenPaw?"'),
    "hiding them would suppress real safety prompts");
  check("the menu/China rules hide by accessible name, not just visible text",
    /function agentxHideByName\(labels, itemSelector, containerSelector(, climbFn)?\)/.test(rebrandSrc) &&
    /aria-label/.test(rebrandSrc) &&
    /agentxHideByName\(AGENTX_MENU_LABELS/.test(rebrandSrc) &&
    /agentxHideByName\(AGENTX_CHINA_LABELS/.test(rebrandSrc),
    "icon-only buttons and cards carry the name only as an aria-label/title/alt");
  check("the hide-by-name helper climbs to the whole container (button/card)",
    /function agentxClimbToContainer\(el, containerSelector\)/.test(rebrandSrc) &&
    /el\.closest\(containerSelector\)/.test(rebrandSrc),
    "hiding only the name leaf leaves an unnamed icon-only shell");
  check("the hide-by-name matching is case-insensitive (XiaoYi fix)",
    /nameLower = name\.toLowerCase\(\)/.test(rebrandSrc) &&
    /labelLower = label\.toLowerCase\(\)/.test(rebrandSrc) &&
    /nameLower === labelLower/.test(rebrandSrc) &&
    /words\[k\] === labelLower/.test(rebrandSrc),
    "the console renders 'XiaoYi' and the icon img alt is the lowercase id 'xiaoyi'; the old case-sensitive match could fire on neither");
  check("the China climb is structural and never returns the list (2026-11-18 fix)",
    /function agentxClimbToChinaCard\(el\)/.test(rebrandSrc) &&
    /providercards/.test(rebrandSrc) && /availablegrid/.test(rebrandSrc) &&
    /groupcardglass/.test(rebrandSrc) && /channelcard/.test(rebrandSrc),
    "the old generic climb hid the whole provider list: [class*='card'] is case-sensitive and never matched the hashed groupCardGlass class, while [class*='provider'] matched the providerCards list container");
  check("the hide-china rule uses the structural China climb, not the generic one",
    /agentxHideByName\(AGENTX_CHINA_LABELS, "li, button, a, \[role='menuitem'\], \[role='listitem'\], span, div, h1, h2, h3, h4, img", null, agentxClimbToChinaCard\)/.test(rebrandSrc),
    "the generic climb is what hid the whole list");
  check("the About click is a delegated capture listener with a prefix match",
    /agentxAboutInstalled/.test(rebrandSrc) &&
    /document\.addEventListener\("click", function \(ev\)/.test(rebrandSrc) &&
    /t\.indexOf\("About QwenPaw"\) === 0 \|\| t\.indexOf\("About AgentX"\) === 0/.test(rebrandSrc) &&
    /window\.open\("\/status", "_blank"\)/.test(rebrandSrc),
    "the old exact-match rule never fired: the real label carries ' v2.3.0'");
  check("the title is watched by its own observer (no seconds-long flash)",
    /function agentxWatchTitle\(\)/.test(rebrandSrc) &&
    /document\.querySelector\("title"\)/.test(rebrandSrc) &&
    /new MutationObserver\(function \(\)/.test(rebrandSrc) &&
    /agentxWatchTitle\(\);/.test(worker),
    "a title change does not mutate the body, so the body observer never sees it");
  check("the logo rule replaces the QwenPaw img with an AgentX text label",
    /img\[alt\*="QwenPaw"\]/.test(rebrandSrc) &&
    /replaceChild\(label, img\)/.test(rebrandSrc) &&
    /label\.textContent = "AgentX"/.test(rebrandSrc));
}

console.log("static: Part 3 rebrand gaps (2026-11-19)");
{
  check("the upstream-host list covers the seven upstream hosts",
    /"qwenpaw.com", "qwenlm.github.io", "github.com\/QwenLM", "discord.gg", "alibabacloud.com", "dashscope.aliyuncs.com", "chat.qwen.ai"/.test(rebrandSrc));
  check("the upstream-host helper exists and the link blocker uses it",
    /function agentxIsUpstreamHref\(href\)/.test(rebrandSrc) &&
    /agentxIsUpstreamHref\(href\)/.test(rebrandSrc));
  check("block-links-v2 covers data-url / data-href / form action, not just a[href]",
    /id: "block-links-v2"/.test(rebrandSrc) &&
    /\[data-url\]/.test(rebrandSrc) && /\[data-href\]/.test(rebrandSrc) && /form\[action\]/.test(rebrandSrc));
  check("the model-label display map is AgentX-1-Mini for flash-free, AgentX-1 for nex-n2.6",
    /"deepseek-v4.1-flash-free", "AgentX-1-Mini"/.test(rebrandSrc) &&
    /"nex-n2.6", "AgentX-1"/.test(rebrandSrc),
    "documented judgment call (flash = small/fast tier) — needs user confirmation, see README");
  check("the favicon is an inline data-URI SVG with the AX mark (no external URL)",
    /AGENTX_FAVICON_DATA = "data:image\/svg\+xml,/.test(rebrandSrc) &&
    /%3EAX%3C\/text%3E/.test(rebrandSrc));
  check("head-rebrand does not fetch the external manifest (no-op if no inline name)",
    /do NOT fetch it/.test(rebrandSrc) &&
    !/fetch\([^)]*manifest/.test(rebrandSrc));
  check("rename-attrs covers alt and data-tooltip (in addition to aria-label, placeholder, title)",
    /\[alt\*="QwenPaw"\]/.test(rebrandSrc) && /\[data-tooltip\*="QwenPaw"\]/.test(rebrandSrc));
  check("rename-logo covers img matched by title / aria-label, not only alt",
    /img\[title\*="QwenPaw"\]/.test(rebrandSrc) && /img\[aria-label\*="QwenPaw"\]/.test(rebrandSrc));
  check("rename-text walks document.body, so in-body toasts are renamed too",
    /agentxRenameTextIn\(document\.body\)/.test(rebrandSrc),
    "Ant Design mounts its message/toast container under document.body; see README for the verification note");
  check("the thinking-selector rule renames QwenPaw text in its own toolbar (thinking-text merge)",
    /agentxRenameTextIn\(toolbar\)/.test(rebrandSrc));
  check("title-observer wires the title watcher into a rule (install once + rename now)",
    /id: "title-observer"/.test(rebrandSrc) && /agentxWatchTitle\(\)/.test(rebrandSrc));
  check("the row-hide helper is leaf-only and marks hidden rows (never hides a list container)",
    /function agentxHideRowByText\(/.test(rebrandSrc) &&
    /el\.children && el\.children\.length/.test(rebrandSrc) &&
    /data-agentx-hidden/.test(rebrandSrc));
}

console.log("static: the /status note is AgentX (keep-alive + activity-feed workers)");
{
  const keepalive = readFileSync(resolve(REPO, "worker/src/index.js"), "utf8");
  const activity = readFileSync(resolve(REPO, "features/infra/workers/activity-feed/index.js"), "utf8");
  check("the keep-alive probe note is AgentX",
    /note: "AgentX console answered"/.test(keepalive) &&
    !/note: "QwenPaw console answered"/.test(keepalive),
    "the /status page renders this note");
  check("the activity-feed probe note is AgentX",
    /note: "AgentX console answered"/.test(activity) &&
    !/note: "QwenPaw console answered"/.test(activity));
  check("the activity-feed page title and heading are AgentX",
    /<title>AgentX — Live activity<\/title>/.test(activity) &&
    /<h1>AgentX — live activity<\/h1>/.test(activity));
}

console.log("static: the proxy wires the shim, the title, and the headers");
{
  check("the shim is injected before the panel script",
    /\(rebrandEnabled \? headShim\(\) : ""\) \+ computerPanelScript\(rebrandEnabled\)/.test(worker));
  check("the console <title> is rewritten at the proxy layer",
    /html\.replace\("<title>QwenPaw Console<\/title>", "<title>AgentX Console<\/title>"\)/.test(worker));
  check("the observer calls the rebrand pass",
    /vaultMenuObserver = new MutationObserver\(function \(\) \{/.test(worker) &&
    /agentxRunRules\(\);/.test(worker),
    "the observer is vaultMenuObserver (addVaultMenuItem + agentxRunRuleNow fast path + agentxRunRules), not the old inline form");
  check("CSP-Report-Only blocks third-party images (alicdn)",
    /headers\.set\("Content-Security-Policy-Report-Only", "img-src 'self' data: blob:"\)/.test(worker));
  check("Referrer-Policy no-referrer is set on the console HTML",
    /headers\.set\("Referrer-Policy", "no-referrer"\)/.test(worker));
  check("the waking page title is AgentX",
    /<title>AgentX: Waking up<\/title>/.test(worker) && /<h1>AgentX is waking up<\/h1>/.test(worker));
  check("the cooldown page title is AgentX",
    /<title>AgentX: Cooldown<\/title>/.test(worker) && /<h1>AgentX is in max-run cooldown<\/h1>/.test(worker));
  check("the 502 text is AgentX",
    /AgentX console temporarily unavailable/.test(worker) &&
    !/QwenPaw console temporarily unavailable/.test(worker));
}

// ---------- mock DOM ----------
// A minimal fake DOM: just enough for the rebrand rules. Elements carry a
// tag, attributes, element children + text-node children; textContent is
// computed recursively so renaming a text node updates its ancestors.
function makeText(value) {
  return { nodeType: 3, nodeName: "#text", nodeValue: value, parentNode: null };
}
function makeEl(tag, attrs, children) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    children: [],
    childNodes: [],
    parentNode: null,
    // Style object with the CSSOM property API (2026-11-19, round 2 of
    // the settings-white-area fix): the rule paints with
    // setProperty(..., "important") and removes with removeProperty,
    // so the mock needs both plus getPropertyValue. setProperty also
    // mirrors the camelCase alias (min-height -> minHeight) so the
    // existing plain-property assertions keep reading the same value;
    // removeProperty deletes the alias again.
    style: {
      setProperty(prop, value) {
        this._props = this._props || {};
        this._props[prop] = String(value);
        const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this[camel] = value;
      },
      getPropertyValue(prop) {
        return (this._props && this._props[prop]) || "";
      },
      removeProperty(prop) {
        const old = (this._props && this._props[prop]) || "";
        if (this._props) delete this._props[prop];
        const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        delete this[camel];
        return old;
      },
    },
    _attrs: { ...(attrs || {}) },
    _listeners: {},
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; },
    setAttribute(name, value) { this._attrs[name] = String(value); },
    removeAttribute(name) { delete this._attrs[name]; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, ev) { for (const fn of this._listeners[type] || []) fn(ev); },
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx === -1) throw new Error("NotFoundError: removeChild of a non-child");
      child.parentNode = null;
      this.childNodes.splice(idx, 1);
      const ci = this.children.indexOf(child);
      if (ci !== -1) this.children.splice(ci, 1);
      return child;
    },
    replaceChild(newChild, oldChild) {
      const idx = this.childNodes.indexOf(oldChild);
      if (idx === -1) throw new Error("NotFoundError: replaceChild of a non-child");
      oldChild.parentNode = null;
      newChild.parentNode = this;
      this.childNodes[idx] = newChild;
      const ci = this.children.indexOf(oldChild);
      if (ci !== -1) this.children[ci] = newChild;
      return oldChild;
    },
    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.nodeType === 1 && matchesSelector(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
  };
  Object.defineProperty(el, "textContent", {
    get() {
      let out = "";
      for (const c of this.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else out += c.textContent;
      }
      return out;
    },
    set(v) { this.childNodes = [makeText(String(v))]; this.childNodes[0].parentNode = this; this.children = []; },
    configurable: true,
  });
  Object.defineProperty(el, "parentElement", {
    get() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; },
    configurable: true,
  });
  // Layout geometry (2026-11-19, round 3 of the settings-white-area
  // fix): the rule reads shell.offsetHeight / offsetTop for the
  // diagnostic probe, and the realistic test sets them to the live
  // measurements (shell 894px in a 998px viewport). A mock element
  // carries them in _offsetHeight / _offsetTop (unset = 0).
  Object.defineProperty(el, "offsetHeight", {
    get() { return el._offsetHeight || 0; },
    set(v) { el._offsetHeight = v; },
    configurable: true,
  });
  Object.defineProperty(el, "offsetTop", {
    get() { return el._offsetTop || 0; },
    set(v) { el._offsetTop = v; },
    configurable: true,
  });
  // select.options: the OPTION element children (a real HTMLCollection is
  // array-like; an array is enough for the rules, which only index it).
  Object.defineProperty(el, "options", {
    get() { return this.children.filter((c) => c.tagName === "OPTION"); },
    configurable: true,
  });
  for (const child of children || []) {
    child.parentNode = el;
    el.childNodes.push(child);
    if (child.nodeType === 1) el.children.push(child);
  }
  // classList.contains (2026-11-19, round 2 of the settings-white-area
  // fix): the rule detects dark mode from the "dark-mode" class on
  // <html> (the console's own mechanism: `html.dark-mode` in the
  // bundle). Only contains is modelled — the tests set the class with
  // setAttribute, as a real page would through the app.
  el.classList = {
    contains(cls) { return (el.getAttribute("class") || "").split(/\s+/).includes(cls); },
  };
  return el;
}
// Simplified selector matching for exactly the forms the rebrand rules
// use: tag, [attr*="v"], [attr="v"] / [attr='v'], comma-separated lists.
function matchesCompound(el, sel) {
  sel = sel.trim();
  if (!sel) return false;
  if (sel === "*") return true;
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(sel);
  if (tagMatch && el.tagName !== tagMatch[1].toUpperCase()) return false;
  const attrRe = /\[([a-zA-Z-]+)(\*?=)"([^"]*)"\]/g;
  let m;
  let anyAttr = false;
  while ((m = attrRe.exec(sel)) !== null) {
    anyAttr = true;
    const val = el.getAttribute(m[1]);
    if (val === null) return false;
    if (m[2] === "*=") { if (!val.includes(m[3])) return false; }
    else if (val !== m[3]) return false;
  }
  const attrReSq = /\[([a-zA-Z-]+)(\*?=)'([^']*)'\]/g;
  while ((m = attrReSq.exec(sel)) !== null) {
    anyAttr = true;
    const val = el.getAttribute(m[1]);
    if (val === null) return false;
    if (m[2] === "*=") { if (!val.includes(m[3])) return false; }
    else if (val !== m[3]) return false;
  }
  // [attr~="v"] (whitespace-separated token, e.g. link[rel~="icon"]).
  const attrReTilde = /\[([a-zA-Z-]+)~="([^"]*)"\]/g;
  while ((m = attrReTilde.exec(sel)) !== null) {
    anyAttr = true;
    const val = el.getAttribute(m[1]);
    if (val === null) return false;
    if (!val.split(/\s+/).includes(m[2])) return false;
  }
  // Bare [attr] (presence only, e.g. a[href]).
  const bareAttrRe = /\[([a-zA-Z-]+)\]/g;
  while ((m = bareAttrRe.exec(sel)) !== null) {
    anyAttr = true;
    if (el.getAttribute(m[1]) === null) return false;
  }
  if (!tagMatch && !anyAttr) return false;
  return true;
}
function matchesSelector(el, selector) {
  return selector.split(",").some((part) => matchesCompound(el, part));
}
function collectAll(root, out) {
  out.push(root);
  for (const c of root.childNodes || []) {
    if (c.nodeType === 1) collectAll(c, out);
  }
  return out;
}
function makeDocument(rootEl, headChildren) {
  const listeners = {};
  const titleText = makeText("QwenPaw Console");
  const titleEl = makeEl("title", {}, [titleText]);
  const headEl = makeEl("head", {}, headChildren || []);
  // documentElement (2026-11-19, settings-fill): the real <html>
  // element. The settings-fill rule paints <html> + <body> with the
  // shell's computed background and marks <html> with
  // data-agentx-settings-fill, so the mock needs a real html element
  // above head + body (its parentNode, for the rule's ancestor walk).
  const htmlEl = makeEl("html", {}, [headEl, rootEl]);
  const doc = {
    body: rootEl,
    head: headEl,
    documentElement: htmlEl,
    _headEl: headEl,
    _listeners: listeners,
    _titleEl: titleEl,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
    dispatchEvent(ev) { return true; },
    querySelector(selector) {
      if (selector === "title") return titleEl;
      const all = this.querySelectorAll(selector);
      return all.length ? all[0] : null;
    },
    querySelectorAll(selector) {
      // A real document.querySelectorAll searches the whole document
      // including <html> itself, so search from the html element (it
      // contains head + body); the settings-white-area cleanup sweep
      // must find <html>'s own paint marker.
      return collectAll(htmlEl, []).filter((el) => matchesSelector(el, selector));
    },
    getElementById(id) {
      return this.querySelectorAll("*").find((el) => el.getAttribute("id") === id) || null;
    },
    // elementFromPoint (2026-11-19, round 3 of the
    // settings-white-area fix): the rule probes which element paints
    // the strip below the shell. The mock has no layout engine, so a
    // test installs the answer with opts.elementFromPoint; unset =
    // null, as if the point hit nothing.
    elementFromPoint(x, y) {
      if (typeof this._elementFromPointFn === "function") return this._elementFromPointFn(x, y);
      return null;
    },
    createElement(tag) { return makeEl(tag, {}, []); },
    createTreeWalker(root, whatToShow) {
      const texts = [];
      (function walk(node) {
        for (const c of node.childNodes || []) {
          if (c.nodeType === 3) texts.push(c);
          else walk(c);
        }
      })(root);
      let i = 0;
      return { nextNode() { return i < texts.length ? texts[i++] : null; } };
    },
  };
  // document.title is kept in sync with the <title> element's text, as in
  // a real browser: setting it changes the element, which is what the
  // title observer watches.
  Object.defineProperty(doc, "title", {
    get() { return titleText.nodeValue; },
    set(v) { titleText.nodeValue = String(v); },
    configurable: true,
  });
  return doc;
}
// Minimal MutationObserver: records the callback and the observed target so
// the test can fire the callback itself (there is no real mutation engine
// in the mock).
class MockMutationObserver {
  constructor(cb) { this.cb = cb; MockMutationObserver.instances.push(this); }
  observe(target, options) { this.target = target; this.options = options; }
  disconnect() {}
}
MockMutationObserver.instances = [];

console.log("dynamic: the real shim stubs PyPI and swallows upstream opens");
if (!shimSrc) {
  // Fail-first path: without headShim the VM cannot run at all. Record the
  // dynamic checks as failures instead of crashing, so the harness still
  // reports a count against the unmodified file.
  for (const name of [
    "PyPI fetch (string URL) is stubbed with the pinned version",
    "PyPI fetch does not reach the native fetch",
    "PyPI fetch (Request-like object) is stubbed too",
    "an unrelated fetch passes through to native",
    "an unrelated Request-like fetch passes through to native",
    "window.open to the docs host returns null",
    "window.open to the upstream repo returns null",
    "swallowed opens never reach the native open",
    "window.open to another host passes through to native",
  ]) check(name, false, "headShim not found in _worker.js");
} else {
  const nativeFetchCalls = [];
  const nativeOpenCalls = [];
  const sandbox = {
    window: {
      fetch: async (input) => { nativeFetchCalls.push(typeof input === "string" ? input : input.url); return { ok: true, status: 200, json: async () => ({}) }; },
      open: (url) => { nativeOpenCalls.push(url); return { closed: false }; },
    },
    location: { search: "" },
    URLSearchParams,
    Response,
    console,
    JSON,
    Promise,
    PYPI_QWENPAW_URL: PYPI_URL,
    PINNED_QWENPAW_VERSION: PINNED_VERSION,
    UPSTREAM_DOC_ORIGIN: DOC_ORIGIN,
    UPSTREAM_GITHUB_URL: GITHUB_URL,
  };
  sandbox.window.fetch = sandbox.window.fetch.bind(sandbox.window);
  vm.createContext(sandbox);
  vm.runInContext(shimSrc, sandbox);
  const shimScript = vm.runInContext("headShim()", sandbox);
  // headShim returns the full <script> block; run only the JS inside it.
  const shimJs = shimScript.replace(/^<script>\n?/, "").replace(/\n?<\/script>\s*$/, "");
  vm.runInContext(shimJs, sandbox);

  const pypi = await sandbox.window.fetch(PYPI_URL);
  const pypiJson = await pypi.json();
  check("PyPI fetch (string URL) is stubbed with the pinned version",
    pypiJson && pypiJson.info && pypiJson.info.version === "2.3.0",
    JSON.stringify(pypiJson));
  check("PyPI fetch does not reach the native fetch",
    nativeFetchCalls.length === 0, `native saw ${nativeFetchCalls.join(", ")}`);
  const pypiReq = await sandbox.window.fetch({ url: PYPI_URL });
  const pypiReqJson = await pypiReq.json();
  check("PyPI fetch (Request-like object) is stubbed too",
    pypiReqJson && pypiReqJson.info && pypiReqJson.info.version === "2.3.0");
  await sandbox.window.fetch("https://example.com/api/status");
  check("an unrelated fetch passes through to native",
    nativeFetchCalls.includes("https://example.com/api/status"),
    `native saw ${nativeFetchCalls.join(", ")}`);
  await sandbox.window.fetch({ url: "https://example.com/api/other" });
  check("an unrelated Request-like fetch passes through to native",
    nativeFetchCalls.includes("https://example.com/api/other"));

  const r1 = sandbox.window.open("https://qwenpaw.agentscope.io/docs/intro?lang=en");
  check("window.open to the docs host returns null",
    r1 === null, `got ${r1}`);
  const r2 = sandbox.window.open("https://github.com/agentscope-ai/QwenPaw");
  check("window.open to the upstream repo returns null",
    r2 === null, `got ${r2}`);
  check("swallowed opens never reach the native open",
    nativeOpenCalls.length === 0, `native saw ${nativeOpenCalls.join(", ")}`);
  sandbox.window.open("https://example.com/page");
  check("window.open to another host passes through to native",
    nativeOpenCalls.includes("https://example.com/page"));
}

console.log("dynamic: ?rebrand=0 leaves fetch/open unpatched");
if (!shimSrc) {
  check("with ?rebrand=0 the PyPI fetch reaches the native fetch", false, "headShim not found in _worker.js");
} else {
  const nativeFetchCalls = [];
  const sandbox = {
    window: {
      fetch: async (input) => { nativeFetchCalls.push(typeof input === "string" ? input : input.url); return { ok: true }; },
      open: () => ({ closed: false }),
    },
    location: { search: "?rebrand=0" },
    URLSearchParams,
    Response,
    console,
    JSON,
    Promise,
    PYPI_QWENPAW_URL: PYPI_URL,
    PINNED_QWENPAW_VERSION: PINNED_VERSION,
    UPSTREAM_DOC_ORIGIN: DOC_ORIGIN,
    UPSTREAM_GITHUB_URL: GITHUB_URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(shimSrc, sandbox);
  const shimScript = vm.runInContext("headShim()", sandbox);
  const shimJs = shimScript.replace(/^<script>\n?/, "").replace(/\n?<\/script>\s*$/, "");
  vm.runInContext(shimJs, sandbox);
  await sandbox.window.fetch(PYPI_URL);
  check("with ?rebrand=0 the PyPI fetch reaches the native fetch",
    nativeFetchCalls.includes(PYPI_URL),
    `native saw ${nativeFetchCalls.join(", ")}`);
}

console.log("dynamic: the real rebrand rules on a mock DOM");
if (!rebrandSrc) {
  for (const name of [
    "the document title is renamed to AgentX",
    "a 'Tutorial' menu item is hidden",
    "a 'GitHub' menu item is hidden",
    "an icon-only 'GitHub' header button (accessible name only) is hidden as a whole button",
    "an icon-only 'Documentation' header button (accessible name only) is hidden as a whole button",
    "an icon-only 'Documentation' Settings-menu button is hidden as a whole button",
    "a 'Settings' menu item is NOT hidden",
    "a visible 'QwenPaw' text node is renamed to AgentX",
    "a QwenPaw warning sharing a plain container with a load-bearing sibling is renamed (Community page)",
    "the 'Connect QwenPaw…' button in that container is renamed too",
    "a load-bearing code snippet in the same container is left alone",
    "'AgentScope Platform' is renamed to 'AgentX Platform'",
    "the console's own 'Thinking intensity' control is hidden when our selector exists",
    "the console's native thinking SELECT (same label as ours) is hidden when our selector exists",
    "a truncated 'AgentScope Plat…' name is renamed to 'AgentX Plat…'",
    "a bare 'AgentScope' name is renamed to 'AgentX'",
    "our injected thinking selector is NOT hidden by the hide-native rule",
    "a load-bearing instruction is left alone (truthful, not renamed)",
    "an aria-label with QwenPaw is renamed",
    "a DashScope provider card (real DOM) is hidden as a whole card",
    "a SiliconFlow provider card (real DOM) is hidden as a whole card",
    "a ModelScope provider card (real DOM) is hidden as a whole card",
    "an Aliyun provider card (real DOM) is hidden as a whole card",
    "an Alibaba Cloud card matched only by its settings-button aria-label (real DOM) is hidden as a whole card",
    "a SiliconFlow card matched only by its icon img alt (real DOM) is hidden as a whole card",
    "a non-China provider card (OpenAI, real DOM) is NOT hidden",
    "a non-China provider card (DeepSeek, real DOM) is NOT hidden",
    "a non-China provider card (Anthropic, real DOM) is NOT hidden",
    "the provider list container is NOT hidden (no over-hide)",
    "a WeCom configured channel card (real DOM) is hidden as a whole card",
    "a DingTalk configured channel card (real DOM) is hidden as a whole card",
    "a Feishu available-channel button (real DOM) is hidden as a whole button",
    "a QQ available-channel button (real DOM) is hidden as a whole button",
    "a WeChat available-channel button (real DOM) is hidden as a whole button",
    "a XiaoYi available-channel button (real DOM) is hidden as a whole button",
    "a XiaoYi configured channel card (real DOM) is hidden as a whole card",
    "a Yuanbao available-channel button (real DOM) is hidden as a whole button",
    "a Yuanbao configured channel card (real DOM) is hidden as a whole card",
    "a XiaoYi channel matched only by its icon img alt (lowercase id 'xiaoyi', real DOM) is hidden as a whole button",
    "a non-China channel (iMessage available, real DOM) is NOT hidden",
    "a non-China channel (Telegram configured, real DOM) is NOT hidden",
    "a non-China channel (Slack available, real DOM) is NOT hidden",
    "the channel grid is NOT hidden",
    "China cards are hidden when the provider list mounts after the initial pass (async mount)",
    "the About item is renamed to AgentX (version kept)",
    "clicking About opens our /status page, not the upstream site",
    "the sidebar logo img is replaced by an 'AgentX' text label",
    "the logo img alt is renamed to AgentX",
    "a title observer is registered on the <title> element",
    "a title change is renamed immediately by the title observer",
    "a click on an upstream docs link is blocked",
    "a click on a same-origin link is NOT blocked",
  ]) check(name, false, "AGENTX-REBRAND markers not found in _worker.js");
} else {
  // A small console-like DOM: a header menu, icon-only header buttons,
  // a settings menu, provider cards (one named in text, one only by
  // aria-label, one only by an img alt), an About item carrying the
  // version, a sidebar logo img, a load-bearing instruction, and an
  // aria-label.
  const menu = makeEl("ul", { class: "qwenpaw-menu" }, [
    makeEl("li", { class: "qwenpaw-menu-item" }, [makeEl("span", {}, [makeText("Tutorial")])]),
    makeEl("li", { class: "qwenpaw-menu-item" }, [makeEl("span", {}, [makeText("GitHub")])]),
    makeEl("li", { class: "qwenpaw-menu-item" }, [makeEl("span", {}, [makeText("Settings")])]),
  ]);
  const githubIconBtn = makeEl("button", { "aria-label": "GitHub" }, [makeEl("svg", {}, [])]);
  const docsIconBtn = makeEl("button", { "aria-label": "Documentation" }, [makeEl("svg", {}, [])]);
  const header = makeEl("div", { class: "header" }, [githubIconBtn, docsIconBtn]);
  const settingsDocsBtn = makeEl("button", { "aria-label": "Documentation" }, [makeEl("svg", {}, [])]);
  const settingsMenu = makeEl("div", { class: "settings-menu" }, [settingsDocsBtn]);
  const aboutSpan = makeEl("span", {}, [makeText("About QwenPaw v2.3.0")]);
  const aboutLi = makeEl("li", { class: "qwenpaw-menu-item" }, [aboutSpan]);
  const logoImg = makeEl("img", { alt: "QwenPaw" }, []);
  // The mock has no layout engine, so give the brand logo a displayed
  // width (the real logo is displayed large; the size gate in
  // rename-logo needs a real width to swap it for the text label).
  logoImg.getBoundingClientRect = () => ({ width: 120, height: 40 });
  const brandDiv = makeEl("div", { class: "sidebar-brand" }, [logoImg, makeText(" v2.3.0")]);
  const greeting = makeEl("p", {}, [makeText("Hello! I'm QwenPaw. How can I help you?")]);
  const loadBearing = makeEl("p", {}, [makeText("Set QWENPAW_AUTH_ENABLED=true to use the QwenPaw terminal.")]);
  const ariaBtn = makeEl("button", { "aria-label": "QwenPaw menu" }, [makeText("Menu")]);
  // Real provider-card DOM (RemoteProviderCard-CFfBXPIy.js + the CSS module
  // index.module-D02jL-aA.js, as served): the card is a motion div with the
  // hashed class groupCardGlass, the name is a span.groupCardName, the list
  // is a div.providerCards. The old mock used class "provider-card", which
  // the real bundle never emits — it passed while the live rule hid the
  // whole list (the case-sensitive [class*='card'] never matched
  // groupCardGlass, while [class*='provider'] matched providerCards).
  const CLS = {
    list: "index-module__providerCards__fYCGM",
    card: "index-module__groupCardGlass__-GYEf",
    header: "index-module__groupCardHeader__gVMHN",
    name: "index-module__groupCardName__ZaRnj",
    content: "index-module__groupCardContent__-KLao",
    actions: "index-module__groupCardActions__DhxKz",
  };
  function realProviderCard(providerName, opts = {}) {
    const children = [];
    children.push(makeEl("button", { "aria-label": `Settings: ${providerName}` }, [makeEl("svg", {}, [])]));
    const headerChildren = [makeEl("span", { class: "index-module__providerIcon__x" }, [])];
    if (!opts.nameInAltOnly && !opts.nameInAriaOnly) {
      headerChildren.push(makeEl("span", { class: CLS.name }, [makeText(providerName)]));
    }
    if (opts.nameInAltOnly) {
      headerChildren.push(makeEl("img", { alt: providerName }, []));
    }
    children.push(makeEl("div", { class: CLS.header }, headerChildren));
    if (opts.free) children.push(makeEl("div", { class: "index-module__providerCardStatus__x" }, [makeText("FREE")]));
    children.push(makeEl("div", { class: CLS.content }, [makeText("base URL …")]));
    children.push(makeEl("div", { class: CLS.actions }, [makeEl("button", {}, [makeText("Configure")])]));
    const card = makeEl("div", { class: CLS.card }, children);
    card._providerName = providerName;
    return card;
  }
  const cardOpenAI = realProviderCard("OpenAI");
  const cardSiliconFlow = realProviderCard("SiliconFlow", { free: true });
  const cardModelScope = realProviderCard("ModelScope");
  const cardAliyun = realProviderCard("Aliyun");
  const cardDashScope = realProviderCard("DashScope");
  const cardAlibabaAria = realProviderCard("Alibaba Cloud", { nameInAriaOnly: true });
  const cardSiliconFlowAlt = realProviderCard("SiliconFlow", { nameInAltOnly: true });
  const cardDeepSeek = realProviderCard("DeepSeek");
  const cardAnthropic = realProviderCard("Anthropic");
  const providerList = makeEl("div", { class: CLS.list }, [
    cardOpenAI, cardSiliconFlow, cardModelScope, cardAliyun, cardDashScope,
    cardAlibabaAria, cardSiliconFlowAlt, cardDeepSeek, cardAnthropic,
  ]);
  // Real channel-card DOM (from the live bundle): a configured channel card
  // is a motion wrapper > div[role=button, aria-label=name,
  // class=channelCard] > top / middle(cardTitle=name) / bottom(Configure);
  // an available channel is a button.availableItem > icon +
  // span.availableItemName + Configure. The grid is div.availableGrid.
  // The icon is the live channel-icon component: <img alt={channelKey}>,
  // so the alt is the LOWERCASE channel id ("xiaoyi", "yuanbao", ...) while
  // the name span carries the display name ("XiaoYi", "Yuanbao"). The
  // nameInAltOnly variant (no name span) exercises the img-alt match path
  // alone — it is a real element of the real card, isolated here so the
  // case-insensitive attribute match is proven to do work on its own
  // (with only the label-spelling fix, alt "xiaoyi" still would not match
  // label "XiaoYi" under a case-sensitive comparison).
  const CH = {
    grid: "index-module__availableGrid__UBOlC",
    card: "index-module__channelCard__a6OxB",
    title: "index-module__cardTitle__x1",
    item: "index-module__availableItem__CoyUX",
    itemName: "index-module__availableItemName__OJ3-I",
  };
  function realChannelCard(name) {
    const title = makeEl("div", { class: CH.title }, [makeText(name)]);
    const middle = makeEl("div", { class: "index-module__cardMiddleSection__x2" }, [title]);
    const top = makeEl("div", { class: "index-module__cardTopSection__uQ2Up" }, [makeEl("div", { class: "index-module__channelIcon__rXEaM" }, [])]);
    const bottom = makeEl("div", { class: "index-module__cardBottomSection__x4" }, [makeEl("span", { class: "index-module__configureAction__x6" }, [makeText("Configure")])]);
    const card = makeEl("div", { role: "button", tabindex: "0", "aria-label": name, class: CH.card }, [top, middle, bottom]);
    const wrapper = makeEl("div", { class: "index-module__channelSurface__x7" }, [card]);
    wrapper._name = name; card._name = name;
    return wrapper;
  }
  function realAvailableItem(name, opts = {}) {
    const children = [
      makeEl("span", { class: "index-module__availableItemIcon__x" }, [
        makeEl("img", { alt: name.toLowerCase() }, []),
      ]),
    ];
    if (!opts.nameInAltOnly) {
      children.push(makeEl("span", { class: CH.itemName }, [makeText(name)]));
    }
    children.push(makeEl("span", { class: "index-module__availableItemAction__Et-aH" }, [makeText("Configure")]));
    const btn = makeEl("button", { type: "button", class: CH.item }, children);
    btn._name = name;
    return btn;
  }
  const chanWeCom = realChannelCard("WeCom");
  const chanTelegram = realChannelCard("Telegram");
  const chanDingTalk = realChannelCard("DingTalk");
  const itemFeishu = realAvailableItem("Feishu");
  const itemSlack = realAvailableItem("Slack");
  const itemQQ = realAvailableItem("QQ");
  const itemWeChat = realAvailableItem("WeChat");
  const itemXiaoYi = realAvailableItem("XiaoYi");
  const chanXiaoYi = realChannelCard("XiaoYi");
  const itemYuanbao = realAvailableItem("Yuanbao");
  const chanYuanbao = realChannelCard("Yuanbao");
  const itemXiaoYiAltOnly = realAvailableItem("XiaoYi", { nameInAltOnly: true });
  const itemIMessage = realAvailableItem("iMessage");
  const channelGrid = makeEl("div", { class: CH.grid }, [
    chanWeCom, chanTelegram, chanDingTalk, itemFeishu, itemSlack, itemQQ, itemWeChat,
    itemXiaoYi, chanXiaoYi, itemYuanbao, chanYuanbao, itemXiaoYiAltOnly, itemIMessage,
  ]);
  // Async mount: this list is empty on the first pass (the API has not
  // returned yet); the cards mount afterwards and the observer's re-run
  // must hide the China ones.
  const asyncList = makeEl("div", { class: CLS.list }, []);
  const upstreamLink = makeEl("a", { href: "https://qwenpaw.agentscope.io/docs/intro?lang=en" }, [makeText("View guide")]);
  const normalLink = makeEl("a", { href: "/status" }, [makeText("Status")]);
  // Community-style case (2026-11-19 QA round 20): a QwenPaw warning
  // sharing a plain container with a load-bearing sibling — the old
  // parent check skipped the whole container. The code snippet inside
  // the same container stays load-bearing and is left alone.
  const communityWarn = makeText("Remote connection requires HTTPS and an authenticated QwenPaw owner session.");
  const communityCode = makeEl("code", {}, [makeText("Set QWENPAW_AUTH_ENABLED=true")]);
  const communityBtn = makeEl("button", {}, [makeText("Connect QwenPaw…")]);
  const communitySection = makeEl("div", { class: "community-section" }, [communityWarn, communityCode, communityBtn]);
  // "AgentScope Platform" is the upstream provider card name on the
  // Models page — a display name, never load-bearing.
  const agentScopeDiv = makeEl("div", { class: "provider-name" }, [makeText("AgentScope Platform")]);
  // Truncated / bare AgentScope names (2026-11-19 DOM inspection): the
  // Models card renders "AgentScope Plat…" in the DOM, never the full
  // phrase — the full-phrase rename alone never matches it.
  const agentScopeTruncDiv = makeEl("div", { class: "provider-name" }, [makeText("AgentScope Plat…")]);
  const agentScopeBareDiv = makeEl("div", { class: "provider-name" }, [makeText("AgentScope")]);
  // Thinking controls (2026-11-19 QA round 20): the console's own
  // "Thinking intensity" button and our injected per-chat selector.
  // The native one must be hidden; ours must survive.
  const nativeThinkingBtn = makeEl("button", { "aria-label": "Thinking intensity" }, [makeText("Thinking intensity")]);
  // Native composer control (2026-11-19 DOM inspection): a <select>
  // labelled EXACTLY like ours ("Thinking level for this chat", same
  // default title) — only data-agentx-thinking tells them apart.
  const nativeThinkingSel = makeEl("select", { "aria-label": "Thinking level for this chat", title: "Thinking level for this chat — Default follows the model, Off disables thinking" }, []);
  const injectedThinkingSel = makeEl("select", { "data-agentx-thinking": "1", "aria-label": "Thinking level for this chat", title: "Thinking level for this chat — Default follows the model, Off disables thinking" }, []);
  const root = makeEl("div", { id: "root" }, [
    menu, header, settingsMenu, aboutLi, brandDiv, greeting, loadBearing, ariaBtn,
    providerList, channelGrid, asyncList, upstreamLink, normalLink,
    communitySection, agentScopeDiv, agentScopeTruncDiv, agentScopeBareDiv,
    nativeThinkingBtn, nativeThinkingSel, injectedThinkingSel,
  ]);
  const doc = makeDocument(root);
  const opened = [];
  const sandbox = {
    document: doc,
    location: { search: "" },
    window: { open: (url) => { opened.push(url); return { closed: false }; } },
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: MockMutationObserver,
    setTimeout: (fn) => 0,
    clearTimeout: () => {},
    Date,
    console,
    AGENTX_REBRAND_ENABLED: true,
    AGENTX_UPSTREAM_DOC: DOC_ORIGIN,
    AGENTX_UPSTREAM_GITHUB: GITHUB_URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(rebrandSrc, sandbox);
  vm.runInContext("agentxRunRules()", sandbox);

  check("the document title is renamed to AgentX",
    doc.title === "AgentX Console", `got ${doc.title}`);
  const tutorialLi = menu.children[0];
  check("a 'Tutorial' menu item is hidden",
    tutorialLi.style.display === "none", `display=${tutorialLi.style.display}`);
  const githubLi = menu.children[1];
  check("a 'GitHub' menu item is hidden",
    githubLi.style.display === "none", `display=${githubLi.style.display}`);
  check("an icon-only 'GitHub' header button (accessible name only) is hidden as a whole button",
    githubIconBtn.style.display === "none", `display=${githubIconBtn.style.display}`);
  check("an icon-only 'Documentation' header button (accessible name only) is hidden as a whole button",
    docsIconBtn.style.display === "none", `display=${docsIconBtn.style.display}`);
  check("an icon-only 'Documentation' Settings-menu button is hidden as a whole button",
    settingsDocsBtn.style.display === "none", `display=${settingsDocsBtn.style.display}`);
  const settingsLi = menu.children[2];
  check("a 'Settings' menu item is NOT hidden",
    settingsLi.style.display !== "none", `display=${settingsLi.style.display}`);
  check("a visible 'QwenPaw' text node is renamed to AgentX",
    greeting.textContent === "Hello! I'm AgentX. How can I help you?",
    `got ${greeting.textContent}`);
  check("a QwenPaw warning sharing a plain container with a load-bearing sibling is renamed (Community page)",
    communitySection.textContent.indexOf("authenticated AgentX owner session") !== -1,
    `got ${communitySection.textContent}`);
  check("the 'Connect QwenPaw…' button in that container is renamed too",
    communityBtn.textContent === "Connect AgentX…",
    `got ${communityBtn.textContent}`);
  check("a load-bearing code snippet in the same container is left alone",
    communityCode.textContent === "Set QWENPAW_AUTH_ENABLED=true",
    `got ${communityCode.textContent}`);
  check("'AgentScope Platform' is renamed to 'AgentX Platform'",
    agentScopeDiv.textContent === "AgentX Platform",
    `got ${agentScopeDiv.textContent}`);
  check("a truncated 'AgentScope Plat…' name is renamed to 'AgentX Plat…'",
    agentScopeTruncDiv.textContent === "AgentX Plat…",
    `got ${agentScopeTruncDiv.textContent}`);
  check("a bare 'AgentScope' name is renamed to 'AgentX'",
    agentScopeBareDiv.textContent === "AgentX",
    `got ${agentScopeBareDiv.textContent}`);
  check("the console's own 'Thinking intensity' control is hidden when our selector exists",
    nativeThinkingBtn.style.display === "none", `display=${nativeThinkingBtn.style.display}`);
  check("the console's native thinking SELECT (same label as ours) is hidden when our selector exists",
    nativeThinkingSel.style.display === "none", `display=${nativeThinkingSel.style.display}`);
  check("our injected thinking selector is NOT hidden by the hide-native rule",
    injectedThinkingSel.style.display !== "none", `display=${injectedThinkingSel.style.display}`);
  check("a load-bearing instruction is left alone (truthful, not renamed)",
    loadBearing.textContent === "Set QWENPAW_AUTH_ENABLED=true to use the QwenPaw terminal.",
    `got ${loadBearing.textContent}`);
  check("an aria-label with QwenPaw is renamed",
    ariaBtn.getAttribute("aria-label") === "AgentX menu",
    `got ${ariaBtn.getAttribute("aria-label")}`);
  check("a DashScope provider card (real DOM) is hidden as a whole card",
    cardDashScope.style.display === "none", `display=${cardDashScope.style.display}`);
  check("a SiliconFlow provider card (real DOM) is hidden as a whole card",
    cardSiliconFlow.style.display === "none", `display=${cardSiliconFlow.style.display}`);
  check("a ModelScope provider card (real DOM) is hidden as a whole card",
    cardModelScope.style.display === "none", `display=${cardModelScope.style.display}`);
  check("an Aliyun provider card (real DOM) is hidden as a whole card",
    cardAliyun.style.display === "none", `display=${cardAliyun.style.display}`);
  check("an Alibaba Cloud card matched only by its settings-button aria-label (real DOM) is hidden as a whole card",
    cardAlibabaAria.style.display === "none", `display=${cardAlibabaAria.style.display}`);
  check("a SiliconFlow card matched only by its icon img alt (real DOM) is hidden as a whole card",
    cardSiliconFlowAlt.style.display === "none", `display=${cardSiliconFlowAlt.style.display}`);
  check("a non-China provider card (OpenAI, real DOM) is NOT hidden",
    cardOpenAI.style.display !== "none", `display=${cardOpenAI.style.display}`);
  check("a non-China provider card (DeepSeek, real DOM) is NOT hidden",
    cardDeepSeek.style.display !== "none", `display=${cardDeepSeek.style.display}`);
  check("a non-China provider card (Anthropic, real DOM) is NOT hidden",
    cardAnthropic.style.display !== "none", `display=${cardAnthropic.style.display}`);
  check("the provider list container is NOT hidden (no over-hide)",
    providerList.style.display !== "none", `display=${providerList.style.display}`);
  check("a WeCom configured channel card (real DOM) is hidden as a whole card",
    chanWeCom.style.display === "none", `display=${chanWeCom.style.display}`);
  check("a DingTalk configured channel card (real DOM) is hidden as a whole card",
    chanDingTalk.style.display === "none", `display=${chanDingTalk.style.display}`);
  check("a Feishu available-channel button (real DOM) is hidden as a whole button",
    itemFeishu.style.display === "none", `display=${itemFeishu.style.display}`);
  check("a QQ available-channel button (real DOM) is hidden as a whole button",
    itemQQ.style.display === "none", `display=${itemQQ.style.display}`);
  check("a WeChat available-channel button (real DOM) is hidden as a whole button",
    itemWeChat.style.display === "none", `display=${itemWeChat.style.display}`);
  check("a XiaoYi available-channel button (real DOM) is hidden as a whole button",
    itemXiaoYi.style.display === "none", `display=${itemXiaoYi.style.display}`);
  check("a XiaoYi configured channel card (real DOM) is hidden as a whole card",
    chanXiaoYi.style.display === "none", `display=${chanXiaoYi.style.display}`);
  check("a Yuanbao available-channel button (real DOM) is hidden as a whole button",
    itemYuanbao.style.display === "none", `display=${itemYuanbao.style.display}`);
  check("a Yuanbao configured channel card (real DOM) is hidden as a whole card",
    chanYuanbao.style.display === "none", `display=${chanYuanbao.style.display}`);
  check("a XiaoYi channel matched only by its icon img alt (lowercase id 'xiaoyi', real DOM) is hidden as a whole button",
    itemXiaoYiAltOnly.style.display === "none", `display=${itemXiaoYiAltOnly.style.display}`);
  check("a non-China channel (iMessage available, real DOM) is NOT hidden",
    itemIMessage.style.display !== "none", `display=${itemIMessage.style.display}`);
  check("a non-China channel (Telegram configured, real DOM) is NOT hidden",
    chanTelegram.style.display !== "none", `display=${chanTelegram.style.display}`);
  check("a non-China channel (Slack available, real DOM) is NOT hidden",
    itemSlack.style.display !== "none", `display=${itemSlack.style.display}`);
  check("the channel grid is NOT hidden",
    channelGrid.style.display !== "none", `display=${channelGrid.style.display}`);
  // Async mount: the list was empty on the first pass; the cards mount
  // afterwards (the API fetch resolves) and the observer's re-run must
  // hide the China ones. This is the live failure mode: the list
  // renders asynchronously, so a rule that only runs once never sees it.
  // agentxRunRules throttles re-runs to 400 ms (with a trailing timer in
  // the real browser), so wait out the window before the re-run — the
  // sandbox's setTimeout is a stub that never fires, which is exactly
  // why the wait has to be real time here.
  const asyncChina = realProviderCard("ModelScope");
  const asyncOk = realProviderCard("OpenAI");
  asyncList.appendChild(asyncChina);
  asyncList.appendChild(asyncOk);
  await new Promise((r) => setTimeout(r, 450));
  vm.runInContext("agentxRunRules()", sandbox);
  check("China cards are hidden when the provider list mounts after the initial pass (async mount)",
    asyncChina.style.display === "none" && asyncOk.style.display !== "none" &&
    asyncList.style.display !== "none",
    `china=${asyncChina.style.display} openai=${asyncOk.style.display} list=${asyncList.style.display}`);
  check("the About item is renamed to AgentX (version kept)",
    aboutLi.textContent === "About AgentX v2.3.0", `got ${aboutLi.textContent}`);
  // The About listener is delegated on document (capture): dispatch the
  // click on the document with the inner span as the target, as a real
  // browser would.
  doc.dispatch("click", {
    target: aboutSpan,
    preventDefault() {},
    stopPropagation() {},
  });
  check("clicking About opens our /status page, not the upstream site",
    opened.includes("/status") && !opened.some((u) => u.includes("qwenpaw.agentscope.io")),
    `opened ${opened.join(", ")}`);
  check("the sidebar logo img is replaced by an 'AgentX' text label",
    logoImg.parentNode === null && brandDiv.textContent === "AgentX v2.3.0",
    `parentNode=${logoImg.parentNode ? "still attached" : "null"}, brand=${brandDiv.textContent}`);
  check("the logo img alt is renamed to AgentX",
    logoImg.getAttribute("alt") === "AgentX", `got ${logoImg.getAttribute("alt")}`);
  // The title observer is installed by agentxWatchTitle() (called at load
  // in the real page, outside the extracted markers). Fire its callback
  // directly: a title change must be renamed immediately, not on the next
  // body mutation. On the unfixed file the function does not exist, so
  // record both checks as failures instead of crashing (fail-first path).
  MockMutationObserver.instances = [];
  let titleWatcherRan = false;
  try {
    // The title-observer rule may already have installed the watcher
    // during the full pass above; reset the flag so this direct call
    // proves the installer itself registers an observer.
    vm.runInContext("agentxTitleWatcherInstalled = false;", sandbox);
    vm.runInContext("agentxWatchTitle()", sandbox);
    titleWatcherRan = true;
  } catch (e) { /* agentxWatchTitle not defined in the unfixed file */ }
  check("a title observer is registered on the <title> element",
    titleWatcherRan && MockMutationObserver.instances.length === 1 &&
    MockMutationObserver.instances[0].target === doc._titleEl,
    titleWatcherRan ? `instances=${MockMutationObserver.instances.length}` : "agentxWatchTitle not defined");
  if (titleWatcherRan) {
    doc.title = "Settings · QwenPaw";
    MockMutationObserver.instances[0].cb();
  }
  check("a title change is renamed immediately by the title observer",
    titleWatcherRan && doc.title === "Settings · AgentX", `got ${doc.title}`);
  let blocked = null;
  let normalBlocked = null;
  doc.dispatch("click", {
    target: upstreamLink,
    preventDefault() { blocked = true; },
    stopPropagation() {},
  });
  doc.dispatch("click", {
    target: normalLink,
    preventDefault() { normalBlocked = true; },
    stopPropagation() {},
  });
  check("a click on an upstream docs link is blocked",
    blocked === true, `blocked=${blocked}`);
  check("a click on a same-origin link is NOT blocked",
    normalBlocked === null, `blocked=${normalBlocked}`);
}

console.log("dynamic: Part 3 rebrand gaps, one rule at a time (isolated runs)");
if (!rebrandSrc) {
  for (const name of [
    "Part 3 rules (rebrand section missing)",
  ]) check(name, false, "AGENTX-REBRAND markers not found in _worker.js");
} else {
  // Run ONE rule in isolation on a small DOM, so a pass proves that
  // rule (and not rename-text or another rule) did the work. The
  // negative checks (non-target left alone) only mean something in
  // isolation: in a full pass rename-text would rename the same text.
  const runRuleNowSrc = extractFunction(worker, "agentxRunRuleNow");
  function runOneRule(rootEl, ruleId, opts = {}) {
    const doc = makeDocument(rootEl, opts.head || []);
    // Theme inputs for the settings-white-area rule (2026-11-19,
    // round 2): the rule reads the console's own --app-bg variable
    // from <html> (light #f9f8f4, dark #141414) and detects dark mode
    // from the "dark-mode" class on <html>. A test sets them with
    // opts.cssVars / opts.htmlClass before the rule runs.
    if (opts.cssVars) doc.documentElement._cssVars = opts.cssVars;
    if (opts.htmlClass) doc.documentElement.setAttribute("class", opts.htmlClass);
    // Viewport + strip probe (2026-11-19, round 3): the rule reads
    // window.innerHeight for the probe and document.elementFromPoint
    // for the strip element. A test sets them with opts.innerHeight /
    // opts.elementFromPoint; unset = 0 / null (no probe).
    if (opts.elementFromPoint) doc._elementFromPointFn = opts.elementFromPoint;
    const opened = [];
    const localStore = {};
    const sandbox = {
      document: doc,
      location: { search: opts.search || "", pathname: opts.pathname || "" },
      window: {
        open: (url) => { opened.push(url); return { closed: false }; },
        location: { pathname: opts.pathname || "", search: opts.search || "" },
        innerHeight: (opts.innerHeight !== undefined ? opts.innerHeight : 0),
        // getComputedStyle (2026-11-19, settings-fill): the mock has no
        // CSS engine, so a mock element carries its computed background
        // in `_computedBg` (unset = transparent, as in a real browser
        // for an element with no background of its own). The rule reads
        // window.getComputedStyle, the same call the pill-positions
        // rule already uses for the panel's computed display.
        // getPropertyValue (2026-11-19, round 2): the rule reads the
        // console's --app-bg theme variable from <html>; a mock
        // element carries its variables in `_cssVars` (unset = "").
        getComputedStyle: (el) => ({
          backgroundColor: (el && el._computedBg) || "rgba(0, 0, 0, 0)",
          getPropertyValue: (name) => (el && el._cssVars && el._cssVars[name]) || "",
        }),
        localStorage: {
          getItem: (k) => (k in localStore ? localStore[k] : null),
          setItem: (k, v) => { localStore[k] = String(v); },
          removeItem: (k) => { delete localStore[k]; },
        },
      },
      NodeFilter: { SHOW_TEXT: 4 },
      MutationObserver: MockMutationObserver,
      setTimeout: (fn) => 0,
      clearTimeout: () => {},
      fetch: async () => ({ ok: false, status: 404, json: async () => null }),
      Date,
      console,
      AGENTX_REBRAND_ENABLED: true,
      AGENTX_UPSTREAM_DOC: DOC_ORIGIN,
      AGENTX_UPSTREAM_GITHUB: GITHUB_URL,
    };
    vm.createContext(sandbox);
    vm.runInContext(rebrandSrc, sandbox);
    if (runRuleNowSrc) vm.runInContext(runRuleNowSrc, sandbox);
    MockMutationObserver.instances = [];
    vm.runInContext(`agentxRunRuleNow("${ruleId}")`, sandbox);
    return { doc, sandbox, opened };
  }
  function clickBlocked(doc, target) {
    let blocked = false;
    doc.dispatch("click", {
      target,
      preventDefault() { blocked = true; },
      stopPropagation() {},
    });
    return blocked;
  }

  { // footer-rebrand
    const foot = makeEl("footer", {}, [makeText("Made with QwenPaw")]);
    const chat = makeEl("p", {}, [makeText("QwenPaw chat")]);
    runOneRule(makeEl("div", {}, [foot, chat]), "footer-rebrand");
    check("footer-rebrand renames QwenPaw in the page footer",
      foot.textContent === "Made with AgentX", `got ${foot.textContent}`);
    check("footer-rebrand leaves QwenPaw outside the footer alone",
      chat.textContent === "QwenPaw chat", `got ${chat.textContent}`);
  }

  { // block-links-v2
    const lQwenpawCom = makeEl("a", { href: "https://qwenpaw.com/pricing" }, [makeText("Pricing")]);
    const lChatQwen = makeEl("a", { href: "https://chat.qwen.ai/" }, [makeText("Chat")]);
    const lDataUrl = makeEl("a", { href: "https://example.com/x", "data-url": "https://discord.gg/qwenpaw" }, [makeText("Discord")]);
    const lDataHref = makeEl("a", { href: "https://example.com/y", "data-href": "https://dashscope.aliyuncs.com/api" }, [makeText("API")]);
    const form = makeEl("form", { action: "https://alibabacloud.com/console" }, [makeEl("button", {}, [makeText("Go")])]);
    const lPages = makeEl("a", { href: "https://qwenpawx.pages.dev/chat" }, [makeText("Console")]);
    const lStatus = makeEl("a", { href: "/status" }, [makeText("Status")]);
    const lRepo = makeEl("a", { href: "https://github.com/Ratulbaba7/qwenpaw-deploy" }, [makeText("Repo")]);
    const { doc } = runOneRule(makeEl("div", {}, [lQwenpawCom, lChatQwen, lDataUrl, lDataHref, form, lPages, lStatus, lRepo]), "block-links-v2");
    check("block-links-v2 blocks a click to qwenpaw.com",
      clickBlocked(doc, lQwenpawCom) === true);
    check("block-links-v2 blocks a click to chat.qwen.ai",
      clickBlocked(doc, lChatQwen) === true);
    check("block-links-v2 blocks a click whose data-url points upstream (discord.gg)",
      clickBlocked(doc, lDataUrl) === true);
    check("block-links-v2 blocks a click whose data-href points upstream (dashscope)",
      clickBlocked(doc, lDataHref) === true);
    check("block-links-v2 blocks a click on a form whose action points upstream",
      clickBlocked(doc, form) === true);
    check("block-links-v2 does NOT block the console's own pages.dev origin",
      clickBlocked(doc, lPages) === false);
    check("block-links-v2 does NOT block a same-origin link",
      clickBlocked(doc, lStatus) === false);
    check("block-links-v2 does NOT block the deploy repo (github.com/Ratulbaba7, not QwenLM)",
      clickBlocked(doc, lRepo) === false);
  }

  { // hide-powered-by
    const badge = makeEl("div", { class: "powered-by-card" }, [makeEl("span", {}, [makeText("Powered by QwenPaw")])]);
    const badgeAx = makeEl("div", { class: "powered-by-card" }, [makeEl("span", {}, [makeText("Powered by AgentX")])]);
    const plain = makeEl("span", {}, [makeText("QwenPaw v2.3.0")]);
    runOneRule(makeEl("div", {}, [badge, badgeAx, plain]), "hide-powered-by");
    check("hide-powered-by hides the 'Powered by QwenPaw' badge",
      badge.style.display === "none", `display=${badge.style.display}`);
    check("hide-powered-by hides the badge after rename-text already made it 'Powered by AgentX'",
      badgeAx.style.display === "none", `display=${badgeAx.style.display}`);
    check("hide-powered-by leaves a plain version string alone",
      plain.style.display !== "none", `display=${plain.style.display}`);
  }

  { // hide-feedback
    const fb = makeEl("button", {}, [makeText("Send feedback")]);
    const st = makeEl("button", {}, [makeText("Settings")]);
    runOneRule(makeEl("div", {}, [fb, st]), "hide-feedback");
    check("hide-feedback hides the 'Send feedback' button",
      fb.style.display === "none", `display=${fb.style.display}`);
    check("hide-feedback leaves a 'Settings' button alone",
      st.style.display !== "none", `display=${st.style.display}`);
  }

  { // settings-about
    const settingsRow = makeEl("li", {}, [makeText("About QwenPaw v2.3.0")]);
    const settingsDiv = makeEl("div", { class: "settings-page" }, [makeEl("h2", {}, [makeText("Settings")]), settingsRow]);
    const menuRow = makeEl("li", {}, [makeText("About QwenPaw v2.3.0")]);
    const menuDiv = makeEl("div", { class: "menu" }, [menuRow]);
    runOneRule(makeEl("div", {}, [settingsDiv, menuDiv]), "settings-about", { pathname: "/chat/abc" });
    check("settings-about renames the About row inside Settings",
      settingsRow.textContent === "About AgentX v2.3.0", `got ${settingsRow.textContent}`);
    check("settings-about leaves the same row outside Settings alone (scoped rule)",
      menuRow.textContent === "About QwenPaw v2.3.0", `got ${menuRow.textContent}`);
  }

  { // settings-language
    const row = makeEl("li", { class: "settings-row" }, [makeEl("span", {}, [makeText("Language")]), makeEl("span", {}, [makeText("English")])]);
    const para = makeEl("p", {}, [makeText("Language: English")]);
    runOneRule(makeEl("div", {}, [row, para]), "settings-language");
    check("settings-language hides the Settings row labelled exactly 'Language'",
      row.style.display === "none", `display=${row.style.display}`);
    check("settings-language leaves a 'Language: English' paragraph alone",
      para.style.display !== "none", `display=${para.style.display}`);
  }

  { // settings-providers
    const label = makeEl("span", {}, [makeText("QwenPaw provider settings")]);
    const models = makeEl("div", { class: "models-section" }, [label]);
    const chat = makeEl("p", {}, [makeText("QwenPaw is great")]);
    runOneRule(makeEl("div", {}, [models, chat]), "settings-providers", { pathname: "/chat/abc" });
    check("settings-providers renames QwenPaw labels in Settings > Models",
      label.textContent === "AgentX provider settings", `got ${label.textContent}`);
    check("settings-providers leaves chat text alone (scoped rule)",
      chat.textContent === "QwenPaw is great", `got ${chat.textContent}`);
  }

  { // settings-integrations
    const label = makeEl("span", {}, [makeText("Connect QwenPaw to Slack")]);
    const list = makeEl("div", { class: "integrations-list" }, [label]);
    runOneRule(makeEl("div", {}, [list]), "settings-integrations", { pathname: "/chat/abc" });
    check("settings-integrations renames QwenPaw mentions in Settings > Integrations",
      label.textContent === "Connect AgentX to Slack", `got ${label.textContent}`);
  }

  { // hide-upgrade
    const btn = makeEl("button", {}, [makeText("Upgrade to Pro")]);
    const card = makeEl("div", { class: "upsell-card" }, [makeEl("p", {}, [makeText("Upgrade to Pro today")])]);
    const row = makeEl("li", {}, [makeText("Settings")]);
    runOneRule(makeEl("div", {}, [btn, card, row]), "hide-upgrade");
    check("hide-upgrade hides the 'Upgrade to Pro' button",
      btn.style.display === "none", `display=${btn.style.display}`);
    check("hide-upgrade hides the upsell card",
      card.style.display === "none", `display=${card.style.display}`);
    check("hide-upgrade leaves a 'Settings' row alone",
      row.style.display !== "none", `display=${row.style.display}`);
  }

  { // account-card
    const user = makeEl("span", {}, [makeText("satwik")]);
    const acc = makeEl("span", {}, [makeText("QwenPaw account")]);
    const card = makeEl("div", { class: "user-card" }, [user, acc, makeEl("span", {}, [makeText("Console account")])]);
    runOneRule(makeEl("div", {}, [card]), "account-card");
    check("account-card renames QwenPaw in the account card",
      acc.textContent === "AgentX account", `got ${acc.textContent}`);
    check("account-card does NOT touch the satwik username",
      user.textContent === "satwik", `got ${user.textContent}`);
  }

  { // workspace-switcher
    const label = makeEl("button", {}, [makeText("QwenPaw workspace")]);
    const sw = makeEl("div", { class: "workspace-switcher" }, [label]);
    runOneRule(makeEl("div", {}, [sw]), "workspace-switcher");
    check("workspace-switcher renames QwenPaw in the workspace switcher",
      label.textContent === "AgentX workspace", `got ${label.textContent}`);
  }

  { // sidebar-help
    const nav = makeEl("nav", {}, []);
    const upLink = makeEl("a", { href: "https://qwenpaw.agentscope.io/docs" }, [makeText("Help")]);
    const okLink = makeEl("a", { href: "/settings" }, [makeText("Help")]);
    nav.appendChild(upLink);
    nav.appendChild(okLink);
    const outside = makeEl("a", { href: "https://chat.qwen.ai/" }, [makeText("Help")]);
    const plain = makeEl("div", {}, [outside]);
    runOneRule(makeEl("div", {}, [nav, plain]), "sidebar-help");
    check("sidebar-help hides the sidebar Help link that points upstream",
      upLink.style.display === "none", `display=${upLink.style.display}`);
    check("sidebar-help leaves a same-origin sidebar Help link alone",
      okLink.style.display !== "none", `display=${okLink.style.display}`);
    check("sidebar-help leaves an upstream link outside the sidebar alone (block-links owns clicks)",
      outside.style.display !== "none", `display=${outside.style.display}`);
  }

  { // model-labels
    const pickerLabel = makeEl("span", {}, [makeText("deepseek-v4.1-flash-free")]);
    const picker = makeEl("div", { "aria-label": "Model picker" }, [pickerLabel]);
    const opt = makeEl("option", { value: "deepseek-v4.1-flash-free" }, [makeText("deepseek-v4.1-flash-free")]);
    const sel = makeEl("select", { "aria-label": "Model" }, [opt]);
    const nexLabel = makeEl("span", {}, [makeText("nex-n2.6")]);
    const picker2 = makeEl("div", { "aria-label": "Model" }, [nexLabel]);
    const other = makeEl("p", {}, [makeText("nex-n2.6 is fast")]);
    const unknown = makeEl("span", {}, [makeText("gpt-5")]);
    const picker3 = makeEl("div", { "aria-label": "Model" }, [unknown]);
    runOneRule(makeEl("div", {}, [picker, sel, picker2, other, picker3]), "model-labels");
    check("model-labels renames the picker display 'deepseek-v4.1-flash-free' to AgentX-1-Mini",
      pickerLabel.textContent === "AgentX-1-Mini", `got ${pickerLabel.textContent}`);
    check("model-labels renames the option display text but NOT the option value",
      opt.textContent === "AgentX-1-Mini" && opt.getAttribute("value") === "deepseek-v4.1-flash-free",
      `text=${opt.textContent} value=${opt.getAttribute("value")}`);
    check("model-labels renames the picker display 'nex-n2.6' to AgentX-1",
      nexLabel.textContent === "AgentX-1", `got ${nexLabel.textContent}`);
    check("model-labels leaves the same model id outside the picker alone",
      other.textContent === "nex-n2.6 is fast", `got ${other.textContent}`);
    check("model-labels leaves an unmapped model label alone",
      unknown.textContent === "gpt-5", `got ${unknown.textContent}`);
  }

  { // title-observer
    const { doc } = runOneRule(makeEl("div", {}, []), "title-observer");
    check("title-observer installs a watcher on the <title> element",
      MockMutationObserver.instances.length === 1 &&
      MockMutationObserver.instances[0].target === doc._titleEl,
      `instances=${MockMutationObserver.instances.length}`);
    doc.title = "Settings · QwenPaw";
    if (MockMutationObserver.instances[0]) MockMutationObserver.instances[0].cb();
    check("title-observer renames the title immediately (rule run, not only on mutation)",
      doc.title === "Settings · AgentX", `got ${doc.title}`);
  }

  { // head-rebrand
    const head = [
      makeEl("meta", { property: "og:title", content: "QwenPaw Console" }, []),
      makeEl("meta", { property: "twitter:description", content: "Chat with QwenPaw" }, []),
      makeEl("meta", { property: "og:description", content: "Plain text" }, []),
      makeEl("meta", { name: "application-name", content: "QwenPaw" }, []),
      makeEl("link", { rel: "icon", href: "https://example.com/favicon.ico" }, []),
      makeEl("link", { rel: "stylesheet", href: "https://example.com/app.css" }, []),
    ];
    runOneRule(makeEl("div", {}, []), "head-rebrand", { head });
    check("head-rebrand renames the og:title meta content",
      head[0].getAttribute("content") === "AgentX Console", `got ${head[0].getAttribute("content")}`);
    check("head-rebrand renames the twitter:description meta content",
      head[1].getAttribute("content") === "Chat with AgentX", `got ${head[1].getAttribute("content")}`);
    check("head-rebrand leaves a meta without QwenPaw alone",
      head[2].getAttribute("content") === "Plain text", `got ${head[2].getAttribute("content")}`);
    check("head-rebrand renames the inline application-name meta (manifest name proxy)",
      head[3].getAttribute("content") === "AgentX", `got ${head[3].getAttribute("content")}`);
    check("head-rebrand sets the favicon to an inline data-URI AX mark",
      (head[4].getAttribute("href") || "").indexOf("data:image/svg+xml,") === 0 &&
      (head[4].getAttribute("href") || "").indexOf("AX") !== -1,
      `got ${(head[4].getAttribute("href") || "").slice(0, 40)}`);
    check("head-rebrand leaves a stylesheet link alone",
      head[5].getAttribute("href") === "https://example.com/app.css", `got ${head[5].getAttribute("href")}`);
  }

  { // export-rebrand
    const share = makeEl("button", {}, [makeText("Share to community")]);
    const dlText = makeText("Download QwenPaw export");
    const dl = makeEl("a", { href: "/x/qwenpaw-export.json", download: "qwenpaw-export.json" }, [dlText]);
    const plain = makeEl("a", { href: "/x/other" }, [makeText("QwenPaw link")]);
    runOneRule(makeEl("div", {}, [share, dl, plain]), "export-rebrand");
    check("export-rebrand hides the 'Share to community' control",
      share.style.display === "none", `display=${share.style.display}`);
    check("export-rebrand rewrites the download link's DISPLAYED text only",
      dl.textContent === "Download AgentX export", `got ${dl.textContent}`);
    check("export-rebrand never touches the download href or filename",
      dl.getAttribute("href") === "/x/qwenpaw-export.json" &&
      dl.getAttribute("download") === "qwenpaw-export.json",
      `href=${dl.getAttribute("href")} download=${dl.getAttribute("download")}`);
    check("export-rebrand leaves a plain link's text alone (rename-text owns it in a full pass)",
      plain.textContent === "QwenPaw link", `got ${plain.textContent}`);
  }

  { // hide-run-in
    const run = makeEl("button", {}, [makeText("Run in QwenPaw")]);
    const tests = makeEl("button", {}, [makeText("Run tests")]);
    runOneRule(makeEl("div", {}, [run, tests]), "hide-run-in");
    check("hide-run-in hides the 'Run in QwenPaw' button",
      run.style.display === "none", `display=${run.style.display}`);
    check("hide-run-in leaves a 'Run tests' button alone",
      tests.style.display !== "none", `display=${tests.style.display}`);
  }

  { // auth-rebrand
    const h1 = makeEl("h1", {}, [makeText("Sign in to QwenPaw")]);
    const auth = makeEl("div", { class: "auth-page" }, [h1]);
    const chat = makeEl("p", {}, [makeText("QwenPaw chat")]);
    runOneRule(makeEl("div", {}, [auth, chat]), "auth-rebrand", { pathname: "/chat/abc" });
    check("auth-rebrand renames QwenPaw on the sign-in screen",
      h1.textContent === "Sign in to AgentX", `got ${h1.textContent}`);
    check("auth-rebrand leaves chat text alone (scoped rule)",
      chat.textContent === "QwenPaw chat", `got ${chat.textContent}`);
  }

  { // error-rebrand
    const err = makeEl("span", {}, [makeText("QwenPaw failed to load")]);
    const alert = makeEl("div", { role: "alert" }, [err]);
    const chat = makeEl("p", {}, [makeText("QwenPaw chat")]);
    runOneRule(makeEl("div", {}, [alert, chat]), "error-rebrand");
    check("error-rebrand renames QwenPaw in error / toast text",
      err.textContent === "AgentX failed to load", `got ${err.textContent}`);
    check("error-rebrand leaves normal text alone (scoped rule)",
      chat.textContent === "QwenPaw chat", `got ${chat.textContent}`);
  }

  { // hide-onboarding
    const card = makeEl("div", { class: "onboarding-card" }, [makeEl("h2", {}, [makeText("Welcome to QwenPaw")])]);
    const docs = makeEl("a", { href: "/docs/getting-started" }, [makeText("Getting started")]);
    runOneRule(makeEl("div", {}, [card, docs]), "hide-onboarding");
    check("hide-onboarding hides the first-run 'Welcome to QwenPaw' card",
      card.style.display === "none", `display=${card.style.display}`);
    check("hide-onboarding leaves a 'Getting started' docs link alone",
      docs.style.display !== "none", `display=${docs.style.display}`);
  }

  { // hide-update-banner
    const banner = makeEl("div", { class: "update-banner" }, [makeEl("span", {}, [makeText("Update available — QwenPaw v2.3.1")])]);
    const note = makeEl("p", {}, [makeText("Updated 5 minutes ago")]);
    runOneRule(makeEl("div", {}, [banner, note]), "hide-update-banner");
    check("hide-update-banner hides the 'Update available' banner",
      banner.style.display === "none", `display=${banner.style.display}`);
    check("hide-update-banner leaves an 'Updated 5 minutes ago' note alone",
      note.style.display !== "none", `display=${note.style.display}`);
  }

  { // hide-shortcuts-dialog
    const row = makeEl("li", {}, [makeText("Keyboard shortcuts")]);
    const btn = makeEl("button", {}, [makeText("Shortcuts")]);
    const keys = makeEl("span", {}, [makeText("Shortcut keys")]);
    runOneRule(makeEl("div", {}, [row, btn, keys]), "hide-shortcuts-dialog");
    check("hide-shortcuts-dialog hides the 'Keyboard shortcuts' row",
      row.style.display === "none", `display=${row.style.display}`);
    check("hide-shortcuts-dialog hides the 'Shortcuts' trigger",
      btn.style.display === "none", `display=${btn.style.display}`);
    check("hide-shortcuts-dialog leaves a 'Shortcut keys' label alone",
      keys.style.display !== "none", `display=${keys.style.display}`);
  }

  { // rename-attrs-v2 (merged into rename-attrs)
    const tip = makeEl("button", { "data-tooltip": "QwenPaw settings" }, [makeText("S")]);
    const altDiv = makeEl("div", { alt: "QwenPaw logo" }, []);
    const img = makeEl("img", { alt: "QwenPaw" }, []);
    runOneRule(makeEl("div", {}, [tip, altDiv, img]), "rename-attrs");
    check("rename-attrs renames a data-tooltip with QwenPaw",
      tip.getAttribute("data-tooltip") === "AgentX settings", `got ${tip.getAttribute("data-tooltip")}`);
    check("rename-attrs renames alt on a non-img element",
      altDiv.getAttribute("alt") === "AgentX logo", `got ${altDiv.getAttribute("alt")}`);
    check("rename-attrs leaves img alt alone (the logo rule owns img attributes)",
      img.getAttribute("alt") === "QwenPaw", `got ${img.getAttribute("alt")}`);
  }

  { // rename-logo-v2 (merged into rename-logo)
    const imgTitle = makeEl("img", { title: "QwenPaw logo" }, []);
    imgTitle.getBoundingClientRect = () => ({ width: 120, height: 40 });
    const brand1 = makeEl("div", { class: "sidebar-brand" }, [imgTitle]);
    runOneRule(makeEl("div", {}, [brand1]), "rename-logo");
    check("rename-logo swaps an img matched by title='QwenPaw ...' for the AgentX label",
      imgTitle.parentNode === null && brand1.textContent === "AgentX",
      `brand=${brand1.textContent}`);
    const imgAria = makeEl("img", { "aria-label": "QwenPaw" }, []);
    imgAria.getBoundingClientRect = () => ({ width: 120, height: 40 });
    const brand2 = makeEl("div", { class: "sidebar-brand" }, [imgAria]);
    runOneRule(makeEl("div", {}, [brand2]), "rename-logo");
    check("rename-logo swaps an img matched by aria-label='QwenPaw' for the AgentX label",
      imgAria.parentNode === null && brand2.textContent === "AgentX",
      `brand=${brand2.textContent}`);
  }

  { // thinking-text (merged into thinking-selector)
    const smartBtn = makeEl("button", {}, [makeText("Smart Mode")]);
    const thinkingNote = makeEl("span", {}, [makeText("QwenPaw thinking")]);
    const toolbar = makeEl("div", { class: "composer-toolbar" }, [smartBtn, thinkingNote]);
    const { doc } = runOneRule(makeEl("div", {}, [toolbar]), "thinking-selector", { pathname: "/chat/abc" });
    check("thinking-selector creates the Thinking select in the composer toolbar",
      toolbar.children.some((c) => c.getAttribute && c.getAttribute("data-agentx-thinking") === "1"),
      "no select with data-agentx-thinking found in the toolbar");
    check("thinking-selector renames QwenPaw text in its own toolbar (thinking-text merge)",
      thinkingNote.textContent === "AgentX thinking", `got ${thinkingNote.textContent}`);
  }

  { // toast-text (covered by rename-text: toasts live inside document.body)
    const toast = makeEl("div", { class: "toast" }, [makeText("QwenPaw error occurred")]);
    runOneRule(makeEl("div", {}, [toast]), "rename-text");
    check("rename-text renames QwenPaw text in an in-body toast container",
      toast.textContent === "AgentX error occurred", `got ${toast.textContent}`);
  }

  { // settings-white-area round 2 (2026-11-19: round 1 browser-
    // verified PARTIAL — cream ends ~894, ~104px white strip left
    // in light mode. Diagnosis from the served bundle: the shell is
    // a .page-content whose background is var(--app-surface), white
    // in light mode, so round 1 copied white onto <html>/<body> and
    // the strip survived; and the shell alone cannot beat the
    // .ant-layout max-height:100vh + overflow:hidden clip. Round 2
    // paints from the console's --app-bg theme variable and stretches
    // the shell + its ancestors. Light mode first, with the shell
    // WHITE (the round-1 bug scenario): the paint must be the theme
    // cream #f9f8f4 from the variable, never the shell's white.
    const shell = makeEl("main", {}, [makeEl("nav", { "aria-label": "Settings" }, [])]);
    shell._computedBg = "rgb(255, 255, 255)";
    const wrap = makeEl("div", { class: "ant-layout-content" }, [shell]);
    const root = makeEl("div", {}, [wrap]);
    const { doc, sandbox } = runOneRule(root, "settings-white-area", { pathname: "/settings/general", cssVars: { "--app-bg": "#f9f8f4" } });
    check("settings-white-area stretches the settings shell and its ancestors to the viewport height",
      shell.style.getPropertyValue("min-height") === "100dvh" && shell.style.boxSizing === "border-box" &&
      shell.getAttribute("data-agentx-settings-stretch") === "1" &&
      wrap.style.getPropertyValue("min-height") === "100dvh" &&
      wrap.getAttribute("data-agentx-settings-stretch") === "1",
      `shell minHeight=${shell.style.getPropertyValue("min-height")} wrap minHeight=${wrap.style.getPropertyValue("min-height")}`);
    check("settings-white-area paints html + body cream from --app-bg in light mode even when the shell itself is white",
      doc.documentElement.style.backgroundColor === "#f9f8f4" &&
      doc.body.style.backgroundColor === "#f9f8f4" &&
      doc.body.getAttribute("data-agentx-settings-bg") === "1",
      `html=${doc.documentElement.style.backgroundColor} body=${doc.body.style.backgroundColor} marker=${doc.body.getAttribute("data-agentx-settings-bg")}`);
    check("settings-white-area records no diagnostic probe (AX-DIAG removed in round 4)",
      sandbox.window.__agentxSettingsDiag === undefined &&
      doc.body.getAttribute("data-agentx-settings-diag") === null &&
      doc.getElementById("agentxSettingsDiag") === null,
      `diag=${JSON.stringify(sandbox.window.__agentxSettingsDiag)}`);
  }

  { // settings-white-area in dark mode: --app-bg is #141414, so the
    // fill must be dark — never cream, never the shell's white.
    const shell = makeEl("main", {}, [makeEl("nav", { "aria-label": "Settings" }, [])]);
    shell._computedBg = "rgb(255, 255, 255)";
    const root = makeEl("div", {}, [shell]);
    const { doc } = runOneRule(root, "settings-white-area", { pathname: "/settings/general", cssVars: { "--app-bg": "#141414" } });
    check("settings-white-area paints the dark surface, not cream, in dark mode",
      doc.documentElement.style.backgroundColor === "#141414" &&
      doc.body.style.backgroundColor === "#141414",
      `html=${doc.documentElement.style.backgroundColor} body=${doc.body.style.backgroundColor}`);
  }

  { // settings-white-area fallback, dark: when --app-bg is missing
    // (an older console build), the html.dark-mode class decides.
    const shell = makeEl("main", {}, [makeEl("nav", { "aria-label": "Settings" }, [])]);
    const root = makeEl("div", {}, [shell]);
    const { doc } = runOneRule(root, "settings-white-area", { pathname: "/settings/general", htmlClass: "dark-mode" });
    check("settings-white-area falls back to the dark surface when --app-bg is missing but html has dark-mode",
      doc.documentElement.style.backgroundColor === "#141414" &&
      doc.body.style.backgroundColor === "#141414",
      `html=${doc.documentElement.style.backgroundColor} body=${doc.body.style.backgroundColor}`);
  }

  { // settings-white-area fallback, light: no variable, no
    // dark-mode class — cream, never white.
    const shell = makeEl("main", {}, [makeEl("nav", { "aria-label": "Settings" }, [])]);
    shell._computedBg = "rgb(255, 255, 255)";
    const root = makeEl("div", {}, [shell]);
    const { doc } = runOneRule(root, "settings-white-area", { pathname: "/settings/general" });
    check("settings-white-area falls back to cream when --app-bg is missing and there is no dark-mode class",
      doc.documentElement.style.backgroundColor === "#f9f8f4" &&
      doc.body.style.backgroundColor === "#f9f8f4",
      `html=${doc.documentElement.style.backgroundColor} body=${doc.body.style.backgroundColor}`);
  }

  { // settings-white-area paint source: the shell is transparent and
    // an ANCESTOR carries a different cream (#faf9f7, the sidebar
    // surface) — round 1 would have painted that ancestor's colour.
    // Round 2 paints the --app-bg variable (#f9f8f4), never a
    // background copied from the shell or any ancestor.
    const shell = makeEl("main", {}, [makeEl("nav", { "aria-label": "Settings" }, [])]);
    const root = makeEl("div", {}, [shell]);
    root._computedBg = "rgb(250, 249, 247)";
    const { doc } = runOneRule(root, "settings-white-area", { pathname: "/settings/general", cssVars: { "--app-bg": "#f9f8f4" } });
    check("settings-white-area paints from the theme variable, never from the shell or an ancestor background",
      doc.documentElement.style.backgroundColor === "#f9f8f4" &&
      doc.body.style.backgroundColor === "#f9f8f4",
      `html=${doc.documentElement.style.backgroundColor} body=${doc.body.style.backgroundColor}`);
  }

  { // settings-white-area off Settings pages: the fill must never
    // touch /chat or any other page (the paint is inline on
    // <html>/<body> and would persist across SPA navigations).
    const shell = makeEl("main", {}, [makeEl("nav", { "aria-label": "Settings" }, [])]);
    shell._computedBg = "rgb(255, 255, 255)";
    const wrap = makeEl("div", {}, [shell]);
    const root = makeEl("div", {}, [wrap]);
    const { doc, sandbox } = runOneRule(root, "settings-white-area", { pathname: "/chat/abc", cssVars: { "--app-bg": "#f9f8f4" } });
    check("settings-white-area does nothing off Settings pages",
      shell.style.getPropertyValue("min-height") === "" &&
      shell.getAttribute("data-agentx-settings-stretch") === null &&
      doc.documentElement.style.backgroundColor === undefined &&
      doc.body.style.backgroundColor === undefined &&
      doc.body.getAttribute("data-agentx-settings-bg") === null &&
      doc.body.getAttribute("data-agentx-settings-diag") === null &&
      sandbox.window.__agentxSettingsDiag === undefined,
      `minHeight=${shell.style.getPropertyValue("min-height")} html=${doc.documentElement.style.backgroundColor} marker=${doc.body.getAttribute("data-agentx-settings-bg")}`);
  }

  { // settings-white-area before React renders: the settings nav is
    // not in the DOM yet on the first pass, so the rule must no-op
    // safely and wait for the next observer pass (never throw, never
    // paint).
    const root = makeEl("div", {}, [makeEl("main", {}, [])]);
    const { doc, sandbox } = runOneRule(root, "settings-white-area", { pathname: "/settings/general", cssVars: { "--app-bg": "#f9f8f4" } });
    check("settings-white-area is a safe no-op before React renders the settings nav",
      doc.body.getAttribute("data-agentx-settings-bg") === null &&
      doc.documentElement.style.backgroundColor === undefined &&
      doc.body.style.backgroundColor === undefined &&
      doc.body.getAttribute("data-agentx-settings-diag") === null &&
      sandbox.window.__agentxSettingsDiag === undefined,
      `marker=${doc.body.getAttribute("data-agentx-settings-bg")}`);
  }

  { // settings-white-area cleanup: navigating away from Settings must
    // remove the inline paint AND the stretch AND the probe, or the
    // cream would leak onto /chat (the observer keeps running across
    // SPA navigations and <html>/<body> styles persist).
    const shell = makeEl("main", {}, [makeEl("nav", { "aria-label": "Settings" }, [])]);
    shell._computedBg = "rgb(255, 255, 255)";
    const wrap = makeEl("div", {}, [shell]);
    const root = makeEl("div", {}, [wrap]);
    const { doc, sandbox } = runOneRule(root, "settings-white-area", { pathname: "/settings/general", cssVars: { "--app-bg": "#f9f8f4" } });
    sandbox.location.pathname = "/chat/abc";
    sandbox.window.location.pathname = "/chat/abc";
    vm.runInContext('agentxRunRuleNow("settings-white-area")', sandbox);
    check("settings-white-area removes the paint and the stretch when leaving Settings",
      doc.body.getAttribute("data-agentx-settings-bg") === "0" &&
      !doc.documentElement.style.backgroundColor &&
      !doc.body.style.backgroundColor &&
      doc.querySelectorAll("[data-agentx-settings-stretch]").length === 0 &&
      doc.body.getAttribute("data-agentx-settings-diag") === null &&
      sandbox.window.__agentxSettingsDiag === undefined,
      `marker=${doc.body.getAttribute("data-agentx-settings-bg")} html=${doc.documentElement.style.backgroundColor} body=${doc.body.style.backgroundColor}`);
  }

  // Realistic settings DOM (2026-11-19, round 3): the live layout
  // from the served bundle (index-tgCT4NPx.css) — a transparent
  // .page-content shell inside a WHITE full-height
  // .index-module__mainContentLayout wrapper (background:
  // var(--app-surface)), inside cream .ant-layout-content /
  // .ant-layout. The round-2 mock had no covering wrapper, so the
  // rule passed while live it painted a body nobody could see.
  function makeSettingsDom() {
    const shell = makeEl("main", { class: "page-content" }, [makeEl("nav", { "aria-label": "Settings" }, [])]);
    shell._computedBg = "rgba(0, 0, 0, 0)";
    shell.offsetHeight = 894;
    shell.offsetTop = 104;
    const pageContainer = makeEl("div", { class: "page-container" }, [shell]);
    pageContainer._computedBg = "rgba(0, 0, 0, 0)";
    const mainLayout = makeEl("div", { class: "index-module__mainContentLayout__5qYwp" }, [pageContainer]);
    mainLayout._computedBg = "rgb(255, 255, 255)";
    mainLayout.offsetHeight = 998;
    const antContent = makeEl("div", { class: "ant-layout-content" }, [mainLayout]);
    antContent._computedBg = "rgb(249, 248, 244)";
    const antLayout = makeEl("div", { class: "ant-layout" }, [antContent]);
    antLayout._computedBg = "rgb(249, 248, 244)";
    return { shell, pageContainer, mainLayout, antContent, antLayout };
  }

  { // settings-white-area round 3 (2026-11-19: round 2 browser-
    // verified ZERO change — the strip stayed ~104px in light mode
    // even though curl showed the new code in the served HTML.
    // Diagnosis from the SERVED console bundle: the shell is
    // transparent inside a WHITE full-height mainContentLayout
    // wrapper that covers the <html>/<body> paint. Round 3 paints
    // the shell AND every ancestor with the theme paint.
    const { shell, pageContainer, mainLayout, antContent, antLayout } = makeSettingsDom();
    const { doc, sandbox } = runOneRule(antLayout, "settings-white-area", {
      pathname: "/settings/general",
      cssVars: { "--app-bg": "#f9f8f4" },
    });
    check("settings-white-area paints the shell and the white wrapper ancestor cream in light mode on the realistic DOM",
      shell.style.backgroundColor === "#f9f8f4" &&
      mainLayout.style.backgroundColor === "#f9f8f4" &&
      pageContainer.style.backgroundColor === "#f9f8f4" &&
      antContent.style.backgroundColor === "#f9f8f4" &&
      antLayout.style.backgroundColor === "#f9f8f4" &&
      doc.body.style.backgroundColor === "#f9f8f4" &&
      doc.documentElement.style.backgroundColor === "#f9f8f4" &&
      shell.getAttribute("data-agentx-settings-bg") === "1" &&
      mainLayout.getAttribute("data-agentx-settings-bg") === "1",
      `shell=${shell.style.backgroundColor} wrapper=${mainLayout.style.backgroundColor} html=${doc.documentElement.style.backgroundColor}`);
    check("settings-white-area writes no diagnostic line on the realistic DOM",
      doc.getElementById("agentxSettingsDiag") === null &&
      doc.querySelectorAll("*").every((e) => (e.textContent || "").indexOf("AX-DIAG") === -1),
      `diag div present=${doc.getElementById("agentxSettingsDiag") !== null}`);
    vm.runInContext('agentxRunRuleNow("settings-white-area")', sandbox);
    check("settings-white-area stays diagnostic-free and keeps the paint on re-runs",
      shell.style.backgroundColor === "#f9f8f4" &&
      mainLayout.style.backgroundColor === "#f9f8f4" &&
      doc.getElementById("agentxSettingsDiag") === null &&
      doc.querySelectorAll("*").filter((e) => e.getAttribute("id") === "agentxSettingsDiag").length === 0,
      `shell=${shell.style.backgroundColor} diag count=${doc.querySelectorAll("*").filter((e) => e.getAttribute("id") === "agentxSettingsDiag").length}`);
  }

  { // settings-white-area round 3 in dark mode: the wrapper is the
    // dark surface #1f1f1f there and --app-bg is #141414 — the shell
    // and the wrapper must both be painted dark, never cream, and
    // no diagnostic line may appear (round 4 removed it).
    const { shell, mainLayout, antLayout } = makeSettingsDom();
    mainLayout._computedBg = "rgb(31, 31, 31)";
    const { doc } = runOneRule(antLayout, "settings-white-area", {
      pathname: "/settings/general",
      cssVars: { "--app-bg": "#141414" },
      htmlClass: "dark-mode",
    });
    check("settings-white-area paints the shell and the white wrapper ancestor dark in dark mode on the realistic DOM",
      shell.style.backgroundColor === "#141414" &&
      mainLayout.style.backgroundColor === "#141414" &&
      doc.body.style.backgroundColor === "#141414" &&
      doc.documentElement.style.backgroundColor === "#141414" &&
      doc.getElementById("agentxSettingsDiag") === null,
      `shell=${shell.style.backgroundColor} wrapper=${mainLayout.style.backgroundColor} diag present=${doc.getElementById("agentxSettingsDiag") !== null}`);
  }

  { // settings-white-area round 3 cleanup: leaving Settings must
    // also remove the paint from the shell and the wrapper ancestor
    // and leave no diagnostic line behind, or the cream would leak
    // onto /chat (the wrapper is shared app chrome).
    const { shell, mainLayout, antLayout } = makeSettingsDom();
    const { doc, sandbox } = runOneRule(antLayout, "settings-white-area", {
      pathname: "/settings/general",
      cssVars: { "--app-bg": "#f9f8f4" },
    });
    const paintedBefore = shell.style.backgroundColor === "#f9f8f4" &&
      mainLayout.style.backgroundColor === "#f9f8f4";
    sandbox.location.pathname = "/chat/abc";
    sandbox.window.location.pathname = "/chat/abc";
    vm.runInContext('agentxRunRuleNow("settings-white-area")', sandbox);
    check("settings-white-area removes the ancestor paint when leaving Settings",
      paintedBefore &&
      !shell.style.backgroundColor &&
      !mainLayout.style.backgroundColor &&
      doc.querySelectorAll('[data-agentx-settings-bg="1"]').length === 0 &&
      doc.getElementById("agentxSettingsDiag") === null &&
      sandbox.window.__agentxSettingsDiag === undefined,
      `paintedBefore=${paintedBefore} shell=${shell.style.backgroundColor} wrapper=${mainLayout.style.backgroundColor} painted=${doc.querySelectorAll('[data-agentx-settings-bg="1"]').length}`);
  }
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log("failed:", failed.join(", ")); process.exit(1); }
