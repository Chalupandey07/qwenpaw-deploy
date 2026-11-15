// DOM-shim harness for pages/public/desktop-chrome.html.
// Run: node features/desktop/harness-desktop-chrome.mjs
// Loads the real chrome page, extracts its inline <script>, and runs it
// in a vm context with a minimal DOM shim + a mocked fetch. Exercises the
// chrome's state machine through the window.__qwenpawDesktop debug handle
// (exposed by the chrome for exactly this). NOT deployed — test-only.
// Coverage: the fix round for the 4 browser defects (2026-11-15):
//   D2 pill: exactly one "You have control", release clears the status pill,
//        reconnect updates the pill.
//   D3 terminal: the terminal tab uses the SAME lease as the header.
//   D4 mode switch: switching computers releases the old lease and mounts
//        the new computer in view mode; status is per-computer.
//   D1 wake: a desktop that never comes up fails honestly within the
//        bounded wait instead of "Booting…" forever.
import { readFileSync } from "node:fs";
import { TextEncoder, TextDecoder } from "node:util";
import vm from "node:vm";

const html = readFileSync(new URL("../../pages/public/desktop-chrome.html", import.meta.url), "utf8");
const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// --- Minimal DOM shim ----------------------------------------------------
function makeClassList() {
  const set = new Set();
  return {
    add: (...xs) => { xs.forEach((x) => set.add(x)); },
    remove: (...xs) => { xs.forEach((x) => set.delete(x)); },
    toggle: (x, force) => { const on = force !== undefined ? force : !set.has(x); if (on) set.add(x); else set.delete(x); return on; },
    contains: (x) => set.has(x),
  };
}
function makeElement(id, doc) {
  const el = {
    id: id || "",
    tagName: "DIV",
    style: {},
    classList: makeClassList(),
    children: [],
    _listeners: {},
    _attrs: {},
    textContent: "",
    _innerHTML: "",
    value: "",
    checked: false,
    disabled: false,
    className: "",
    src: "",
    title: "",
    onclick: null,
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    remove() { this._removed = true; },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] ?? null; },
    querySelectorAll(sel) {
      if (sel === "button[data-action]") {
        return ["stop", "recover", "reset", "update"].map((a) => {
          const b = makeElement("", doc);
          b._attrs["data-action"] = a;
          return b;
        });
      }
      return [];
    },
    get contentWindow() { return { postMessage() {} }; },
    focus() {},
    __fire(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev || {})); },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._innerHTML; },
    set(htmlText) {
      el._innerHTML = htmlText;
      // Register any id="..." in the injected HTML so getElementById
      // finds the buttons the chrome wires up afterwards (retryBtn,
      // wakeRetry, termTake, ...).
      for (const m of htmlText.matchAll(/id="([^"]+)"/g)) {
        if (!doc._byId.has(m[1])) doc._byId.set(m[1], makeElement(m[1], doc));
      }
    },
  });
  return el;
}
const STATIC_IDS = [
  "screenWrap", "screenOverlay", "overlayTitle", "overlayText", "overlayActions",
  "overlaySpinner", "statusPill", "dot", "takeBtn", "releaseBtn", "controlPill",
  "teachBtn", "teachBar", "teachGoal", "teachSensitive", "teachStop", "modeSelect",
  "menuBtn", "menu", "menuNote", "closeBtn", "toast", "tabScreen", "tabTerminal",
  "terminalWrap", "needsYou", "nyBody", "nyPreview", "editorModal",
  "edName", "edWhen", "edInputs", "edSteps", "edCheck", "edReturn", "edApproval",
  "edFailure", "edSave", "edTest", "edRoutine", "edClose", "terminal",
];
const doc = {
  _byId: new Map(),
  getElementById(id) {
    if (!this._byId.has(id)) this._byId.set(id, makeElement(id, this));
    return this._byId.get(id);
  },
  createElement(tag) { const el = makeElement("", this); el.tagName = tag.toUpperCase(); return el; },
  querySelectorAll() { return []; },
  addEventListener() {},
  visibilityState: "visible",
  body: null,
};
for (const id of STATIC_IDS) doc._byId.set(id, makeElement(id, doc));
doc.body = makeElement("body", doc);
doc.getElementById("modeSelect").value = "team";
// Static text from the real HTML (the shim does not parse the page's
// markup, so these start empty): the control pill's label is HTML content
// the chrome never sets via textContent.
doc.getElementById("controlPill").textContent = "You have control";
doc.getElementById("statusPill").textContent = "Connecting…";
// Elements that start hidden in the real HTML (style="display:none").
for (const id of ["controlPill", "takeBtn", "releaseBtn", "teachBtn"]) {
  doc.getElementById(id).style.display = "none";
}

