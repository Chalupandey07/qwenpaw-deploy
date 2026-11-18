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
 *     - the rule table exists (12 rules) and each rule runs in its own
 *       try/catch with a console.debug naming the rule;
 *     - the CSP-Report-Only + Referrer-Policy headers are set on the
 *       console HTML response, and the <title> is rewritten;
 *     - the shim is injected before the panel script, and the observer
 *       calls the rebrand pass.
 *   Dynamic, in a VM with mocks:
 *     - the real shim (extracted from the file, run with the file's own
 *       constants): PyPI fetch is stubbed, other fetches pass through;
 *       window.open is swallowed for the upstream hosts and passes
 *       through for others; ?rebrand=0 leaves fetch/open unpatched.
 *     - the real rebrand rules (extracted between the AGENTX-REBRAND
 *       markers, run against a mock DOM): the title is renamed, a
 *       "Tutorial" menu item is hidden (and "Settings" is not), a
 *       "QwenPaw" text node is renamed while a load-bearing node is left
 *       alone, an aria-label is renamed, a DashScope card is hidden, the
 *       About item opens /status, and an upstream link click is blocked
 *       while a normal link is not.
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
  check("the rule table exists with 12 rules",
    ruleIds.length === 12, `got ${ruleIds.length}: ${ruleIds.join(", ")}`);
  check("the expected rules are all present",
    ["rename-title", "rename-attrs", "rename-text", "hide-menu", "hide-about",
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
  check("the China-hide list covers the providers and channels",
    /"DashScope", "SiliconFlow", "ModelScope", "Alibaba", "WeCom", "DingTalk", "Feishu", "QQ", "WeChat", "Xiaoyi"/.test(rebrandSrc));
  check("the load-bearing allowlist is enforced by the text pass",
    /"qwenpaw\[codex\]", "qwenpaw\[whisper\]", "QWENPAW_AUTH_ENABLED", "~\/\.qwenpaw"/.test(rebrandSrc) &&
    /agentxIsLoadBearing\(t\)/.test(rebrandSrc) &&
    /agentxIsLoadBearing\(parent\.textContent\)/.test(rebrandSrc));
  check("the multi-window safety prompts are not hidden (only renamed)",
    !/Close QwenPaw\?/.test(rebrandSrc.split("hide-")[0]) &&
    !rebrandSrc.includes('"Close QwenPaw?"'),
    "hiding them would suppress real safety prompts");
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
  const doc = {
    title: "QwenPaw Console",
    body: rootEl,
    _listeners: listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
    querySelectorAll(selector) {
      return collectAll(rootEl, []).filter((el) => matchesSelector(el, selector));
    },
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
  return doc;
}

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
    "a 'Settings' menu item is NOT hidden",
    "a visible 'QwenPaw' text node is renamed to AgentX",
    "a load-bearing instruction is left alone (truthful, not renamed)",
    "an aria-label with QwenPaw is renamed",
    "a DashScope provider card is hidden",
    "the About item is renamed to AgentX",
    "clicking About opens our /status page, not the upstream site",
    "a click on an upstream docs link is blocked",
    "a click on a same-origin link is NOT blocked",
  ]) check(name, false, "AGENTX-REBRAND markers not found in _worker.js");
} else {
  // A small console-like DOM: a header menu, a settings row, a provider
  // card, an About item, a load-bearing instruction, and an aria-label.
  const menu = makeEl("ul", { class: "qwenpaw-menu" }, [
    makeEl("li", { class: "qwenpaw-menu-item" }, [makeEl("span", {}, [makeText("Tutorial")])]),
    makeEl("li", { class: "qwenpaw-menu-item" }, [makeEl("span", {}, [makeText("GitHub")])]),
    makeEl("li", { class: "qwenpaw-menu-item" }, [makeEl("span", {}, [makeText("Settings")])]),
  ]);
  const aboutBtn = makeEl("button", {}, [makeText("About QwenPaw")]);
  const greeting = makeEl("p", {}, [makeText("Hello! I'm QwenPaw. How can I help you?")]);
  const loadBearing = makeEl("p", {}, [makeText("Set QWENPAW_AUTH_ENABLED=true to use the QwenPaw terminal.")]);
  const ariaBtn = makeEl("button", { "aria-label": "QwenPaw menu" }, [makeText("Menu")]);
  const card = makeEl("div", { class: "provider-card" }, [
    makeEl("h3", {}, [makeText("DashScope")]),
    makeEl("p", {}, [makeText("Alibaba Cloud model provider.")]),
  ]);
  const upstreamLink = makeEl("a", { href: "https://qwenpaw.agentscope.io/docs/intro?lang=en" }, [makeText("View guide")]);
  const normalLink = makeEl("a", { href: "/status" }, [makeText("Status")]);
  const root = makeEl("div", { id: "root" }, [
    menu, aboutBtn, greeting, loadBearing, ariaBtn, card, upstreamLink, normalLink,
  ]);
  const doc = makeDocument(root);
  const opened = [];
  const sandbox = {
    document: doc,
    location: { search: "" },
    window: { open: (url) => { opened.push(url); return { closed: false }; } },
    NodeFilter: { SHOW_TEXT: 4 },
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
  check("a DashScope provider card is hidden",
    card.style.display === "none", `display=${card.style.display}`);
  check("the About item is renamed to AgentX",
    aboutBtn.textContent === "About AgentX", `got ${aboutBtn.textContent}`);
  aboutBtn.dispatch("click", { preventDefault() {}, stopPropagation() {} });
  check("clicking About opens our /status page, not the upstream site",
    opened.includes("/status") && !opened.some((u) => u.includes("qwenpaw.agentscope.io")),
    `opened ${opened.join(", ")}`);
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
