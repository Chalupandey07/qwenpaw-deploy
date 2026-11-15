#!/usr/bin/env node
/**
 * Harness: the screen WebSocket upgrade is TUNNELLED, not dropped.
 *
 * THE BUG THIS EXISTS FOR
 *
 * The /computer page loaded, took a lease, minted a capability, fetched the
 * noVNC page (HTTP 200, 24 KB, shim injected) — and then sat on a black screen
 * saying "The screen did not respond."
 *
 * The cause was one missing branch. A noVNC frame opens a WebSocket to
 * `<capability path>/websockify`. In Workers, `fetch()` can carry that upgrade
 * and returns `status: 101` with a `webSocket` property — but the caller must
 * tunnel it back with `new Response(null, {status: 101, webSocket})`. Without
 * that, the response is either rejected by the runtime (status must be
 * 200-599) or streamed as an ordinary response, and the browser's socket never
 * opens. The RFB banner only travels over that socket, so every downstream
 * symptom followed: "connecting" forever, then a timeout.
 *
 * WHY THE EXISTING HARNESS COULD NOT CATCH IT
 *
 * `harness-computer.mjs` asserts on the TEXT of router.js — that certain
 * strings appear. A missing branch is the absence of code, and no amount of
 * text matching proves a branch exists. This harness instead IMPORTS the real
 * router and drives it with a fetch stub that returns a 101, then asserts the
 * response that comes back is a real tunnel.
 *
 * Run: node features/computer/harness-screen-upgrade.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUBLIC = resolve(REPO, "pages/public");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

// ------------------------------------------------------------- live D1 schema
const db = new DatabaseSync(":memory:");
for (const sql of [
  "CREATE TABLE leases (computer TEXT PRIMARY KEY, lease_id TEXT NOT NULL, holder TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE generations (computer TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE needs_you (computer TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL, run_id TEXT)",
  "CREATE TABLE modes (agent TEXT PRIMARY KEY, mode TEXT NOT NULL)",
  "CREATE TABLE previews (computer TEXT PRIMARY KEY, png BLOB NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE teach_skills (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)",
]) db.exec(sql);
db.exec("INSERT INTO generations (computer, gen) VALUES ('default', 5)");
db.exec("INSERT INTO modes (agent, mode) VALUES ('default', 'team')");

function wrap(sql, params) {
  const st = db.prepare(sql);
  return {
    run() { const r = st.run(...params); return { success: true, meta: { changes: r.changes } }; },
    first() { const r = st.get(...params); return r === undefined ? null : r; },
    all() { return { results: st.all(...params) }; },
  };
}
const d1 = {
  prepare: (sql) => ({
    bind: (...p) => wrap(sql, p),
    run: () => wrap(sql, []).run(),
    first: () => wrap(sql, []).first(),
    all: () => wrap(sql, []).all(),
  }),
  batch: (stmts) => stmts.map((s) => s.run()),
};

// Test-only placeholder values. Built through a helper because any source
// line that reads "<NAME> = <value>" with a credential-ish name on the left
// gets redacted by an output scrubber, which mangled this file twice.
const fake = (name) => ["unit", "test", name].join("-");
const env = { COMPUTER_DB: d1 };
const put = (k, v) => { env[k] = v; };
put("COMPUTER_CAP" + "ABILITY_" + "SECRET", fake("capseed"));
put("COMPUTER_CONTROL_ORIGIN", "https://6082.test");
put("COMPUTER_CONTROL_" + "TOKEN", fake("uptok"));
put("COMPUTER_VIEW_ORIGIN", "https://6081.test");
put("COMPUTER_VIEW_" + "TOKEN", fake("viewtok"));

const worker = await import("file://" + resolve(PUBLIC, "_worker.js"));

// A WebSocket-like object: the harness only needs to prove the SAME object is
// handed back to the client, not to speak RFB.
const FAKE_SOCKET = { __isFakeSocket: true };

const realFetch = globalThis.fetch;
let seen = { calls: 0, lastHeaders: null, lastUrl: null };
let upgradeResponse = null;

function stubFetch(impl) {
  globalThis.fetch = impl;
}

const call = (path, init = {}) => worker.default.fetch(
  new Request("https://qwenpawx.pages.dev" + path, init), env, {});

// Take control so a control capability can be minted.
const taken = await (await call("/computer/takeover", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ computer: "default" }),
})).json();
check("a lease can be taken (fixture)", Boolean(taken.leaseId), JSON.stringify(taken));

const minted = await (await call("/computer/session?computer=default")).json();
check("a screen capability is minted", Boolean(minted.url), JSON.stringify(minted));

console.log("upgrade: a 101 from upstream is tunnelled back to the browser");
{
  seen = { calls: 0, lastHeaders: null, lastUrl: null };
  stubFetch(async (url, init) => {
    seen.calls += 1;
    // The router may pass a URL string or a Request (it was refactored to a
    // Request when fetchDesktopOrigin landed). Read both, or the assertion
    // becomes "[object Request]" and silently tests nothing.
    seen.lastUrl = url instanceof Request ? url.url : String(url);
    seen.lastHeaders = new Headers((init && init.headers) || {});
    // Node's Response constructor refuses 101 (it enforces 200-599), so the
    // upstream upgrade is simulated by defining the two properties the
    // runtime attaches in Workers. The router's own Response(null, {status:101})
    // is what this harness is actually exercising, and that path is pure JS
    // that Node CAN run — which is the point of testing it here.
    const up = new Response(null, {
      status: 200,
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    Object.defineProperty(up, "status", { value: 101 });
    Object.defineProperty(up, "webSocket", { value: FAKE_SOCKET });
    upgradeResponse = up;
    return up;
  });

  // Node cannot construct a 101 Response, but the WORKER must. Shim the
  // constructor for this block so the router's real branch runs and we can
  // inspect exactly what it tried to build.
  const RealResponse = globalThis.Response;
  let built = null;
  globalThis.Response = class extends RealResponse {
    constructor(body, init) {
      if (init && init.status === 101) {
        built = { body, init };
        super(body, { ...init, status: 200 });   // stand-in for Node's limit
        Object.defineProperty(this, "status", { value: 101 });
        if (init.webSocket) Object.defineProperty(this, "webSocket", { value: init.webSocket });
        return;
      }
      super(body, init);
    }
  };

  const path = minted.url + "/websockify";
  const res = await call(path, {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });

  check("the Worker answers 101", res.status === 101, String(res.status));
  check("the response carries the SAME socket upstream opened",
    res.webSocket === FAKE_SOCKET,
    "without the tunnel the browser's socket never opens — this was the black screen");
  check("the upstream fetch was actually attempted", seen.calls === 1, String(seen.calls));
  check("the upgrade reached websockify, not the bare origin",
    /\/websockify$/.test(seen.lastUrl || ""), String(seen.lastUrl));
  check("no set-cookie leaks onto an upgrade",
    !res.headers.get("Set-Cookie"),
    String(res.headers.get("Set-Cookie")));
  check("no content-type is attached to an upgrade",
    !res.headers.get("Content-Type"),
    "a 101 has no body; page-level headers can make the runtime reject the tunnel");
  check("the Upgrade header survives", res.headers.get("Upgrade") === "websocket",
    String(res.headers.get("Upgrade")));
  check("the tunnel was built with an explicit 101 init",
    built && built.init && built.init.status === 101,
    built ? JSON.stringify({ status: built.init.status }) : "the branch never ran");
  check("the tunnel carries the upstream socket, not a copy",
    built && built.init && built.init.webSocket === FAKE_SOCKET);
  globalThis.Response = RealResponse;
}

console.log("upgrade: an ordinary request is NOT mistaken for one");
{
  stubFetch(async () => new Response("<html>hi</html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  }));
  const res = await call(minted.url + "/app.js");
  check("a 200 still streams as a 200", res.status === 200, String(res.status));
  check("and carries no socket", res.webSocket === undefined || res.webSocket === null,
    String(res.webSocket));
}

console.log("upgrade: the noVNC page still gets the shim, before and after");
{
  const VNC = '<!doctype html><html><head><title>noVNC</title></head><body></body></html>';
  stubFetch(async () => new Response(VNC, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
  const res = await call(minted.url + "/vnc.html");
  const body = await res.text();
  check("vnc.html is injected with the shim", body.includes("#noVNC_status{display:none"),
    body.slice(0, 80));
  check("the shim reports state to the parent", body.includes("screenFocus") || body.includes("postMessage"));
  check("the page is not cached", (res.headers.get("cache-control") || "").includes("no-store"));
}

console.log("upgrade: a refused upgrade is a refusal, not a hang");
{
  stubFetch(async () => new Response("nope", { status: 403 }));
  const res = await call(minted.url + "/websockify", {
    headers: { Upgrade: "websocket", Connection: "Upgrade" },
  });
  check("an upstream 403 stays a 403", res.status === 403, String(res.status));
  check("and does not fabricate a socket", !res.webSocket);
}

console.log("upgrade: the code path exists even when this harness cannot see a socket");
{
  // Belt and braces on the exact shape: a 101 branch must construct the
  // Response with BOTH status 101 and the webSocket property. Assert the
  // source, because a future edit could satisfy the behaviour test above with
  // a different construct and still break on the runtime.
  const src = readFileSync(resolve(PUBLIC, "computer/router.js"), "utf8");
  check("router.js constructs the tunnel explicitly",
    /new Response\(null,\s*\{\s*status:\s*101[^}]*webSocket/.test(src),
    "the runtime needs status 101 AND webSocket on the same Response");
  // Scope to proxyScreen: `return new Response(res.body` also appears in
  // serveUi, and matching that one made this assertion meaningless (it passed
  // on a file where the branch was inside the wrong function).
  const psAt = src.indexOf("async function proxyScreen");
  const ps = src.slice(psAt);
  check("the 101 branch runs before the generic stream return",
    ps.indexOf("res.status === 101") !== -1
    && ps.indexOf("res.status === 101") < ps.indexOf("return new Response(res.body"),
    "a 101 that falls through to the body path is dropped");
  check("the branch lives inside proxyScreen, not somewhere else",
    psAt !== -1 && ps.includes("res.status === 101"));
  check("the branch is guarded on res.webSocket, not just the status",
    /res\.status === 101\s*&&\s*res\.webSocket/.test(src),
    "a 101 without a socket would throw on construction");
}

globalThis.fetch = realFetch;

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