// --- Fake xterm.js + WebSocket (for the terminal tab) ---------------------
class FakeTerminal {
  constructor() { this.cols = 80; this.rows = 24; this._written = ""; }
  open(el) { this.el = el; }
  write(s) { this._written += s; }
  clear() {}
  dispose() {}
  onData(fn) { this._onData = fn; }
  onResize(fn) { this._onResize = fn; }
}
const sockets = [];
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.binaryType = "";
    sockets.push(this);
    setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
  }
  send() {}
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}

// --- Mock fetch (records every call; configurable status) ----------------
const calls = [];
const mockStatus = { desktop: "up", screen: "live" };
const mockWake = { ok: true, desktopStart: "already-running" };
function jsonResp(obj, status = 200) {
  return { status, json: async () => obj, body: { cancel: async () => {} }, headers: new Headers({ "Content-Type": "application/json" }) };
}
async function mockFetch(input, init = {}) {
  const url = typeof input === "string"
    ? "https://qwenpawx.pages.dev" + input
    : input instanceof Request ? input.url : String(input);
  const method = init.method || "GET";
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
  calls.push({ url, method, body });
  const u = new URL(url);
  const path = u.pathname + u.search;
  if (path.startsWith("/desktop/__mode")) {
    if (method === "POST") return jsonResp({ ok: true, mode: body.mode });
    return jsonResp({ mode: "team" });
  }
  if (path.startsWith("/desktop/__status")) {
    return jsonResp({
      desktop: mockStatus.desktop, screen: mockStatus.screen,
      computer: u.searchParams.get("computer") || "default",
      machine: "up",
      lease: { holder: "agent", leaseId: null, expiresAt: null }, generation: 1,
    });
  }
  if (path.startsWith("/desktop/__wake")) return jsonResp({ ok: mockWake.ok, pingStatus: 200, desktopStart: mockWake.desktopStart, computer: body?.computer || "default" });
  if (path.startsWith("/desktop/__screen")) {
    return jsonResp({ ok: true, url: `/desktop/session/${body.mode === "terminal" ? "terminal" : body.mode === "control" ? "control" : "view"}/1794746000.faketoken`, expiresAt: 1794746000000 });
  }
  if (path.startsWith("/desktop/__takeover")) return jsonResp({ ok: true, leaseId: "lease-123", expiresAt: Date.now() + 90000, generation: 5 });
  if (path.startsWith("/desktop/__release")) return jsonResp({ ok: true, released: true, generation: 6 });
  if (path.startsWith("/desktop/__heartbeat")) return jsonResp({ ok: true, expiresAt: Date.now() + 90000 });
  if (path.startsWith("/desktop/__needs-you")) return jsonResp({ record: null });
  if (path.includes("/vnc.html")) return { status: 200, body: { cancel: async () => {} }, json: async () => ({}), headers: new Headers({ "Content-Type": "text/html" }) };
  return jsonResp({ ok: true });
}

