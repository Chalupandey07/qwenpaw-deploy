#!/usr/bin/env node
/**
 * Harness — per-chat thinking selector (features/thinking-selector/).
 *
 * The backend already supports per-chat thinking end to end
 * (GET/PUT /api/chats/{id}/thinking, ThinkingPreference {level}); the
 * "thinking-selector" rule in pages/public/_worker.js only surfaces it
 * as a selector next to the composer controls: Default / Off / Low /
 * Medium / High / XHigh. This harness tests the rule without a browser:
 *
 *   Static, on the real _worker.js source:
 *     - the rule exists and is wired into the MutationObserver;
 *     - it GETs and PUTs /api/chats/{id}/thinking with a Bearer token
 *       read from localStorage qwenpaw_auth_token (never a cookie);
 *     - it offers Default/Off/Low/Medium/High/XHigh and sends the
 *       model_key on PUT (the 409 guard);
 *     - it never polls (no setInterval/setTimeout) and never moves or
 *       removes React nodes (appendChild only, no removeChild/remove/
 *       innerHTML), and only runs on /chat pages.
 *   Dynamic, extracting the real helpers + rule and running them with a
 *   minimal DOM mock + a fetch mock:
 *     - on /chat/<id> it creates one label + one select in the toolbar
 *       (the Context button's parent), GETs the stored level and shows
 *       it;
 *     - changing the select PUTs {level} with the Bearer token and the
 *       model_key; a second run on the same chat re-GETs nothing and
 *       creates no second select;
 *     - on a brand-new chat (no id) a pick is stored as pending in
 *       localStorage with no fetch, and applied by PUT once the chat
 *       gets an id;
 *     - a PUT 422 reverts the select to the previous level and re-syncs,
 *       and shows the server's reason next to the selector (no silent
 *       revert); the note clears on the next successful save or chat
 *       change; a GET whose control reports kind unknown with no efforts
 *       marks the selector title as locked, and a capable model restores
 *       the default title;
 *     - a server level outside the offered set (max) gains an option
 *       and is shown, never misrepresented as Default;
 *     - a GET 401 (no token) is a safe no-op; off chat pages the rule
 *       creates nothing and fetches nothing.
 *
 * Live half (NOT verified here): after a Pages deploy, a real browser
 * sets XHigh on one chat and Low on another, GET reflects each, and a
 * reply still works. On a model whose thinking cannot be adjusted
 * (deepseek-v4.1-flash-free) the pick 422s and the selector shows the
 * server's reason instead of reverting silently.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = readFileSync(join(HERE, "..", "..", "pages", "public", "_worker.js"), "utf8");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; }
  else { failed.push(name + (detail ? " — " + detail : "")); }
}

// ---------- extract the real thinking code from _worker.js ----------
// Helpers: from the state var up to (not including) `var AGENTX_RULES`.
// Missing code (pre-feature _worker.js) yields empty sources, so the
// static checks fail and the dynamic checks fail gracefully instead of
// crashing — that is the fail-first path.
const helpersStart = WORKER.indexOf("var agentxThinkingState = {");
const rulesStart = WORKER.indexOf("var AGENTX_RULES = [", helpersStart);
const helpersSrc = helpersStart === -1 ? "" : WORKER.slice(helpersStart, rulesStart);

// Rule object: from `{ id: "thinking-selector"` to its matching close.
function extractRule(src) {
  const start = src.indexOf('{ id: "thinking-selector"');
  if (start === -1) return null;
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === "/" && src[i + 1] === "/") { // line comment: skip to newline
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const ruleSrc = extractRule(WORKER);

// ---------- static checks ----------
check("thinking-selector rule exists in _worker.js", ruleSrc !== null);
check("rule is wired into the MutationObserver (agentxRunRuleNow)",
  WORKER.includes('agentxRunRuleNow("thinking-selector")'));
check("GET reads /api/chats/{id}/thinking",
  helpersSrc.includes('fetch("/api/chats/" + chatId + "/thinking"'));
check("PUT saves to /api/chats/{id}/thinking with a JSON {level} body",
  helpersSrc.includes('method: "PUT"') && helpersSrc.includes('JSON.stringify({ level: level })'));
check("Bearer token comes from localStorage qwenpaw_auth_token",
  helpersSrc.includes('localStorage.getItem("qwenpaw_auth_token")')
  && helpersSrc.includes('"Bearer " + t'));
check("options are Default/Off/Low/Medium/High/XHigh",
  ruleSrc !== null
  && ruleSrc.includes('["inherit", "Default"]')
  && ruleSrc.includes('["off", "Off"]')
  && ruleSrc.includes('["low", "Low"]')
  && ruleSrc.includes('["medium", "Medium"]')
  && ruleSrc.includes('["high", "High"]')
  && ruleSrc.includes('["xhigh", "XHigh"]'));
check("PUT sends the model_key when known (409 guard)",
  helpersSrc.includes('?model_key=" + encodeURIComponent(st.modelKey)'));
check("a PUT 422 shows the server's reason next to the selector (no silent revert)",
  helpersSrc.includes("agentxThinkingNote") && helpersSrc.includes("data-agentx-thinking-note")
  && helpersSrc.includes("v.detail"));
check("a GET whose control reports an unsupported model marks the selector title as locked",
  helpersSrc.includes('control.kind === "unknown"') && helpersSrc.includes("Thinking depth cannot be adjusted for this model"));
check("no polling in the thinking code (no setInterval/setTimeout)",
  !helpersSrc.includes("setInterval") && !helpersSrc.includes("setTimeout")
  && !(ruleSrc || "").includes("setInterval") && !(ruleSrc || "").includes("setTimeout"));
check("React-safe: appendChild only — no removeChild/remove()/innerHTML in the thinking code",
  (helpersSrc + (ruleSrc || "")).includes("appendChild")
  && !(helpersSrc + (ruleSrc || "")).includes("removeChild")
  && !(helpersSrc + (ruleSrc || "")).includes(".remove()")
  && !(helpersSrc + (ruleSrc || "")).includes("innerHTML"));
check("rule only runs on /chat pages",
  ruleSrc !== null && ruleSrc.includes('path.indexOf("/chat") !== 0'));

// ---------- mocks ----------
function makeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    attributes: {},
    style: {},
    textContent: "",
    value: "",
    options: [],
    _handlers: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      if (this.tagName === "SELECT" && child.tagName === "OPTION") this.options.push(child);
      return child;
    },
    addEventListener(type, fn) { (this._handlers[type] ??= []).push(fn); },
    querySelector(sel) {
      if (sel === "[data-agentx-thinking]") {
        return this.children.find((c) => c.attributes["data-agentx-thinking"]) ?? null;
      }
      return null;
    },
  };
  return el;
}
function makeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}
const okJson = (status, data) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => data,
});
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

// Build one sandboxed world per scenario: fresh state, fresh DOM.
// The mock mirrors the user's screenshot (2026-11-19): the composer
// toolbar row holds the Smart Mode button (plus model/agent/send), and
// the "Context usage" button lives in a SEPARATE container above it.
// The rule must put the selector in the Smart Mode row, not the
// Context container.
function makeWorld({ pathname, token = "tok-123", fetchHandler }) {
  const storage = makeStorage(token ? { qwenpaw_auth_token: token } : {});
  const toolbarRow = makeEl("div");
  const smartBtn = makeEl("button");
  smartBtn.setAttribute("aria-label", "Smart Mode");
  smartBtn.textContent = "Smart Mode";
  const modelBtn = makeEl("button");
  modelBtn.textContent = "deepseek-v4.1-flash-free";
  const agentBtn = makeEl("button");
  agentBtn.textContent = "default Agent default";
  const sendBtn = makeEl("button");
  sendBtn.setAttribute("aria-label", "Send");
  toolbarRow.appendChild(modelBtn);
  toolbarRow.appendChild(agentBtn);
  toolbarRow.appendChild(smartBtn);
  toolbarRow.appendChild(sendBtn);
  const ctxContainer = makeEl("div");
  const ctxBtn = makeEl("button");
  ctxBtn.setAttribute("aria-label", "Context usage 0%");
  ctxBtn.textContent = "Context usage 0%";
  ctxContainer.appendChild(ctxBtn);
  const chatInput = makeEl("textarea");
  chatInput.setAttribute("placeholder", "Ask anything, @ to mention");
  const doc = {
    querySelectorAll(sel) {
      if (sel === "button") return [ctxBtn, modelBtn, agentBtn, smartBtn, sendBtn];
      if (sel === "[placeholder]") return [chatInput];
      return [];
    },
    querySelector(sel) {
      if (sel === "[data-agentx-thinking]") {
        return toolbarRow.querySelector(sel) ?? ctxContainer.querySelector(sel);
      }
      return null;
    },
    createElement: (tag) => makeEl(tag),
  };
  const windowMock = { location: { pathname }, localStorage: storage };
  const fetchMock = makeFetch(fetchHandler);
  const sandbox = { window: windowMock, document: doc, fetch: fetchMock, console };
  vm.createContext(sandbox);
  vm.runInContext(helpersSrc, sandbox);
  vm.runInContext(`var __thinkingRule = ${ruleSrc};`, sandbox);
  const run = () => {
    const r = vm.runInContext("__thinkingRule;", sandbox);
    if (r && typeof r.run === "function") vm.runInContext("__thinkingRule.run();", sandbox);
  };
  const select = () => toolbarRow.querySelector("[data-agentx-thinking]") ?? ctxContainer.querySelector("[data-agentx-thinking]");
  return { storage, toolbar: toolbarRow, toolbarRow, ctxContainer, smartBtn, ctxBtn, fetchMock, run, select, windowMock };
}

// ---------- dynamic checks ----------
{
  // On /chat/<id>: creates the select, GETs the stored level, shows it.
  const world = makeWorld({
    pathname: "/chat/abc-123",
    fetchHandler: async (url) => {
      if (url === "/api/chats/abc-123/thinking") {
        return okJson(200, { value: { level: "high" }, model_key: "mosicn:nex-n2.6" });
      }
      return okJson(404, {});
    },
  });
  world.run();
  await flush();
  const sel = world.select();
  check("on /chat/<id> the rule creates one Thinking select in the toolbar",
    sel !== null && sel.tagName === "SELECT" && sel.options.length === 6
    && world.toolbar.children.filter((c) => c.attributes["data-agentx-thinking"]).length === 1);
  check("the select lands in the Smart Mode row itself (next to Smart Mode), not the Context container",
    sel !== null && sel.parentElement === world.toolbarRow
    && world.ctxContainer.children.filter((c) => c.attributes["data-agentx-thinking"]).length === 0);
  check("on /chat/<id> it GETs the stored level with the Bearer token and shows it",
    world.fetchMock.calls.length === 1
    && world.fetchMock.calls[0].url === "/api/chats/abc-123/thinking"
    && world.fetchMock.calls[0].headers.Authorization === "Bearer tok-123"
    && sel !== null && sel.value === "high");
}
{
  // Changing the select PUTs {level} with Bearer + model_key.
  const world = makeWorld({
    pathname: "/chat/abc-123",
    fetchHandler: async (url, opts) => {
      if ((opts.method || "GET") === "GET") {
        return okJson(200, { value: { level: "inherit" }, model_key: "mosicn:nex-n2.6" });
      }
      return okJson(200, { value: { level: "low" }, model_key: "mosicn:nex-n2.6" });
    },
  });
  world.run();
  await flush();
  const sel = world.select();
  if (sel) { sel.value = "low"; sel._handlers.change[0](); }
  await flush();
  const put = world.fetchMock.calls.find((c) => c.method === "PUT");
  check("changing the select PUTs {level} with Bearer + model_key",
    put !== undefined
    && put.url === "/api/chats/abc-123/thinking?model_key=mosicn%3Anex-n2.6"
    && put.headers.Authorization === "Bearer tok-123"
    && put.body === JSON.stringify({ level: "low" })
    && sel.value === "low");
  // A second run on the same chat re-GETs nothing and creates no second select.
  const callsBefore = world.fetchMock.calls.length;
  world.run();
  await flush();
  check("second run on the same chat re-GETs nothing and creates no second select",
    world.fetchMock.calls.length === callsBefore
    && world.toolbar.children.filter((c) => c.attributes["data-agentx-thinking"]).length === 1);
}
{
  // Brand-new chat (no id): a pick is pending, no fetch; once the chat
  // gets an id, the pending level is PUT.
  const world = makeWorld({
    pathname: "/chat",
    fetchHandler: async (url, opts) => {
      if ((opts.method || "GET") === "GET") {
        return okJson(200, { value: { level: "inherit" }, model_key: "mosicn:nex-n2.6" });
      }
      return okJson(200, { value: { level: "xhigh" }, model_key: "mosicn:nex-n2.6" });
    },
  });
  world.run();
  await flush();
  const sel = world.select();
  check("on a new chat the selector still renders (Default shown)",
    sel !== null && sel.value === "inherit");
  if (sel) { sel.value = "xhigh"; sel._handlers.change[0](); }
  await flush();
  check("picking a level with no chat id stores it as pending and fetches nothing",
    world.storage._map.get("agentx_thinking_pending") === "xhigh"
    && world.fetchMock.calls.length === 0);
  world.windowMock.location.pathname = "/chat/new-456";
  world.run();
  await flush();
  const put = world.fetchMock.calls.find((c) => c.method === "PUT");
  check("once the chat gets an id, the pending level is PUT and the pending flag clears",
    put !== undefined && put.url.startsWith("/api/chats/new-456/thinking")
    && put.body === JSON.stringify({ level: "xhigh" })
    && world.storage._map.get("agentx_thinking_pending") === undefined
    && world.select().value === "xhigh");
}
{
  // PUT 422 (level invalid for this model): revert + re-sync.
  const world = makeWorld({
    pathname: "/chat/abc-123",
    fetchHandler: async (url, opts) => {
      if ((opts.method || "GET") === "GET") {
        return okJson(200, { value: { level: "medium" }, model_key: "mosicn:nex-n2.6" });
      }
      return okJson(422, { detail: "Thinking setting is invalid for this model" });
    },
  });
  world.run();
  await flush();
  const sel = world.select();
  check("setup: select shows the server level before the 422 test", sel !== null && sel.value === "medium");
  if (sel) { sel.value = "off"; sel._handlers.change[0](); }
  await flush();
  check("a PUT 422 reverts the select to the previous level and re-syncs from the server",
    sel !== null && sel.value === "medium"
    && world.fetchMock.calls.filter((c) => (c.method || "GET") === "GET").length >= 2);
  const note = world.toolbar.children.find((c) => c.attributes["data-agentx-thinking-note"]);
  check("a PUT 422 shows the server's reason next to the selector (no silent revert)",
    note !== undefined && note.textContent === "Thinking setting is invalid for this model"
    && note.style.display !== "none");
  // Moving to another chat clears the note (it belonged to the old chat).
  world.windowMock.location.pathname = "/chat/other-999";
  world.run();
  await flush();
  check("the 422 note clears when the chat changes",
    note !== undefined && note.style.display === "none");
}
{
  // GET reports an unsupported model (control kind unknown, no efforts):
  // the selector title says the depth cannot be adjusted; a capable
  // model restores the default title.
  const world = makeWorld({
    pathname: "/chat/abc-123",
    fetchHandler: async () => okJson(200, { value: { level: "inherit" }, model_key: "millionseek:deepseek-v4.1-flash-free", control: { kind: "unknown", efforts: [], supports_off: false } }),
  });
  world.run();
  await flush();
  const sel = world.select();
  check("a GET whose control reports an unsupported model marks the selector title as locked",
    sel !== null && sel.title === "Thinking depth cannot be adjusted for this model");
}
{
  const world = makeWorld({
    pathname: "/chat/abc-123",
    fetchHandler: async () => okJson(200, { value: { level: "inherit" }, model_key: "mosicn:nex-n2.6", control: { kind: "effort", efforts: ["low", "medium", "high"] } }),
  });
  world.run();
  await flush();
  const sel = world.select();
  check("a GET whose control reports a capable model keeps the default selector title",
    sel !== null && sel.title === "Thinking level for this chat — Default follows the model, Off disables thinking");
}
{
  // Server level outside the offered set (max): gains an option, shown truly.
  const world = makeWorld({
    pathname: "/chat/abc-123",
    fetchHandler: async () => okJson(200, { value: { level: "max" }, model_key: "mosicn:nex-n2.6" }),
  });
  world.run();
  await flush();
  const sel = world.select();
  check("a server level outside the offered set (max) gains an option and is shown, not forced to Default",
    sel !== null && sel.value === "max"
    && sel.options.some((o) => o.value === "max" && o.textContent === "Max"));
}
{
  // GET 401 (no token): safe no-op, select stays Default.
  const world = makeWorld({
    pathname: "/chat/abc-123",
    token: null,
    fetchHandler: async () => okJson(401, { detail: "unauthorized" }),
  });
  world.run();
  await flush();
  const sel = world.select();
  check("a GET 401 (no token) is a safe no-op — select stays Default, no crash",
    sel !== null && sel.value === "inherit" && world.fetchMock.calls.length === 1);
}
{
  // Off chat pages: nothing created, nothing fetched.
  const world = makeWorld({
    pathname: "/settings/models",
    fetchHandler: async () => okJson(200, { value: { level: "high" } }),
  });
  world.run();
  await flush();
  check("off chat pages the rule creates nothing and fetches nothing",
    world.select() === null && world.fetchMock.calls.length === 0);
}

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log("failed:", failed.join("; "));
  process.exit(1);
}
