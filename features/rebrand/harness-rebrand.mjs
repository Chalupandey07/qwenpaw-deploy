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
 *     - the rule table exists (13 rules) and each rule runs in its own
 *       try/catch with a console.debug naming the rule;
 *     - the CSP-Report-Only + Referrer-Policy headers are set on the
 *       console HTML response, and the <title> is rewritten;
 *     - the shim is injected before the panel script, and the observer
 *       calls the rebrand pass;
 *     - the keep-alive Worker and the activity-feed Worker report the
 *       note "AgentX console answered" (the /status page shows it).
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
 *       whole cards/buttons, a non-China channel (Telegram / Slack) is
 *       NOT hidden, the channel grid is NOT hidden, and the China cards
 *       are hidden when the provider list mounts after the initial pass
 *       — the old mock used class "provider-card", which the real
 *       bundle never emits, so it passed while the live rule hid the
 *       whole list), the About item ("About QwenPaw v2.3.0")
 *       is renamed to "About AgentX v2.3.0" and clicking it opens our
 *       /status page, the sidebar logo img (alt "QwenPaw") is replaced
 *       by an "AgentX" text label, a title change is renamed
 *       immediately by the title observer, and an upstream link click is
 *       blocked while a normal link is not.
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
  check("the rule table exists with 13 rules",
    ruleIds.length === 13, `got ${ruleIds.length}: ${ruleIds.join(", ")}`);
  check("the expected rules are all present",
    ["rename-title", "rename-attrs", "rename-text", "rename-logo", "hide-menu", "hide-about",
     "hide-language", "hide-desktop-prompt", "hide-codex-qoder", "hide-voice",
     "hide-import-text", "hide-china", "block-links"].every((id) => ruleIds.includes(id)));
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
  check("the China-hide list covers the providers and channels, including Aliyun",
    /"DashScope", "SiliconFlow", "ModelScope", "Alibaba", "Alibaba Cloud", "Aliyun", "WeCom", "DingTalk", "Feishu", "QQ", "WeChat", "Xiaoyi"/.test(rebrandSrc));
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
    /new MutationObserver\(function \(\) \{ addVaultMenuItem\(\); agentxRunRules\(\); \}\)/.test(worker));
  check("CSP-Report-Only blocks third-party images (alicdn)",
    /headers\.set\("Content-Security-Policy-Report-Only", "img-src 'self' data: blob:"\)/.test(worker));
  check("Referrer-Policy no-referrer is set on the console HTML",
    /headers\.set\("Referrer-Policy", "no-referrer"\)/.test(worker));
  check("the waking page title is AgentX",
    /<title>AgentX — Waking up<\/title>/.test(worker) && /<h1>AgentX is waking up<\/h1>/.test(worker));
  check("the cooldown page title is AgentX",
    /<title>AgentX — Cooldown<\/title>/.test(worker) && /<h1>AgentX is in max-run cooldown<\/h1>/.test(worker));
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
    style: {},
    _attrs: { ...(attrs || {}) },
    _listeners: {},
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; },
    setAttribute(name, value) { this._attrs[name] = String(value); },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, ev) { for (const fn of this._listeners[type] || []) fn(ev); },
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
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
  for (const child of children || []) {
    child.parentNode = el;
    el.childNodes.push(child);
    if (child.nodeType === 1) el.children.push(child);
  }
  return el;
}
// Simplified selector matching for exactly the forms the rebrand rules
// use: tag, [attr*="v"], [attr="v"] / [attr='v'], comma-separated lists.
function matchesCompound(el, sel) {
  sel = sel.trim();
  if (!sel) return false;
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
function makeDocument(rootEl) {
  const listeners = {};
  const titleText = makeText("QwenPaw Console");
  const titleEl = makeEl("title", {}, [titleText]);
  const doc = {
    body: rootEl,
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
      return collectAll(rootEl, []).filter((el) => matchesSelector(el, selector));
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
  function realAvailableItem(name) {
    const btn = makeEl("button", { type: "button", class: CH.item }, [
      makeEl("span", { class: "index-module__availableItemIcon__x" }, []),
      makeEl("span", { class: CH.itemName }, [makeText(name)]),
      makeEl("span", { class: "index-module__availableItemAction__Et-aH" }, [makeText("Configure")]),
    ]);
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
  const channelGrid = makeEl("div", { class: CH.grid }, [
    chanWeCom, chanTelegram, chanDingTalk, itemFeishu, itemSlack, itemQQ, itemWeChat,
  ]);
  // Async mount: this list is empty on the first pass (the API has not
  // returned yet); the cards mount afterwards and the observer's re-run
  // must hide the China ones.
  const asyncList = makeEl("div", { class: CLS.list }, []);
  const upstreamLink = makeEl("a", { href: "https://qwenpaw.agentscope.io/docs/intro?lang=en" }, [makeText("View guide")]);
  const normalLink = makeEl("a", { href: "/status" }, [makeText("Status")]);
  const root = makeEl("div", { id: "root" }, [
    menu, header, settingsMenu, aboutLi, brandDiv, greeting, loadBearing, ariaBtn,
    providerList, channelGrid, asyncList, upstreamLink, normalLink,
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

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log("failed:", failed.join(", ")); process.exit(1); }