// --- vm context ------------------------------------------------------------
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  TextEncoder, TextDecoder,
  fetch: mockFetch,
  document: doc,
  navigator: { sendBeacon: () => true, clipboard: { async writeText() {} } },
  location: { origin: "https://qwenpawx.pages.dev", href: "https://qwenpawx.pages.dev/desktop", protocol: "https:", host: "qwenpawx.pages.dev", reload() {} },
  localStorage: { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
  WebSocket: FakeWebSocket,
  Terminal: FakeTerminal,
  QWENPAW_WAKE_TIMEOUT_MS: 200, // short bounded wait for the wake test
  _winListeners: {},
  addEventListener(type, fn) { (this._winListeners[type] ||= []).push(fn); },
  removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(scriptSrc, sandbox, { filename: "desktop-chrome.html" });

const D = sandbox.__qwenpawDesktop;
const el = (id) => doc.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
function countControlPills() {
  // How many VISIBLE header elements currently read "You have control"?
  // (The control pill keeps its label while hidden; only count it shown.)
  return [el("statusPill"), el("controlPill")].filter((e) => e.textContent === "You have control" && e.style.display !== "none").length;
}

// Let init() settle (loadMode + __status + mountScreen, all mocked).
await sleep(300);

// (g) init() polls __status for the CURRENT computer (per-computer status).
check("D-g init() calls __status with ?computer=",
  calls.some((c) => c.url.includes("/desktop/__status?computer=")),
  `calls=${JSON.stringify(calls.map((c) => c.url))}`);

// (d1) Terminal tab with NO lease -> the gate, no socket.
calls.length = 0;
sockets.length = 0;
D.setTab("terminal");
await sleep(50);
check("D-d1 terminal tab without a lease shows the gate (no shell)",
  el("terminalWrap").innerHTML.includes("Take control to use the terminal") && sockets.length === 0,
  `html=${el("terminalWrap").innerHTML.slice(0, 80)} sockets=${sockets.length}`);

// (d2) Take control in the header while the terminal tab is active ->
// the terminal OPENS on the same lease (one hold, not two).
await D.takeControl();
await sleep(100);
check("D-d2 taking control with the terminal tab active opens the shell (same lease)",
  sockets.length === 1 && sockets[0].url.includes("/desktop/session/terminal/") && el("terminalWrap").innerHTML.includes('id="terminal"'),
  `sockets=${sockets.length} url=${sockets[0] && sockets[0].url} html=${el("terminalWrap").innerHTML.slice(0, 60)}`);
check("D-d2b the terminal mint used the header lease (no second takeover)",
  !calls.some((c) => c.url.includes("/desktop/__takeover") && c !== calls.find((x) => x.url.includes("/desktop/__takeover"))),
  `takeover calls=${calls.filter((c) => c.url.includes("/desktop/__takeover")).length}`);

// (a) In control, the screen connects: the status pill says "Live" and
// exactly ONE element says "You have control" (the control pill).
D.screenState("connected");
check("D-a connected in control: status pill is Live, control pill is the only 'You have control'",
  D.state.statusPill === "Live" && D.state.controlPillVisible === true && D.state.controlPillText === "You have control" && countControlPills() === 1,
  `state=${JSON.stringify(D.state)} count=${countControlPills()}`);

// (b) Release: the status pill resets to Live (the old code left it on
// "You have control" forever) and the control pill hides.
el("statusPill").textContent = "You have control"; // simulate the stuck state
D.setControlUI(false);
check("D-b release resets the status pill to Live and hides the control pill",
  D.state.statusPill === "Live" && D.state.controlPillVisible === false && countControlPills() === 0,
  `state=${JSON.stringify(D.state)} count=${countControlPills()}`);

// (c) A failed remount updates the pill to Reconnecting… (the old code
// left it on whatever it was — "You have control" while reconnecting).
D.scheduleReconnect("test drop");
check("D-c scheduleReconnect sets the pill to Reconnecting…",
  D.state.statusPill === "Reconnecting…",
  `state=${JSON.stringify(D.state)}`);

// (f) Mode switch while in control: the OLD computer's lease is released
// and the new computer mounts in VIEW mode (never control with the old lease).
calls.length = 0;
await D.takeControl();
await sleep(100);
calls.length = 0;
el("modeSelect").value = "private";
el("modeSelect").__fire("change");
await sleep(300);
const releaseCall = calls.find((c) => c.url.includes("/desktop/__release"));
const screenCall = calls.find((c) => c.url.includes("/desktop/__screen"));
check("D-f mode switch releases the OLD computer's lease",
  !!releaseCall && releaseCall.body && releaseCall.body.computer === "default" && releaseCall.body.leaseId === "lease-123",
  `release=${JSON.stringify(releaseCall)}`);
check("D-f2 mode switch mounts the new computer in VIEW mode (not control)",
  D.state.computer === "qa" && !!screenCall && screenCall.body && screenCall.body.mode === "view" && screenCall.body.computer === "qa",
  `state=${JSON.stringify(D.state)} screen=${JSON.stringify(screenCall)}`);

// (e) Wake with a desktop that never comes up: the bounded wait fails
// honestly instead of "Booting…" forever.
mockStatus.desktop = "asleep";
mockStatus.screen = "unknown";
calls.length = 0;
await D.wake();
await sleep(6000); // one 5 s poll tick, past the 200 ms timeout
check("D-e wake that never comes up shows a failure, not Booting… forever",
  el("overlayTitle").textContent === "The desktop did not come up" && el("statusPill").textContent === "Asleep",
  `title=${el("overlayTitle").textContent} pill=${el("statusPill").textContent}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
