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
        const btns = ["stop", "recover", "reset", "update"].map((a) => {
          const b = makeElement("", doc);
          b._attrs["data-action"] = a;
          return b;
        });
        doc._menuButtons = btns; // the maintenance-menu buttons, for the T-c test
        return btns;
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
// Failure injection for the T50–T57 chrome tests (mutated by the tests):
let mockModePostOk = true;          // false -> __mode POST answers 503 store_unavailable
let mockTakeoverStatus = 200;       // non-200 -> __takeover answers that status
let mockHeartbeatStatus = 200;      // non-200 -> __heartbeat answers that status
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
    if (method === "POST") {
      if (!mockModePostOk) return jsonResp({ ok: false, error: "store_unavailable", note: "The desktop store refused the write — the free tier's daily write budget is likely spent." }, 503);
      return jsonResp({ ok: true, mode: body.mode });
    }
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
  if (path.startsWith("/desktop/__takeover")) {
    if (mockTakeoverStatus !== 200) return jsonResp({ ok: false, error: "store_unavailable", note: "The desktop store refused the write — the free tier's daily write budget is likely spent." }, mockTakeoverStatus);
    return jsonResp({ ok: true, leaseId: "lease-123", expiresAt: Date.now() + 90000, generation: 5 });
  }
  if (path.startsWith("/desktop/__release")) return jsonResp({ ok: true, released: true, generation: 6 });
  if (path.startsWith("/desktop/__heartbeat")) {
    if (mockHeartbeatStatus !== 200) return jsonResp({ ok: false, error: "store_unavailable" }, mockHeartbeatStatus);
    return jsonResp({ ok: true, expiresAt: Date.now() + 90000 });
  }
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
  QWENPAW_FRAME_SILENCE_MS: 60000, // the harness has no real shim, so no frame ever reports — keep the silence timeout out of the run (R6 shrinks it when it wants it)
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

// (h) Fix round 2: a "down" status (machine up, desktop path broken) is
// NOT "Asleep" — init() shows "Down" + "The desktop is not responding"
// with Retry / Wake, never the Asleep overlay.
mockStatus.desktop = "down";
mockStatus.screen = "unknown";
await D.init();
await sleep(300);
check("D-h init() with desktop down shows Down + not-responding overlay",
  el("statusPill").textContent === "Down" && el("overlayTitle").textContent === "The desktop is not responding",
  `title=${el("overlayTitle").textContent} pill=${el("statusPill").textContent}`);

// (i) An "origin_auth" status shows "Auth error", not "Asleep".
mockStatus.desktop = "origin_auth";
mockStatus.screen = "unknown";
await D.init();
await sleep(300);
check("D-i init() with desktop origin_auth shows Auth error",
  el("statusPill").textContent === "Auth error" && el("overlayTitle").textContent === "Could not reach the desktop",
  `title=${el("overlayTitle").textContent} pill=${el("statusPill").textContent}`);

// (j) A wake that times out while the desktop is "down" reports the
// failure with the Down pill, not Asleep.
mockStatus.desktop = "down";
mockStatus.screen = "unknown";
calls.length = 0;
await D.wake();
await sleep(6000);
check("D-j wake timeout with desktop down shows failure + Down pill",
  el("overlayTitle").textContent === "The desktop did not come up" && el("statusPill").textContent === "Down",
  `title=${el("overlayTitle").textContent} pill=${el("statusPill").textContent}`);

// --- Rakazo port (2026-11-15): the screen frame stays mounted -------
// State here (after D-j): computer qa (from D-f), one view frame mounted
// by the D-f mode switch, no lease, frame never reported connected.
const wrapEl = el("screenWrap");
const liveFrames = () => wrapEl.children.filter((c) => !c._removed);

// (R1a) A tab switch does not remount the frame.
const frameBefore = liveFrames()[0];
D.setTab("terminal");
await sleep(50);
D.setTab("screen");
await sleep(50);
check("R1a tab switch keeps the same frame mounted (no remount)",
  !!frameBefore && liveFrames()[0] === frameBefore,
  `before=${!!frameBefore} same=${liveFrames()[0] === frameBefore}`);

// (R1b/R2/R6a) Take control: the old view frame stays mounted as the
// held predecessor while the new control frame loads — no blank, no
// overlay. On "connected" the held frame drops.
await D.takeControl();
await sleep(150);
check("R1b take control keeps a frame visible (held predecessor) and shows no overlay",
  D.state.frameCount >= 1 && D.state.heldFramePresent === true && D.state.overlayShown === false,
  `state=${JSON.stringify(D.state)}`);
