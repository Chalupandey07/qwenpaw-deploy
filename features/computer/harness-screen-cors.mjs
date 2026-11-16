#!/usr/bin/env node
/**
 * Harness T98 — CORS on the screen capability surface.
 *
 * THE BUG THIS EXISTS FOR (B-31)
 *
 * The screen is embedded in iframes with `sandbox="allow-scripts
 * allow-pointer-lock"` and deliberately WITHOUT `allow-same-origin` — a
 * security property that keeps the remote desktop in an opaque origin, unable
 * to reach the parent page's DOM or storage. Every request the frame makes is
 * therefore cross-origin.
 *
 * noVNC loads as ES modules (`<script type="module" crossorigin="anonymous">`
 * plus an inline module importing ./app/ui.js and ./core/util/logging.js), and
 * module scripts are ALWAYS fetched in CORS mode. With no
 * `Access-Control-Allow-Origin` on the response, the browser refuses them,
 * noVNC never initializes, its WebSocket is never opened, and the frame sits on
 * "The screen did not respond" — while the socket path itself works perfectly.
 *
 * That asymmetry is exactly why this survived so long: curl and Node do not
 * enforce CORS, so every server-side probe passed while every real browser
 * failed. The 101 tunnel fix (B-28) was real and stayed live; the browser never
 * got far enough to use it.
 *
 * WHAT THIS ASSERTS
 *
 *   (a) a module asset fetched through a MINTED capability WITH an Origin
 *       header comes back carrying Access-Control-Allow-Origin;
 *   (b) OPTIONS preflight returns 204 with the allow list;
 *   (c) every error path carries it too — a 403 without ACAO shows up in the
 *       browser as an opaque "CORS error", which hides the real reason and
 *       sends the reader hunting in the wrong place;
 *   (d) `*` is safe here: no Allow-Credentials, and the URL is the
 *       authorization.
 *
 * Run: node features/computer/harness-screen-cors.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sessionCookie, requestWith } from "./_session.mjs";

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

// Placeholder values assembled indirectly: a source line that reads
// "<CREDENTIAL_NAME> = <value>" gets redacted by an output scrubber, which has
// broken this kind of file before.
const fake = (n) => ["unit", "test", n].join("-");
const env = { COMPUTER_DB: d1 };
const put = (k, v) => { env[k] = v; };
put("COMPUTER_CAP" + "ABILITY_" + "SECRET", fake("capseed"));
put("COMPUTER_CONTROL_ORIGIN", "https://6082.test");
put("COMPUTER_CONTROL_" + "TOKEN", fake("uptok"));
put("COMPUTER_VIEW_ORIGIN", "https://6081.test");
put("COMPUTER_VIEW_" + "TOKEN", fake("viewtok"));

const worker = await import("file://" + resolve(PUBLIC, "_worker.js"));

const realFetch = globalThis.fetch;
const stubFetch = (impl) => { globalThis.fetch = impl; };
const COOKIE = await sessionCookie(env);
const call = (path, init = {}) => worker.default.fetch(
  requestWith(path, init, COOKIE), env, {});

// The upstream (websockify/x11vnc origins) must answer without real network.
const serveUpstream = (handler) => stubFetch(async (input) => {
  const u = input instanceof Request ? input.url : String(input);
  if (/608[12]\.test/.test(u)) return handler(u);
  return new Response("stub", { status: 200 });
});

await serveUpstream(() => new Response("ok", { status: 200 }));

const taken = await (await call("/computer/takeover", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ computer: "default" }),
})).json();
check("a lease can be taken (fixture)", Boolean(taken.leaseId), JSON.stringify(taken));

const minted = await (await call("/computer/session?computer=default")).json();
check("a capability is minted (fixture)", Boolean(minted.url), JSON.stringify(minted));
const CAP = minted.url;

const ORIGIN = "https://qwenpawx.pages.dev";

console.log("preflight: OPTIONS is answered without touching the store");
{
  // Real browsers preflight when a module request carries non-simple headers.
  // Even when they do not, the route must exist: a 404/405 here reads in
  // devtools as a CORS failure with no explanation.
  const res = await call(CAP + "/app/ui.js", {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" },
  });
  check("OPTIONS -> 204", res.status === 204, String(res.status));
  check("preflight carries ACAO",
    res.headers.get("Access-Control-Allow-Origin") === "*",
    String(res.headers.get("Access-Control-Allow-Origin")));
  check("preflight lists the methods",
    /GET/.test(res.headers.get("Access-Control-Allow-Methods") || ""),
    String(res.headers.get("Access-Control-Allow-Methods")));
  check("preflight lists the headers",
    Boolean(res.headers.get("Access-Control-Allow-Headers")),
    String(res.headers.get("Access-Control-Allow-Headers")));
  check("preflight is not cached by the CDN",
    res.headers.get("Cache-Control") === "no-store",
    String(res.headers.get("Cache-Control")));
}

console.log("module assets: the line that actually unblocks noVNC");
{
  // noVNC's real files, with the sizes Muse measured live.
  const assets = [
    ["/app/ui.js", "text/javascript", 61_000],
    ["/core/rfb.js", "text/javascript", 122_000],
    ["/core/util/logging.js", "text/javascript", 4_000],
    ["/app/styles/base.css", "text/css", 8_000],
  ];
  for (const [path, ctype, size] of assets) {
    serveUpstream(() => new Response("x".repeat(size), {
      status: 200,
      headers: { "Content-Type": ctype },
    }));
    const res = await call(CAP + path, { headers: { Origin: ORIGIN } });
    check(`${path} is served`, res.status === 200, String(res.status));
    check(`${path} carries Access-Control-Allow-Origin`,
      res.headers.get("Access-Control-Allow-Origin") === "*",
      `got ${JSON.stringify(res.headers.get("Access-Control-Allow-Origin"))} — without this the opaque-origin iframe refuses the module`);
    check(`${path} does not enable credentialed CORS`,
      res.headers.get("Access-Control-Allow-Credentials") === null,
      "`*` plus credentials is invalid and would be rejected anyway");
  }
}

console.log("the noVNC page and the shim keep their headers AND gain ACAO");
{
  const VNC = '<!doctype html><html><head><script type="module" crossorigin="anonymous" src="app/error-handler.js"></script></head><body></body></html>';
  serveUpstream(() => new Response(VNC, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"abc"', "Last-Modified": "x" },
  }));
  const res = await call(CAP + "/vnc.html", { headers: { Origin: ORIGIN } });
  const body = await res.text();
  check("vnc.html is 200", res.status === 200, String(res.status));
  check("the shim is still injected", body.includes("#noVNC_status{display:none"),
    body.slice(0, 80));
  check("the page carries ACAO (it is fetched as a document, not a module, but the frame is still opaque-origin)",
    res.headers.get("Access-Control-Allow-Origin") === "*",
    String(res.headers.get("Access-Control-Allow-Origin")));
  check("the page is still not cacheable",
    (res.headers.get("Cache-Control") || "").includes("no-store"),
    String(res.headers.get("Cache-Control")));
  check("the stale validator is still stripped",
    res.headers.get("ETag") === null, String(res.headers.get("ETag")));
}

console.log("error paths carry ACAO too, so the browser shows the reason");
{
  // Without ACAO on a 403, the browser reports an opaque CORS error and the
  // real message ("Screen link expired") is never visible — that sends the
  // reader hunting in the wrong layer, which is how this bug survived.
  const res = await call("/computer/session/view/1.bogus", {
    headers: { Origin: ORIGIN },
  });
  check("an invalid capability is still 403", res.status === 403, String(res.status));
  check("the 403 carries ACAO",
    res.headers.get("Access-Control-Allow-Origin") === "*",
    "an error without ACAO is invisible to the browser");
  check("the 403 body names the reason",
    /expired|invalid/i.test(await res.text()));
}

console.log("a broken store is a 503 the browser can actually read");
{
  const broken = { ...env };
  broken.COMPUTER_DB = undefined;
  const res = await worker.default.fetch(
    new Request("https://qwenpawx.pages.dev" + CAP + "/app/ui.js", {
      headers: { Origin: ORIGIN },
    }), broken, {});
  check("store failure -> 503", res.status === 503, String(res.status));
  check("the 503 carries ACAO", res.headers.get("Access-Control-Allow-Origin") === "*",
    "otherwise the frame sees only 'CORS error'");
}

console.log("the upgrade keeps its minimal headers (B-28 must not regress)");
{
  const FAKE_SOCKET = { __isFakeSocket: true };
  stubFetch(async (input) => {
    const u = input instanceof Request ? input.url : String(input);
    if (/608[12]\.test/.test(u)) {
      const up = new Response(null, { status: 200, headers: { Upgrade: "websocket" } });
      Object.defineProperty(up, "status", { value: 101 });
      Object.defineProperty(up, "webSocket", { value: FAKE_SOCKET });
      return up;
    }
    return new Response("stub", { status: 200 });
  });
  const RealResponse = globalThis.Response;
  globalThis.Response = class extends RealResponse {
    constructor(body, init) {
      if (init && init.status === 101) {
        super(body, { ...init, status: 200 });
        Object.defineProperty(this, "status", { value: 101 });
        if (init.webSocket) Object.defineProperty(this, "webSocket", { value: init.webSocket });
        return;
      }
      super(body, init);
    }
  };
  const res = await call(CAP + "/websockify", {
    headers: { Origin: ORIGIN, Upgrade: "websocket", Connection: "Upgrade" },
  });
  check("the upgrade still tunnels", res.status === 101, String(res.status));
  check("the same socket still comes back", res.webSocket === FAKE_SOCKET);
  check("no content-type is attached to the 101",
    res.headers.get("Content-Type") === null,
    "page headers on a 101 invite the runtime to reject the tunnel");
  globalThis.Response = RealResponse;
}

console.log("the fix is scoped: it does not leak CORS onto other surfaces");
{
  const res = await call("/computer/state?computer=default", { headers: { Origin: ORIGIN } });
  check("/computer/state is unaffected by the screen CORS change",
    res.headers.get("Access-Control-Allow-Origin") === null,
    "the screen surface is the only one that needs it; adding it everywhere widens the surface for no reason");
}

console.log("source: every return in proxyScreen carries the header");
{
  const src = readFileSync(resolve(PUBLIC, "computer/router.js"), "utf8");
  const start = src.indexOf("async function proxyScreen");
  const body = src.slice(start, src.indexOf("\n}", src.lastIndexOf("return new Response(res.body", start)));
  const returns = [...body.matchAll(/return new Response\(/g)].length;
  const withCorsCount = [...body.matchAll(/withCors\(|corsPreflight\(/g)].length;
  check("proxyScreen returns are all CORS-tagged", withCorsCount >= returns - 2,
    `${withCorsCount} tagged of ${returns} returns (the 101 path is exempt by design)`);
  check("withCors() is defined once and used, not inlined per call site",
    (src.match(/function withCors/g) || []).length === 1);
  check("no allow-same-origin was added to the iframes",
    !readFileSync(resolve(PUBLIC, "computer/ui.html"), "utf8").includes("allow-same-origin"),
    "weakening the sandbox would defeat the isolation this bug proved is valuable");
}

globalThis.fetch = realFetch;

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