check("R2 held frame present during the view->control swap",
  D.state.heldFramePresent === true, `state=${JSON.stringify(D.state)}`);
D.screenState("connected");
check("R6a held frame dropped once the new frame reports connected",
  D.state.heldFramePresent === false && D.state.frameCount === 1 && D.state.overlayShown === false,
  `state=${JSON.stringify(D.state)}`);
// Release: same — the old control frame is held while the view frame loads.
await D.releaseControl(false);
await sleep(150);
check("R1c release keeps a frame visible and shows no overlay",
  D.state.frameCount >= 1 && D.state.heldFramePresent === true && D.state.overlayShown === false,
  `state=${JSON.stringify(D.state)}`);
D.screenState("connected");
await sleep(20);
check("R1d after release + connect, one frame, no overlay",
  D.state.frameCount === 1 && D.state.overlayShown === false, `state=${JSON.stringify(D.state)}`);

// (R3) Mount pre-probes the cheap probe URL — no full vnc.html fetch.
calls.length = 0;
await D.mountScreen("view");
await sleep(100);
check("R3 mount pre-probes ?qwenpaw_probe=1 (no full vnc.html fetch)",
  calls.some((c) => c.url.includes("qwenpaw_probe=1")) && !calls.some((c) => c.url.includes("/vnc.html")),
  `calls=${JSON.stringify(calls.map((c) => c.url))}`);

// (R4) "loading" with a frame mounted changes the pill only — the
// overlay never covers a mounted frame.
D.screenState("loading");
check("R4 'loading' with a frame mounted shows no overlay (pill only)",
  D.state.overlayShown === false && D.state.statusPill === "Connecting…",
  `state=${JSON.stringify(D.state)}`);

// (R5a) A drop before the frame ever connected errors immediately —
// no reconnect timer, no remount.
sandbox.QWENPAW_RECONNECT_DELAY_MS = 10;
calls.length = 0;
D.screenState("disconnected");
await sleep(150);
check("R5a drop before first connect -> error immediately, no retry",
  D.state.overlayTitle === "Screen not connected" && D.state.reconnectAttempts === 0 && !calls.some((c) => c.url.includes("/desktop/__screen")),
  `state=${JSON.stringify(D.state)} screenCalls=${calls.filter((c) => c.url.includes("/desktop/__screen")).length}`);

// (R5b) A drop AFTER the frame connected retries at most 3 times
// (1 s doubling), then errors and stops remounting.
await D.mountScreen("view");
await sleep(100);
D.screenState("connected");
for (let i = 0; i < 3; i++) {
  D.screenState("disconnected");
  await sleep(120); // the 10 ms reconnect timer fires a remount
  D.screenState("connected"); // the remounted frame connects
}
D.screenState("disconnected"); // 4th drop: the budget is spent
await sleep(50);
check("R5b drop after connect retries <=3 times, then errors",
  D.state.overlayTitle === "Screen not connected" && D.state.reconnectAttempts === 3,
  `state=${JSON.stringify(D.state)}`);
const screenCallsAfterError = calls.filter((c) => c.url.includes("/desktop/__screen")).length;
await sleep(150);
check("R5b2 no further remount after the budget is spent",
  calls.filter((c) => c.url.includes("/desktop/__screen")).length === screenCallsAfterError,
  `screenCalls=${calls.filter((c) => c.url.includes("/desktop/__screen")).length} before=${screenCallsAfterError}`);

// (R5c) A screen stable >= 5 s resets the trouble count.
await D.mountScreen("view");
await sleep(100);
D.screenState("connected");
D.screenState("disconnected"); // trouble 1 (stable window still 5 s: no reset yet)
await sleep(120); // remount
sandbox.QWENPAW_RECONNECT_STABLE_MS = 50; // shrink the stable window now
D.screenState("connected");
await sleep(120); // the 50 ms stable timer resets the count
D.screenState("disconnected"); // fresh trouble: 1 again, not 2
check("R5c stable 5 s resets the reconnect count",
  D.state.reconnectAttempts === 1,
  `state=${JSON.stringify(D.state)}`);
delete sandbox.QWENPAW_RECONNECT_STABLE_MS;
delete sandbox.QWENPAW_RECONNECT_DELAY_MS;

// (R6b) The held frame drops after the held timeout even without a
// connect report.
sandbox.QWENPAW_HELD_TIMEOUT_MS = 50;
await D.mountScreen("view");
await sleep(100);
await D.mountScreen("view");
await sleep(100);
check("R6b held frame drops after the held timeout",
  D.state.heldFramePresent === false && D.state.frameCount === 1,
  `state=${JSON.stringify(D.state)}`);
delete sandbox.QWENPAW_HELD_TIMEOUT_MS;

// --- T50–T57 chrome fixes -----------------------------------------------
// (T-a) A failed mode switch resets the select to the computer we are
// actually on (the label must not lie) and says why it failed. The
// computer here is "default" — D-h/D-i's init() reloaded the stored
// mode (team) from the server — so the failed switch targets Private.
mockModePostOk = false;
el("modeSelect").value = "private";
el("modeSelect").__fire("change");
await sleep(100);
check("T-a failed mode switch resets the select + honest toast, no remount",
  el("modeSelect").value === "team" && D.state.computer === "default" &&
  D.state.computerLabel === "Team Computer" &&
  el("toast").textContent.includes("Could not switch computer mode") &&
  el("toast").textContent.includes("store_unavailable"),
  `select=${el("modeSelect").value} computer=${D.state.computer} label=${D.state.computerLabel} toast=${el("toast").textContent}`);
mockModePostOk = true;
// ... and the switch works again once the store recovers (label flips too).
el("modeSelect").value = "private";
el("modeSelect").__fire("change");
await sleep(200);
check("T-a2 mode switch to Private succeeds + label flips",
  D.state.computer === "qa" && D.state.computerLabel === "Private Computer" && el("modeSelect").value === "private",
  `state=${JSON.stringify(D.state)} select=${el("modeSelect").value}`);

// (T-b) A 503 store_unavailable from __takeover surfaces the honest
// note instead of a bare "(500)".
mockTakeoverStatus = 503;
await D.takeControl();
await sleep(50);
check("T-b takeover 503 store_unavailable -> honest toast, no lease",
  D.state.leaseId === null && el("toast").textContent.includes("store"),
  `state=${JSON.stringify(D.state)} toast=${el("toast").textContent}`);
mockTakeoverStatus = 200;

// (T-c) Recover/Reset arm in-chrome (no window.confirm): first click
// arms, second click executes; the arm disarms itself after the window.
const recoverBtn = doc._menuButtons.find((b) => b.getAttribute("data-action") === "recover");
const actionCount = () => calls.filter((c) => c.url.includes("/desktop/__action")).length;
recoverBtn.textContent = "Recover computer";
calls.length = 0;
recoverBtn.__fire("click", {});
await sleep(30);
check("T-c1 first Recover click arms (no API call yet)",
  recoverBtn.textContent === "Confirm recover?" && actionCount() === 0,
  `text=${recoverBtn.textContent} actionCalls=${actionCount()}`);
recoverBtn.__fire("click", {});
await sleep(50);
check("T-c2 second Recover click executes the action",
  actionCount() === 1 && calls.some((c) => c.url.includes("/desktop/__action") && c.body && c.body.action === "recover"),
  `actionCalls=${actionCount()}`);
sandbox.QWENPAW_MENU_ARM_MS = 30;
recoverBtn.textContent = "Recover computer";
const beforeDisarm = actionCount();
recoverBtn.__fire("click", {});
await sleep(80);
check("T-c3 the arm disarms itself after the window (no execution)",
  recoverBtn.textContent === "Recover computer" && actionCount() === beforeDisarm,
  `text=${recoverBtn.textContent} before=${beforeDisarm} after=${actionCount()}`);
delete sandbox.QWENPAW_MENU_ARM_MS;

// (T-d) A 503 from __heartbeat keeps control (only 410 drops it).
sandbox.QWENPAW_HEARTBEAT_MS = 50;
mockHeartbeatStatus = 503;
await D.takeControl();
await sleep(250); // several 50 ms heartbeat ticks, all 503
check("T-d heartbeat 503 keeps control (lease + pill stay)",
  D.state.leaseId !== null && D.state.controlPillVisible === true,
  `state=${JSON.stringify(D.state)}`);
mockHeartbeatStatus = 200;
await sleep(120);
check("T-d2 heartbeat recovering keeps control too",
  D.state.leaseId !== null && D.state.controlPillVisible === true,
  `state=${JSON.stringify(D.state)}`);
await D.releaseControl(false);
delete sandbox.QWENPAW_HEARTBEAT_MS;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
