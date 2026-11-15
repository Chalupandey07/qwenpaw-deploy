// Local harness for the /desktop gate + Rakazo-style lease/capability in
// pages/public/_worker.js. Run: node features/desktop/harness-desktop-gate.mjs
// Mocks the origin (QwenPaw healthz + noVNC + keep-alive) and exercises the
// worker's fetch handler. NOT deployed — test-only.
// Coverage: P0/P1 gate + lease + sealed capability (tests 1-21), plus the
// P3 extension — per-computer lease (22-24), needs-you (25), preview
// (26), teach-by-showing (27), Team/Private mode (28), terminal (29),
// console side-panel injection (30), vendor files (31).
import { createHmac } from "node:crypto";

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const DESKTOP_ORIGIN = "https://6081-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const DESKTOP_VIEW_ORIGIN = "https://6082-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const DESKTOP_TERMINAL_ORIGIN = "https://6083-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const DESKTOP_QA_VIEW_ORIGIN = "https://6084-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const DESKTOP_QA_ORIGIN = "https://6085-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const KEEPALIVE_URL = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev";
const TEST_SECRET = "test-desktop-secret";
const TEST_VIEW_SECRET = "test-view-secret";
const TEST_SYNC_SECRET = "test-sync-secret";
const TEST_TERMINAL_SECRET = "test-terminal-secret";
const TEST_QA_VIEW_SECRET = "test-qa-view-secret";
const TEST_QA_SECRET = "test-qa-secret";

// Mock KV (DESKTOP_KV binding). failGetKeys makes get() throw for those
// keys (test 34: a KV error must be a retryable 502, not a false 403).
// failPutKeys / failDeleteKeys make put()/delete() throw (tests 40: a KV
// WRITE failure — e.g. the free tier's 1,000 writes/day spent, error
// 10048 — must be an honest 503 store_unavailable, never a bare 500).
class MockKV {
  constructor() { this.map = new Map(); this.failGetKeys = new Set(); this.failPutKeys = new Set(); this.failDeleteKeys = new Set(); this.failAllPuts = false; }
  async get(k, type) {
    if (this.failGetKeys.has(k)) throw new Error("mock KV failure for " + k);
    const v = this.map.get(k);
    if (v === undefined) return null;
    if (type === "json") { try { return JSON.parse(v); } catch { return null; } }
    return v;
  }
  async put(k, v) {
    if (this.failAllPuts || this.failPutKeys.has(k)) throw new Error("mock KV write failure for " + k);
    this.map.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  async delete(k) {
    if (this.failDeleteKeys.has(k)) throw new Error("mock KV delete failure for " + k);
    this.map.delete(k);
  }
  async list({ prefix } = {}) {
    const keys = [];
    for (const k of this.map.keys()) {
      if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
    }
    return { keys };
  }
}

// Mock origin: healthz 200 only for the good token, 401 otherwise;
// noVNC serves vnc.html; console root serves the SPA.
// The desktop origins simulate the InstaBox private-port proxy exactly:
//  - a request WITH ?_token= gets 303 + Set-Cookie __Host-instabox_port_auth
//    and a relative Location with the token stripped;
//  - a request WITH that auth cookie (no token) gets 200;
//  - anything else gets 401.
// `seen` records every desktop-origin request for the tests to assert on.
// mockFailOrigins: every fetch to that origin throws (a dead origin).
// mockFailOnceOrigins: the first fetch to that origin throws, then it
// recovers (a transient blip — the Worker's retry must absorb it).
// apiCalls records calls to the InstaBox API (test 35: __wake start).
const seen = [];
const apiCalls = [];
const mockFailOrigins = new Set();
const mockFailOnceOrigins = new Set();

// Fake upstream WebSocket for the screen (RFB banner) probe: fires the
// VNC server's "RFB 003.008" banner once accept() is called. mockSlowRfbMs
// delays the banner (test 40j: the probe must wait 10 s, not 3 s — a
// banner at 4 s is live under the new budget, unreachable under the old).
let mockSlowRfbMs = 0;
function fakeRfbSocket() {
  const listeners = {};
  return {
    readyState: 1,
    accept() { setTimeout(() => { (listeners.message || []).forEach((fn) => fn({ data: "RFB 003.008\n" })); }, mockSlowRfbMs); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    close() {},
  };
}

// The real InstaBox proxy honors the FIRST __Host-instabox_port_auth
// cookie when several are sent (per-port cookie, first wins). The mock
// must do the same, or a stale cookie forwarded first would look
// harmless here while 401ing in production (fix round 2).
function firstProxyCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k === "__Host-instabox_port_auth") return rest.join("=");
  }
  return null;
}

// Keep-alive /status answer (test 38 flips it to "cooldown").
let mockKeepaliveStatus = "up";

globalThis.fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = req.url;
  if (url.startsWith("https://api.instabox.sh/v1/machines/")) {
    let bodyText = "";
    try { bodyText = await req.text(); } catch { /* ignore */ }
    apiCalls.push({ url, method: req.method, body: bodyText });
    return new Response(JSON.stringify({ state: "running", controller: "agent", width: 1920, height: 1080 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.startsWith(ORIGIN + "/api/healthz")) {
    const auth = req.headers.get("Authorization") || "";
    return new Response(JSON.stringify({ status: "ok" }), {
      status: auth === "Bearer good-token" ? 200 : 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.startsWith(DESKTOP_ORIGIN) || url.startsWith(DESKTOP_VIEW_ORIGIN) || url.startsWith(DESKTOP_TERMINAL_ORIGIN) || url.startsWith(DESKTOP_QA_VIEW_ORIGIN) || url.startsWith(DESKTOP_QA_ORIGIN)) {
    const u = new URL(url);
    const cookie = req.headers.get("Cookie") || "";
    seen.push({ origin: u.origin, path: u.pathname, hadToken: u.searchParams.has("_token"), hadAuth: cookie.includes("__Host-instabox_port_auth=test-auth"), upgrade: req.headers.get("Upgrade") || "", protocol: req.headers.get("Sec-WebSocket-Protocol") || "" });
    if (mockFailOnceOrigins.has(u.origin)) { mockFailOnceOrigins.delete(u.origin); throw new Error("mock transient failure for " + u.origin); }
    if (mockFailOrigins.has(u.origin)) { throw new Error("mock failure for " + u.origin); }
    if (u.pathname === "/foreign-redirect") {
      return new Response("", { status: 302, headers: { Location: "https://evil.example/x" } });
    }
    if (u.searchParams.has("_token")) {
      u.searchParams.delete("_token");
      const loc = u.pathname + (u.search ? u.search : "");
      return new Response("", { status: 303, headers: { Location: loc, "Set-Cookie": "__Host-instabox_port_auth=test-auth; Path=/; Secure; HttpOnly" } });
    }
    // WebSocket upgrade to /websockify with a valid proxy cookie: the VNC
    // backend answers 101 and sends the RFB banner (fakeRfbSocket).
    // NOTE: a 101 cannot be built with `new Response(null, {status: 101})`
    // (Node rejects statuses outside 200-599), so this returns a plain
    // object with the fields the Worker reads: status, headers, webSocket.
    if (req.headers.get("Upgrade") === "websocket" && u.pathname === "/websockify" && firstProxyCookie(cookie) === "test-auth") {
      return { status: 101, headers: new Headers(), webSocket: fakeRfbSocket() };
    }
    if (firstProxyCookie(cookie) === "test-auth") {
      const isJs = u.pathname.endsWith(".js");
      const isVnc = u.pathname.endsWith("vnc.html");
      return new Response(isJs ? "ui.js content" : isVnc ? "<html><head></head><body>vnc</body></html>" : "<html>vnc</html>", {
        status: 200,
        headers: { "Content-Type": isJs ? "text/javascript" : "text/html; charset=utf-8" },
      });
    }
    return new Response("unauthorized", { status: 401 });
  }
  if (url.startsWith(KEEPALIVE_URL + "/status")) {
    return new Response(JSON.stringify({ status: mockKeepaliveStatus }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.startsWith(KEEPALIVE_URL + "/ping")) {
    return new Response(JSON.stringify({ status: "up" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.startsWith(ORIGIN + "/")) {
    // The console SPA index (marker <div id="root") so the side-panel
    // injection test can run; API JSON is a separate branch below.
    if (url === ORIGIN + "/" || url === ORIGIN + "/chat") {
      return new Response("<html><head><title>QwenPaw Console</title></head><body><div id=\"root\"></div>console spa</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
};

const worker = (await import("../../pages/public/_worker.js")).default;
const kv = new MockKV();
const env = {
  DESKTOP_ORIGIN_TOKEN: TEST_SECRET,
  DESKTOP_VIEW_TOKEN: TEST_VIEW_SECRET,
  DESKTOP_TERMINAL_TOKEN: TEST_TERMINAL_SECRET,
  DESKTOP_QA_VIEW_TOKEN: TEST_QA_VIEW_SECRET,
  DESKTOP_QA_ORIGIN_TOKEN: TEST_QA_SECRET,
  DESKTOP_SYNC_TOKEN: TEST_SYNC_SECRET,
  DESKTOP_KV: kv,
  ASSETS: {
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/desktop-chrome.html") {
        return new Response("<html>QwenPaw's computer chrome</html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (u.pathname === "/status-page.html") {
        return new Response("<html>status</html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (u.pathname === "/vendor/xterm.js") {
        return new Response("/* xterm.js stub */", { status: 200, headers: { "Content-Type": "text/javascript" } });
      }
      if (u.pathname === "/vendor/xterm.css") {
        return new Response("/* xterm.css stub */", { status: 200, headers: { "Content-Type": "text/css" } });
      }
      return new Response("asset not found", { status: 404 });
    },
  },
};

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
async function call(path, opts = {}) {
  const req = new Request("https://qwenpawx.pages.dev" + path, opts);
  return worker.fetch(req, env, {});
}

const hmac = (exp) =>
  createHmac("sha256", TEST_SECRET).update("desktop:" + exp).digest("hex");

// 1. No cookie -> gate page, 200, contains the verify flow.
let r = await call("/desktop");
let body = await r.text();
check("1 logged-out /desktop serves gate page", r.status === 200 && body.includes("/desktop/__verify") && body.includes("Checking your QwenPaw login"), `status=${r.status}`);

// 2. No secret configured -> 503.
r = await worker.fetch(new Request("https://qwenpawx.pages.dev/desktop"), {});
check("2 no DESKTOP_ORIGIN_TOKEN -> 503", r.status === 503, `status=${r.status}`);

// 3. __verify with a bad token -> 401, no cookie.
r = await call("/desktop/__verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "bogus-token-1234567890" }) });
check("3 __verify bad token -> 401", r.status === 401 && !r.headers.get("Set-Cookie"), `status=${r.status}`);

// 4. __verify with a good token -> 200 + valid HMAC cookie.
r = await call("/desktop/__verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "good-token" }) });
const setCookie = r.headers.get("Set-Cookie") || "";
const m = setCookie.match(/qwenpaw_desktop=(\d+)\.([0-9a-f]{64})/);
const cookieOk = r.status === 200 && !!m && m[2] === hmac(m[1]) && setCookie.includes("HttpOnly") && setCookie.includes("Path=/desktop");
check("4 __verify good token -> 200 + valid HMAC cookie", cookieOk, `status=${r.status} cookie=${setCookie.slice(0, 60)}`);
const goodCookie = m ? `qwenpaw_desktop=${m[1]}.${m[2]}` : "";
const cookieHdr = { Cookie: goodCookie };

// 5. /desktop with the minted cookie -> 200 chrome page (was 302 vnc.html).
r = await call("/desktop", { headers: cookieHdr });
check("5 /desktop with valid cookie -> 200 chrome page", r.status === 200 && (await r.text()).includes("QwenPaw's computer"), `status=${r.status}`);

// 6. Forged cookie -> gate page again.
const forgedExp = String(Math.floor(Date.now() / 1000) + 3600);
r = await call("/desktop", { headers: { Cookie: `qwenpaw_desktop=${forgedExp}.${"0".repeat(64)}` } });
check("6 forged cookie -> gate page", r.status === 200 && (await r.text()).includes("/desktop/__verify"), `status=${r.status}`);

// 7. Expired cookie -> gate page again.
const expExp = String(Math.floor(Date.now() / 1000) - 10);
r = await call("/desktop", { headers: { Cookie: `qwenpaw_desktop=${expExp}.${hmac(expExp)}` } });
check("7 expired cookie -> gate page", r.status === 200 && (await r.text()).includes("/desktop/__verify"), `status=${r.status}`);

// 8. Legacy direct /desktop/vnc.html (valid cookie) -> 302 to the chrome
// (the old bypass is closed; the chrome + session capability is the only entry).
r = await call("/desktop/vnc.html", { headers: cookieHdr });
check("8 legacy /desktop/vnc.html -> 302 to /desktop", r.status === 302 && (r.headers.get("Location") || "").endsWith("/desktop"), `status=${r.status} loc=${r.headers.get("Location")}`);

// 9. __verify bad JSON -> 400; GET __verify -> 405.
r = await call("/desktop/__verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
check("9a __verify bad JSON -> 400", r.status === 400, `status=${r.status}`);
r = await call("/desktop/__verify", { method: "GET" });
check("9b __verify GET -> 405", r.status === 405, `status=${r.status}`);

// 10. Console root still proxies fine (no regression).
r = await call("/");
check("10 console / still proxies 200", r.status === 200 && (await r.text()).includes("console spa"), `status=${r.status}`);

// 11. __lease is public: no lease yet -> holder agent.
r = await call("/desktop/__lease");
let j = await r.json();
check("11 __lease public, no lease -> holder agent", r.status === 200 && j.holder === "agent" && j.generation === 0, `status=${r.status} body=${JSON.stringify(j)}`);

// 12. __takeover grants a lease; a second takeover is refused (409 held).
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: "{}" });
j = await r.json();
const leaseId = j.leaseId;
check("12a __takeover -> 200 + leaseId + 90s expiry", r.status === 200 && !!leaseId && j.expiresAt > Date.now() && j.expiresAt <= Date.now() + 91000, `status=${r.status} body=${JSON.stringify(j)}`);
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: "{}" });
check("12b second __takeover -> 409 held", r.status === 409 && (await r.json()).error === "held", `status=${r.status}`);
r = await call("/desktop/__lease");
j = await r.json();
check("12c __lease now shows holder user + same leaseId", j.holder === "user" && j.leaseId === leaseId, `body=${JSON.stringify(j)}`);

// 13. __heartbeat extends with the right leaseId; wrong leaseId -> 410.
const before = (await kv.get("lease:default", "json")).expiresAt;
await new Promise((res) => setTimeout(res, 5));
r = await call("/desktop/__heartbeat", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId }) });
j = await r.json();
check("13a __heartbeat right leaseId -> 200 + extended expiry", r.status === 200 && j.expiresAt >= before, `status=${r.status} body=${JSON.stringify(j)}`);
r = await call("/desktop/__heartbeat", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: "00000000-0000-0000-0000-000000000000" }) });
check("13b __heartbeat wrong leaseId -> 410", r.status === 410, `status=${r.status}`);

// 14. __screen view mints a capability; the session view path proxies
// vnc.html WITH the shim injected; assets flow through the 303 dance.
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "view" }) });
j = await r.json();
const viewCap = j.url;
check("14a __screen view -> 200 + /desktop/session/view/ URL", r.status === 200 && typeof viewCap === "string" && viewCap.startsWith("/desktop/session/view/"), `status=${r.status} url=${viewCap}`);
seen.length = 0;
r = await call(viewCap + "/vnc.html", { headers: cookieHdr });
body = await r.text();
check("14b session view vnc.html -> 200 via 303-follow + shim injected",
  r.status === 200 && body.includes("__QWENPAW_DESKTOP_MODE") && body.includes('"view"') && body.includes("qwenpawScreen") && !r.headers.get("Location"),
  `status=${r.status} loc=${r.headers.get("Location")}`);
check("14c view shim hides the control bar", body.includes("noVNC_control_bar_anchor"), "shim missing control-bar hide");
check("14d view fetch went to the VIEW origin (6082), token only as 401 fallback",
  seen.some((s) => s.origin === DESKTOP_VIEW_ORIGIN) && !seen.some((s) => s.origin === DESKTOP_ORIGIN),
  `seen=${JSON.stringify(seen)}`);
seen.length = 0;
r = await call(viewCap + "/app/ui.js", { headers: cookieHdr });
check("14e session view asset -> 200 via 303-follow, no Location",
  r.status === 200 && (await r.text()).includes("ui.js content") && !r.headers.get("Location"),
  `status=${r.status} loc=${r.headers.get("Location")}`);

// 15. __screen control without a lease -> 403; with the lease -> 200;
// the session control path proxies to the INTERACTIVE origin (6081).
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "control", leaseId: "00000000-0000-0000-0000-000000000000" }) });
check("15a __screen control with wrong leaseId -> 403", r.status === 403, `status=${r.status}`);
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "control", leaseId }) });
j = await r.json();
const controlCap = j.url;
check("15b __screen control with lease -> 200 + control URL", r.status === 200 && typeof controlCap === "string" && controlCap.startsWith("/desktop/session/control/"), `status=${r.status} url=${controlCap}`);
seen.length = 0;
r = await call(controlCap + "/vnc.html", { headers: cookieHdr });
body = await r.text();
check("15c session control vnc.html -> 200 + shim, control bar NOT hidden",
  r.status === 200 && body.includes('"control"') && !body.includes("noVNC_control_bar_anchor"),
  `status=${r.status}`);
check("15d control fetch went to the INTERACTIVE origin (6081)",
  seen.some((s) => s.origin === DESKTOP_ORIGIN) && !seen.some((s) => s.origin === DESKTOP_VIEW_ORIGIN),
  `seen=${JSON.stringify(seen)}`);

// 16. Release names the lease: a stale release must not end newer control;
// the right release ends it and bumps the generation, killing old caps.
r = await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: "00000000-0000-0000-0000-000000000000" }) });
j = await r.json();
check("16a __release with wrong leaseId -> stale, lease survives", r.status === 200 && j.error === "stale" && (await kv.get("lease:default", "json"))?.leaseId === leaseId, `body=${JSON.stringify(j)}`);
const genBefore = await kv.get("generation:default");
r = await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId }) });
j = await r.json();
check("16b __release with right leaseId -> ok", r.status === 200 && j.released === true, `body=${JSON.stringify(j)}`);
check("16c generation bumped on release", Number(await kv.get("generation:default")) === Number(genBefore) + 1, `gen=${await kv.get("generation:default")} before=${genBefore}`);
r = await call("/desktop/__lease");
j = await r.json();
check("16d __lease after release -> holder agent", j.holder === "agent", `body=${JSON.stringify(j)}`);
r = await call(controlCap + "/vnc.html", { headers: cookieHdr });
check("16e old control capability -> 403 after generation bump", r.status === 403, `status=${r.status}`);
r = await call(viewCap + "/vnc.html", { headers: cookieHdr });
check("16f old view capability -> 403 after generation bump", r.status === 403, `status=${r.status}`);

// 17. Tampered capability -> 403.
const tampered = viewCap.slice(0, -2) + (viewCap.slice(-2, -1) === "A" ? "B" : "A") + viewCap.slice(-1);
r = await call(tampered + "/vnc.html", { headers: cookieHdr });
check("17 tampered capability -> 403", r.status === 403, `status=${r.status}`);

// 18. __status reports desktop up (mock view origin 200 + keep-alive up).
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("18 __status -> desktop up, machine up", r.status === 200 && j.desktop === "up" && j.machine === "up", `status=${r.status} body=${JSON.stringify(j)}`);

// 19. __wake works once, then throttles for 60 s.
r = await call("/desktop/__wake", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: "{}" });
check("19a __wake -> 200 ok", r.status === 200 && (await r.json()).ok === true, `status=${r.status}`);
r = await call("/desktop/__wake", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: "{}" });
j = await r.json();
check("19b second __wake within 60 s -> throttled", r.status === 200 && j.ok === false && j.error === "throttled", `status=${r.status} body=${JSON.stringify(j)}`);

// 20. __action without INSTABOX_API_KEY -> 503 with a clear error.
r = await call("/desktop/__action", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ action: "stop" }) });
j = await r.json();
check("20 __action stop, no API key -> 503 instabox_api_key_unset", r.status === 503 && j.error === "instabox_api_key_unset", `status=${r.status} body=${JSON.stringify(j)}`);

// 21. Foreign redirect from the origin is dropped on the session path too.
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "view" }) });
const viewCap2 = (await r.json()).url;
r = await call(viewCap2 + "/foreign-redirect", { headers: cookieHdr });
check("21 session foreign redirect dropped (no Location)", r.status === 302 && !r.headers.get("Location"), `status=${r.status} loc=${r.headers.get("Location")}`);

// --- Extension: per-computer lease, needs-you, preview, teach, mode,
// --- terminal, console injection, vendor files (P3) ----------------------
const syncHdr = { "X-Desktop-Sync": TEST_SYNC_SECRET };

// 22. Per-computer lease independence: a qa takeover does not touch the
// default lease, and vice versa; each computer has its own generation.
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "qa" }) });
j = await r.json();
const qaLeaseId = j.leaseId;
check("22a __takeover computer=qa -> 200 + leaseId", r.status === 200 && !!qaLeaseId, `status=${r.status} body=${JSON.stringify(j)}`);
r = await call("/desktop/__lease?computer=default");
j = await r.json();
check("22b default lease still free after qa takeover", j.holder === "agent" && j.leaseId === null, `body=${JSON.stringify(j)}`);
r = await call("/desktop/__lease?computer=qa");
j = await r.json();
check("22c qa lease shows holder user + qa leaseId", j.holder === "user" && j.leaseId === qaLeaseId, `body=${JSON.stringify(j)}`);
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "default" }) });
j = await r.json();
const defLeaseId = j.leaseId;
check("22d __takeover computer=default works while qa is held", r.status === 200 && !!defLeaseId && defLeaseId !== qaLeaseId, `status=${r.status}`);
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "qa" }) });
check("22e second qa takeover -> 409 held", r.status === 409, `status=${r.status}`);
check("22f generations are per-computer (qa bumped, default bumped once each)",
  Number(await kv.get("generation:qa")) === 1 && Number(await kv.get("generation:default")) >= 1,
  `gen:qa=${await kv.get("generation:qa")} gen:default=${await kv.get("generation:default")}`);

// 23. Per-computer heartbeat/release: a qa heartbeat must not extend the
// default lease, and a default release must not end the qa lease.
r = await call("/desktop/__heartbeat", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: qaLeaseId, computer: "qa" }) });
check("23a __heartbeat qa leaseId + computer=qa -> 200", r.status === 200 && (await r.json()).ok === true, `status=${r.status}`);
r = await call("/desktop/__heartbeat", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: qaLeaseId, computer: "default" }) });
check("23b __heartbeat qa leaseId + computer=default -> 410 (wrong computer)", r.status === 410, `status=${r.status}`);
r = await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: defLeaseId, computer: "default" }) });
j = await r.json();
check("23c __release default leaseId -> ok, qa lease survives", r.status === 200 && j.released === true && (await kv.get("lease:qa", "json"))?.leaseId === qaLeaseId, `body=${JSON.stringify(j)}`);
r = await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: qaLeaseId, computer: "qa" }) });
check("23d __release qa leaseId -> ok, qa lease gone", r.status === 200 && (await r.json()).released === true && (await kv.get("lease:qa", "json")) === null, `status=${r.status}`);

// 24. Per-computer screen capability: a qa control capability routes to
// the QA origins (6084 view / 6085 control), never the :1 origins.
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "qa" }) });
const qaLease2 = (await r.json()).leaseId;
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "control", leaseId: qaLease2, computer: "qa" }) });
j = await r.json();
const qaControlCap = j.url;
check("24a __screen control computer=qa -> 200 + control URL", r.status === 200 && typeof qaControlCap === "string" && qaControlCap.startsWith("/desktop/session/control/"), `status=${r.status} url=${qaControlCap}`);
seen.length = 0;
r = await call(qaControlCap + "/vnc.html", { headers: cookieHdr });
check("24b qa control session -> 200 via the QA interactive origin (6085)",
  r.status === 200 && seen.some((s) => s.origin === DESKTOP_QA_ORIGIN) && !seen.some((s) => s.origin === DESKTOP_ORIGIN),
  `status=${r.status} seen=${JSON.stringify(seen)}`);
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "view", computer: "qa" }) });
const qaViewCap = (await r.json()).url;
seen.length = 0;
r = await call(qaViewCap + "/vnc.html", { headers: cookieHdr });
check("24c qa view session -> 200 via the QA view origin (6084)",
  r.status === 200 && seen.some((s) => s.origin === DESKTOP_QA_VIEW_ORIGIN) && !seen.some((s) => s.origin === DESKTOP_VIEW_ORIGIN),
  `status=${r.status} seen=${JSON.stringify(seen)}`);
await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: qaLease2, computer: "qa" }) });

// 25. Needs-you: raise (sync token) -> GET (cookie) shows it -> resolve
// clears it. Wrong/absent sync token -> 401; GET without cookie -> gate.
r = await call("/desktop/__needs-you", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Sign-in needed" }) });
check("25a __needs-you POST without sync token -> 401", r.status === 401, `status=${r.status}`);
r = await call("/desktop/__needs-you", { method: "POST", headers: { "Content-Type": "application/json", "X-Desktop-Sync": "wrong-token" }, body: JSON.stringify({ text: "Sign-in needed" }) });
check("25b __needs-you POST with wrong sync token -> 401", r.status === 401, `status=${r.status}`);
r = await call("/desktop/__needs-you", { method: "POST", headers: { "Content-Type": "application/json", ...syncHdr }, body: JSON.stringify({ text: "Sign-in needed", runId: "run-1" }) });
j = await r.json();
check("25c __needs-you POST with sync token -> 200 + record", r.status === 200 && j.ok === true && j.record.text === "Sign-in needed" && j.record.runId === "run-1", `status=${r.status} body=${JSON.stringify(j)}`);
r = await call("/desktop/__needs-you", { method: "POST", headers: { "Content-Type": "application/json", ...syncHdr }, body: JSON.stringify({ text: "   " }) });
check("25d __needs-you POST with empty text -> 400", r.status === 400, `status=${r.status}`);
r = await call("/desktop/__needs-you");
check("25e __needs-you GET without cookie -> gate page (not the record)", r.status === 200 && (await r.text()).includes("/desktop/__verify"), `status=${r.status}`);
r = await call("/desktop/__needs-you", { headers: cookieHdr });
j = await r.json();
check("25f __needs-you GET with cookie -> the record", r.status === 200 && j.record && j.record.text === "Sign-in needed", `body=${JSON.stringify(j)}`);
r = await call("/desktop/__needs-you/resolve", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ action: "bogus" }) });
check("25g __needs-you/resolve bad action -> 400", r.status === 400, `status=${r.status}`);
r = await call("/desktop/__needs-you/resolve", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ action: "skip" }) });
check("25h __needs-you/resolve skip -> 200", r.status === 200 && (await r.json()).ok === true, `status=${r.status}`);
r = await call("/desktop/__needs-you", { headers: cookieHdr });
j = await r.json();
check("25i __needs-you GET after resolve -> record null", j.record === null, `body=${JSON.stringify(j)}`);

// 26. Preview: upload (sync token, PNG) -> GET (cookie) returns the PNG,
// per computer. Wrong token -> 401; non-PNG -> 400; no cookie -> gate.
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
r = await call("/desktop/__preview-upload", { method: "POST", headers: { "Content-Type": "image/png" }, body: pngBytes });
check("26a __preview-upload without sync token -> 401", r.status === 401, `status=${r.status}`);
r = await call("/desktop/__preview-upload", { method: "POST", headers: { "Content-Type": "text/plain", ...syncHdr }, body: "not a png" });
check("26b __preview-upload non-PNG -> 400", r.status === 400, `status=${r.status}`);
r = await call("/desktop/__preview-upload?computer=qa", { method: "POST", headers: { "Content-Type": "image/png", ...syncHdr }, body: pngBytes });
check("26c __preview-upload computer=qa -> 200", r.status === 200 && (await r.json()).ok === true, `status=${r.status}`);
r = await call("/desktop/__preview?computer=default", { headers: cookieHdr });
check("26d __preview computer=default with no upload yet -> 404", r.status === 404, `status=${r.status}`);
r = await call("/desktop/__preview?computer=qa", { headers: cookieHdr });
check("26e __preview computer=qa -> 200 PNG, same bytes", r.status === 200 && r.headers.get("Content-Type") === "image/png" && (await r.arrayBuffer()).byteLength === pngBytes.byteLength, `status=${r.status} ct=${r.headers.get("Content-Type")}`);
r = await call("/desktop/__preview-upload", { method: "POST", headers: { "Content-Type": "image/png", ...syncHdr }, body: pngBytes });
check("26f __preview-upload default -> 200", r.status === 200, `status=${r.status}`);
r = await call("/desktop/__preview", { headers: cookieHdr });
check("26g __preview default (no computer param) -> 200 PNG", r.status === 200 && (await r.arrayBuffer()).byteLength === pngBytes.byteLength, `status=${r.status}`);
r = await call("/desktop/__preview?computer=qa");
check("26h __preview without cookie -> gate page", r.status === 200 && (await r.text()).includes("/desktop/__verify"), `status=${r.status}`);

// 27. Teach-by-showing: save (cookie) -> pending-skills list (sync token)
// -> ack -> list empty. Bad skill -> 400; sensitive events redacted.
r = await call("/desktop/__teach", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ name: "", goal: "x", playbook: { steps: ["do it"] } }) });
check("27a __teach without a name -> 400 bad_skill", r.status === 400 && (await r.json()).error === "bad_skill", `status=${r.status}`);
r = await call("/desktop/__teach", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({
  name: "Harness taught skill", goal: "Test the teach flow",
  playbook: { whenToUse: "when testing", inputs: ["a"], steps: ["Open the page", "Click submit"], howToCheck: "the page says done", whatToReturn: "done", approvalBoundaries: "none", failureHandling: "retry" },
  events: [
    { kind: "key", key: "s3cr3t-password", sensitive: true, at: "2026-11-15T00:00:00.000Z" },
    { kind: "pointer", x: 100, y: 200, button: "left" },
  ],
}) });
j = await r.json();
const taughtId = j.id;
check("27b __teach valid skill -> 200 + taught- id", r.status === 200 && typeof taughtId === "string" && taughtId.startsWith("taught-"), `status=${r.status} body=${JSON.stringify(j)}`);
r = await call("/desktop/__pending-skills");
check("27c __pending-skills without sync token -> 401", r.status === 401, `status=${r.status}`);
r = await call("/desktop/__pending-skills", { headers: syncHdr });
j = await r.json();
const listed = j.skills && j.skills.find((s) => s.id === taughtId);
check("27d __pending-skills lists the taught skill", r.status === 200 && !!listed && listed.name === "Harness taught skill", `body=${JSON.stringify(j).slice(0, 200)}`);
check("27e sensitive teach event redacted (no key/text stored)",
  !!listed && listed.events && listed.events[0] && listed.events[0].sensitive === true && !("key" in listed.events[0]) && !("text" in listed.events[0]) && listed.events[1].x === 100,
  `events=${JSON.stringify(listed && listed.events)}`);
r = await call("/desktop/__pending-skills/ack", { method: "POST", headers: { "Content-Type": "application/json", ...syncHdr }, body: JSON.stringify({ id: "bad id!" }) });
check("27f __pending-skills/ack bad id -> 400", r.status === 400, `status=${r.status}`);
r = await call("/desktop/__pending-skills/ack", { method: "POST", headers: { "Content-Type": "application/json", ...syncHdr }, body: JSON.stringify({ id: taughtId }) });
check("27g __pending-skills/ack -> 200", r.status === 200 && (await r.json()).ok === true, `status=${r.status}`);
r = await call("/desktop/__pending-skills", { headers: syncHdr });
j = await r.json();
check("27h __pending-skills after ack -> empty", j.skills.length === 0, `body=${JSON.stringify(j)}`);

// 28. Mode: GET defaults to team; POST private sticks per agent; another
// agent is unaffected; GET without cookie -> gate.
r = await call("/desktop/__mode?agent=default", { headers: cookieHdr });
check("28a __mode GET default agent -> team", r.status === 200 && (await r.json()).mode === "team", `status=${r.status}`);
r = await call("/desktop/__mode", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ agent: "qa-agent", mode: "private" }) });
check("28b __mode POST private -> 200", r.status === 200 && (await r.json()).mode === "private", `status=${r.status}`);
r = await call("/desktop/__mode?agent=qa-agent", { headers: cookieHdr });
check("28c __mode GET qa-agent -> private", (await r.json()).mode === "private", `status=${r.status}`);
r = await call("/desktop/__mode?agent=default", { headers: cookieHdr });
check("28d __mode GET default still team (per-agent)", (await r.json()).mode === "team", `status=${r.status}`);
r = await call("/desktop/__mode?agent=default");
check("28e __mode GET without cookie -> gate page", r.status === 200 && (await r.text()).includes("/desktop/__verify"), `status=${r.status}`);

// 29. Terminal: capability mint requires a live lease (403 without, 200
// with); the session routes to the terminal origin (6083).
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "terminal" }) });
check("29a __screen terminal without a lease -> 403 no_lease", r.status === 403 && (await r.json()).error === "no_lease", `status=${r.status}`);
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "default" }) });
const termLeaseId = (await r.json()).leaseId;
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "terminal", leaseId: termLeaseId }) });
j = await r.json();
const termCap = j.url;
check("29b __screen terminal with lease -> 200 + terminal URL", r.status === 200 && typeof termCap === "string" && termCap.startsWith("/desktop/session/terminal/"), `status=${r.status} url=${termCap}`);
seen.length = 0;
r = await call(termCap + "/", { headers: cookieHdr });
check("29c terminal session -> 200 via the terminal origin (6083)",
  r.status === 200 && seen.some((s) => s.origin === DESKTOP_TERMINAL_ORIGIN),
  `status=${r.status} seen=${JSON.stringify(seen)}`);
await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: termLeaseId, computer: "default" }) });

// 30. Console side-panel injection: the SPA index gets the panel script;
// API JSON and the /status page do not.
r = await call("/");
body = await r.text();
check("30a console / injects the side-panel script", r.status === 200 && body.includes("qwenpawComputerPanel") && body.includes("/desktop"), `status=${r.status} hasPanel=${body.includes("qwenpawComputerPanel")}`);
r = await call("/api/auth/status");
check("30b API JSON is NOT injected", r.status === 200 && !(await r.text()).includes("qwenpawComputerPanel"), `status=${r.status}`);
r = await call("/status");
check("30c /status page is NOT the console SPA (no panel script)", r.status === 200 && !(await r.text()).includes("qwenpawComputerPanel"), `status=${r.status}`);

// 31. Vendor files: xterm.js + xterm.css served under /desktop/vendor.
r = await call("/desktop/vendor/xterm.js", { headers: cookieHdr });
check("31a /desktop/vendor/xterm.js -> 200 JS", r.status === 200 && (r.headers.get("Content-Type") || "").includes("javascript"), `status=${r.status} ct=${r.headers.get("Content-Type")}`);
r = await call("/desktop/vendor/xterm.css", { headers: cookieHdr });
check("31b /desktop/vendor/xterm.css -> 200 CSS", r.status === 200 && (r.headers.get("Content-Type") || "").includes("css"), `status=${r.status} ct=${r.headers.get("Content-Type")}`);

// --- Fix round (2026-11-15): the 4 browser defects ----------------------
// 32. Per-computer __status: qa probes the QA view origin (6084), not
//     :1 (6082); a dead qa origin reports down while :1 stays up; a
//     single transient failure is retried and still reports up; the
//     screen field reports the WS/RFB liveness probe.
seen.length = 0;
r = await call("/desktop/__status?computer=qa", { headers: cookieHdr });
j = await r.json();
check("32a __status?computer=qa probes the QA view origin (6084), not :1",
  r.status === 200 && j.computer === "qa" && j.desktop === "up" && seen.some((s) => s.origin === DESKTOP_QA_VIEW_ORIGIN) && !seen.some((s) => s.origin === DESKTOP_VIEW_ORIGIN),
  `status=${r.status} body=${JSON.stringify(j)} seen=${JSON.stringify(seen)}`);
mockFailOrigins.add(DESKTOP_QA_VIEW_ORIGIN);
r = await call("/desktop/__status?computer=qa", { headers: cookieHdr });
j = await r.json();
check("32b __status?computer=qa with the qa origin down -> desktop not up",
  r.status === 200 && j.computer === "qa" && j.desktop !== "up",
  `body=${JSON.stringify(j)}`);
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("32c __status (default) still up while qa is down",
  r.status === 200 && j.desktop === "up",
  `body=${JSON.stringify(j)}`);
mockFailOrigins.delete(DESKTOP_QA_VIEW_ORIGIN);
mockFailOnceOrigins.add(DESKTOP_VIEW_ORIGIN);
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("32d __status survives a single transient origin failure (retry)",
  r.status === 200 && j.desktop === "up",
  `body=${JSON.stringify(j)}`);
seen.length = 0;
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("32e __status reports screen live (WS/RFB probe) via a websocket upgrade",
  r.status === 200 && j.screen === "live" && seen.some((s) => s.path === "/websockify" && s.upgrade === "websocket"),
  `body=${JSON.stringify(j)} seen=${JSON.stringify(seen)}`);

// 33. Generation lag: a cap minted at gen N still verifies when the
//     verify read is stale by one (N-1), but a cap older than the
//     current generation (after a release) is still rejected.
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "default" }) });
const lagLease = (await r.json()).leaseId;
const genAfterTakeover = Number(await kv.get("generation:default"));
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "view", computer: "default" }) });
const lagCap = (await r.json()).url;
check("33a mint a view cap after a takeover", r.status === 200 && typeof lagCap === "string" && lagCap.startsWith("/desktop/session/view/"), `status=${r.status}`);
await kv.put("generation:default", String(genAfterTakeover - 1));
r = await call(lagCap + "/vnc.html", { headers: cookieHdr });
check("33b cap verifies when the generation read is stale by one",
  r.status === 200, `status=${r.status}`);
await kv.put("generation:default", String(genAfterTakeover));
await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: lagLease, computer: "default" }) });
r = await call(lagCap + "/vnc.html", { headers: cookieHdr });
check("33c old cap -> 403 after a release (one-sided tolerance: older caps stay dead)",
  r.status === 403, `status=${r.status}`);

// 34. A KV error during the capability check is a retryable 502, never
//     a false 403 "link expired".
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "view", computer: "default" }) });
const kvCap = (await r.json()).url;
kv.failGetKeys.add("generation:default");
r = await call(kvCap + "/vnc.html", { headers: cookieHdr });
check("34 KV error on the generation read -> 502, not 403",
  r.status === 502, `status=${r.status}`);
kv.failGetKeys.delete("generation:default");

// 35. __wake starts the desktop via the InstaBox API when the key is set
//     and :1 is down; without the key it says so honestly (no API call).
mockFailOrigins.add(DESKTOP_VIEW_ORIGIN);
env.INSTABOX_API_KEY = "test-instabox-key";
apiCalls.length = 0;
await kv.delete("lastWake");
r = await call("/desktop/__wake", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "default" }) });
j = await r.json();
check("35a __wake with the key + :1 down -> calls the desktop start API, desktopStart started",
  r.status === 200 && j.desktopStart === "started" && apiCalls.some((c) => c.url.includes("/desktop") && c.body.includes('"start"')),
  `status=${r.status} body=${JSON.stringify(j)} apiCalls=${JSON.stringify(apiCalls)}`);
delete env.INSTABOX_API_KEY;
await kv.delete("lastWake");
r = await call("/desktop/__wake", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "default" }) });
j = await r.json();
check("35b __wake without the key -> desktopStart unavailable, no API call",
  r.status === 200 && j.desktopStart === "unavailable" && apiCalls.length === 1,
  `status=${r.status} body=${JSON.stringify(j)} apiCalls=${JSON.stringify(apiCalls)}`);
mockFailOrigins.delete(DESKTOP_VIEW_ORIGIN);

// 36. A lease for one computer can never mint a screen for the other
//     (the mode-switch-while-in-control bug: the chrome kept the :1
//     leaseId and asked for a :2 control screen).
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "default" }) });
const defLease36 = (await r.json()).leaseId;
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "control", computer: "qa", leaseId: defLease36 }) });
check("36 __screen control computer=qa with the default leaseId -> 403 no_lease",
  r.status === 403 && (await r.json()).error === "no_lease", `status=${r.status}`);
await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: defLease36, computer: "default" }) });

// --- Fix round 2 (2026-11-15): the stream failure itself ----------------
// The root causes, proven live: (a) Workers fetch() auto-follows the
// proxy's 303, so fetchDesktopOrigin never saw it and the follow-up
// 401'd ("origin_auth" while the desktop was up); (b) the browser's
// Cookie header was forwarded FIRST, so a stale per-port proxy cookie
// poisoned every fetch to a different origin (502s after the first
// control session, Private never rendering); (c) a failed probe reported
// "asleep", telling the user to Wake a machine that was already awake.
// (a) is covered by harness-desktop-origin.mjs (real fetch + local mock
// proxy); (b) and (c) are covered here too.
// 37. A throwing origin with the machine up -> "down", never "asleep".
mockFailOrigins.add(DESKTOP_VIEW_ORIGIN);
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("37 __status with the origin dead + machine up -> desktop down (not asleep)",
  r.status === 200 && j.desktop === "down",
  `body=${JSON.stringify(j)}`);
mockFailOrigins.delete(DESKTOP_VIEW_ORIGIN);
// 38. Same dead origin, but the machine itself is in cooldown: now
// "asleep" is honest (the machine is the problem, Wake is the path).
mockFailOrigins.add(DESKTOP_VIEW_ORIGIN);
mockKeepaliveStatus = "cooldown";
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("38 __status with the origin dead + machine cooldown -> desktop asleep",
  r.status === 200 && j.desktop === "asleep",
  `body=${JSON.stringify(j)}`);
mockFailOrigins.delete(DESKTOP_VIEW_ORIGIN);
mockKeepaliveStatus = "up";
// 39. A stale proxy-auth cookie in the browser jar must not poison the
// session fetch: the Worker drops the browser's Cookie header and does
// its own _token dance. With the old code this 502'd (stale cookie
// forwarded first, then first again after the 303).
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "view", computer: "default" }) });
const staleCap = (await r.json()).url;
r = await call(staleCap + "/vnc.html", { headers: { Cookie: `${goodCookie}; __Host-instabox_port_auth=stale-wrong-value` } });
body = await r.text();
check("39 session vnc.html with a stale browser proxy cookie -> 200 + shim (not 502)",
  r.status === 200 && body.includes("__QWENPAW_DESKTOP_MODE"),
  `status=${r.status}`);
// 39b. The session response must not set a proxy-auth cookie on the
// browser (the dance cookies stay server-side).
const outCookies39 = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : (r.headers.get("Set-Cookie") ? [r.headers.get("Set-Cookie")] : []);
check("39b session response sets NO __Host-instabox_port_auth cookie",
  !outCookies39.some((c) => c.split(";")[0].trim().toLowerCase().startsWith("__host-instabox_port_auth=")),
  `set-cookie=${JSON.stringify(outCookies39)}`);

// --- T50–T57 fixes (2026-11-15): the KV write-budget incident -------
// Live proof: Cloudflare error 10048 ("your account has reached the free
// usage limit for this operation for today") on a direct KV write, while
// reads worked. The lease-watcher's unconditional 15 s preview uploads
// (2 writes/15 s) had spent the 1,000 writes/day budget, so __takeover
// (T52) and __mode (T53) answered 500 and the needs-you raise (T56)
// failed with worker_500 — all from unguarded KV puts. Every
// user-facing write now answers 503 store_unavailable instead.
// 40a. __takeover with the KV write failing -> 503 store_unavailable,
//      NOT a bare 500 (the old code threw out of the handler).
kv.failAllPuts = true;
try {
  r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "default" }) });
  j = await r.json();
  check("40a __takeover with KV write failing -> 503 store_unavailable (not 500)",
    r.status === 503 && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
} catch (e) {
  check("40a __takeover with KV write failing -> 503 store_unavailable (not 500)", false, `threw: ${e.message}`);
}
// 40b. __mode POST with the KV write failing -> 503 store_unavailable.
try {
  r = await call("/desktop/__mode", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ agent: "default", mode: "private" }) });
  j = await r.json();
  check("40b __mode POST with KV write failing -> 503 store_unavailable",
    r.status === 503 && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
} catch (e) {
  check("40b __mode POST with KV write failing -> 503 store_unavailable", false, `threw: ${e.message}`);
}
// 40c. __needs-you POST (sync token) with the KV write failing -> 503.
try {
  r = await call("/desktop/__needs-you", { method: "POST", headers: { "Content-Type": "application/json", ...syncHdr }, body: JSON.stringify({ text: "Sign-in needed" }) });
  j = await r.json();
  check("40c __needs-you POST with KV write failing -> 503 store_unavailable",
    r.status === 503 && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
} catch (e) {
  check("40c __needs-you POST with KV write failing -> 503 store_unavailable", false, `threw: ${e.message}`);
}
// 40d. __preview-upload with the KV write failing -> 503.
try {
  r = await call("/desktop/__preview-upload", { method: "POST", headers: { "Content-Type": "image/png", ...syncHdr }, body: pngBytes });
  j = await r.json();
  check("40d __preview-upload with KV write failing -> 503 store_unavailable",
    r.status === 503 && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
} catch (e) {
  check("40d __preview-upload with KV write failing -> 503 store_unavailable", false, `threw: ${e.message}`);
}
// 40e. __teach with the KV write failing -> 503.
try {
  r = await call("/desktop/__teach", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ name: "x", goal: "y", playbook: { steps: ["do it"] } }) });
  j = await r.json();
  check("40e __teach with KV write failing -> 503 store_unavailable",
    r.status === 503 && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
} catch (e) {
  check("40e __teach with KV write failing -> 503 store_unavailable", false, `threw: ${e.message}`);
}
kv.failAllPuts = false;
// 40f. __heartbeat with the KV write failing -> 503 (NOT 410: the lease
// still exists, so the chrome must keep control and retry).
r = await call("/desktop/__takeover", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ computer: "default" }) });
const hbLease = (await r.json()).leaseId;
kv.failAllPuts = true;
try {
  r = await call("/desktop/__heartbeat", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: hbLease, computer: "default" }) });
  j = await r.json();
  check("40f __heartbeat with KV write failing -> 503 store_unavailable, not 410",
    r.status === 503 && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
} catch (e) {
  check("40f __heartbeat with KV write failing -> 503 store_unavailable, not 410", false, `threw: ${e.message}`);
}
kv.failAllPuts = false;
// 40g. __release with the KV delete failing -> 503 (the lease was not
// ended; it expires on its own within 90 s).
kv.failDeleteKeys.add("lease:default");
try {
  r = await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: hbLease, computer: "default" }) });
  j = await r.json();
  check("40g __release with KV delete failing -> 503 store_unavailable",
    r.status === 503 && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
} catch (e) {
  check("40g __release with KV delete failing -> 503 store_unavailable", false, `threw: ${e.message}`);
}
kv.failDeleteKeys.delete("lease:default");
await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId: hbLease, computer: "default" }) });
// 40h. The screen probe's WS handshake carries Sec-WebSocket-Protocol:
// binary, exactly like noVNC's own handshake (T50: the probe must
// exercise the same path the frame uses).
seen.length = 0;
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("40h screen probe WS upgrade carries Sec-WebSocket-Protocol: binary",
  r.status === 200 && j.screen === "live" && seen.some((s) => s.path === "/websockify" && s.upgrade === "websocket" && s.protocol === "binary"),
  `body=${JSON.stringify(j)} seen=${JSON.stringify(seen)}`);
// 40i. Cheap pre-probe: GET <cap>?qwenpaw_probe=1 -> 204 WITHOUT
// touching the origin (the old probe fetched the full vnc.html through
// the session proxy, then the frame fetched it again — the 60-90 s
// first load). A tampered cap + probe -> 403.
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "view", computer: "default" }) });
const probeCap = (await r.json()).url;
seen.length = 0;
r = await call(probeCap + "?qwenpaw_probe=1", { headers: cookieHdr });
check("40i session ?qwenpaw_probe=1 -> 204, no origin fetch",
  r.status === 204 && seen.length === 0,
  `status=${r.status} seen=${JSON.stringify(seen)}`);
const tamperedProbe = probeCap.slice(0, -2) + (probeCap.slice(-2, -1) === "A" ? "B" : "A") + probeCap.slice(-1);
r = await call(tamperedProbe + "?qwenpaw_probe=1", { headers: cookieHdr });
check("40i2 tampered cap + probe -> 403", r.status === 403, `status=${r.status}`);
// 40j. The probe waits 10 s for the RFB banner, not 3 s (T50: the
// banner arrives late through the proxied handshake while the real
// stream works). A banner at 4 s is "live" under the new budget.
mockSlowRfbMs = 4000;
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("40j __status with a 4 s-late RFB banner -> screen live (10 s budget)",
  r.status === 200 && j.screen === "live",
  `body=${JSON.stringify(j)}`);
mockSlowRfbMs = 0;


// 41. BUGS.md B-1 — bumpGeneration must never report a generation it
// failed to persist. The old code swallowed the put error, returned the
// incremented value, and read through the LENIENT getter, so (a) a
// takeover could answer ok:true with an unverifiable generation and
// (b) a read blip could move the generation BACKWARDS to 1 and
// resurrect every capability minted at generation 1.
// 41a. Write failure during takeover -> 503, and the stored generation
// must be unchanged (no phantom bump reported).
{
  await call("/desktop/__release", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ leaseId: (await kv.get("lease:default", "json"))?.leaseId || "none", computer: "default" }),
  });
  const genStored = Number(await kv.get("generation:default"));
  kv.failPutKeys.add("generation:default");
  r = await call("/desktop/__takeover", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ computer: "default" }),
  });
  j = await r.json().catch(() => ({}));
  check("41a takeover with a failing generation write -> 503 store_unavailable",
    r.status === 503 && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
  check("41a2 stored generation unchanged after the failed bump",
    Number(await kv.get("generation:default")) === genStored,
    `gen=${await kv.get("generation:default")} before=${genStored}`);
  kv.failPutKeys.delete("generation:default");
  // Clean up the lease the failed takeover may have written.
  kv.map.delete("lease:default");
}

// 41b. Generation READ failure during takeover -> 503, never a silent
// bump from a lenient 0 (which would jump backwards to 1).
{
  // Fail the key the takeover will actually read for the computer it is
  // taking over (qa reads generation:qa — failing generation:default would
  // prove nothing, which is how this test first passed vacuously).
  const genQaBefore = await kv.get("generation:qa");
  kv.failGetKeys.add("generation:qa");
  r = await call("/desktop/__takeover", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ computer: "qa" }),
  });
  j = await r.json().catch(() => ({}));
  check("41b takeover with a failing generation read -> 503, not a backwards bump",
    r.status === 503 && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
  kv.failGetKeys.delete("generation:qa");
  check("41b2 qa generation untouched (no silent reset to 1)",
    (await kv.get("generation:qa")) === genQaBefore,
    `gen=${await kv.get("generation:qa")} before=${genQaBefore}`);
  kv.map.delete("lease:qa");
}

// 41c. Release with a failing generation write -> 503 that says the
// lease IS released but old links may live on (honesty, not a false ok).
{
  const tk = await call("/desktop/__takeover", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ computer: "default" }),
  });
  const tj = await tk.json();
  kv.failPutKeys.add("generation:default");
  r = await call("/desktop/__release", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ leaseId: tj.leaseId, computer: "default" }),
  });
  j = await r.json().catch(() => ({}));
  check("41c release with a failing generation write -> 503 (not a false ok)",
    r.status === 503 && j.ok === false && j.error === "store_unavailable",
    `status=${r.status} body=${JSON.stringify(j)}`);
  check("41c2 the message states the lease is released but links may survive",
    /already released/i.test(j.note || "") && /up to an hour/i.test(j.note || ""),
    `note=${j.note}`);
  kv.failPutKeys.delete("generation:default");
  kv.map.delete("lease:default");
}

// 41d. Normal path still works: a successful takeover returns a
// generation that IS stored, and a mint at that generation verifies.
{
  const tk = await call("/desktop/__takeover", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ computer: "default" }),
  });
  const tj = await tk.json();
  const stored = Number(await kv.get("generation:default"));
  check("41d takeover returns the generation it actually stored",
    tk.status === 200 && Number(tj.generation) === stored,
    `returned=${tj.generation} stored=${stored}`);
  kv.map.delete("lease:default");
}


// 42. BUGS.md B-4 — a capability must never outlive the control it was
// minted under. The old code gave every capability a flat 60-minute TTL, so
// a terminal capability minted at second 30 of a 90 s lease kept a ROOT
// SHELL alive for another 59 minutes after the user handed control back.
// 42a. A terminal capability's expiry is clamped to the lease deadline.
{
  const tk = await call("/desktop/__takeover", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ computer: "default" }),
  });
  const tj = await tk.json();
  const term = await call("/desktop/__screen", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "terminal", leaseId: tj.leaseId, computer: "default" }),
  });
  const termJson = await term.json();
  const exp = Number(String(termJson.url || "").split("/")[4]?.split(".")[0] || 0);
  const leaseDeadline = Math.ceil((tj.expiresAt || 0) / 1000);
  check("42a terminal capability expiry is clamped to the lease deadline",
    term.status === 200 && exp > 0 && exp <= leaseDeadline + 30,
    `exp=${exp} leaseDeadline=${leaseDeadline} url=${termJson.url}`);
  // 90 s lease + 30 s grace = ~120 s; allow the +1s rounding of ceil().
  check("42a2 terminal TTL is ~2 minutes, not the old flat hour",
    exp - Math.floor(Date.now() / 1000) <= 125,
    `ttl=${exp - Math.floor(Date.now() / 1000)}s`);
  kv.map.delete("lease:default");
}

// 42b. After release, the terminal capability no longer verifies.
{
  const tk = await call("/desktop/__takeover", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ computer: "default" }),
  });
  const tj = await tk.json();
  const term = await call("/desktop/__screen", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "terminal", leaseId: tj.leaseId, computer: "default" }),
  });
  const termUrl = (await term.json()).url;
  await call("/desktop/__release", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ leaseId: tj.leaseId, computer: "default" }),
  });
  r = await call(termUrl);
  check("42b a terminal capability dies when the lease is released",
    r.status === 403, `status=${r.status}`);
}

// 43. BUGS.md B-9 — a client may not INFLATE the generation. A future value
// used to be accepted via Math.max, which self-DoSed other screens and
// masked a lost bump (B-1).
{
  const tk = await call("/desktop/__takeover", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ computer: "default" }),
  });
  const tj = await tk.json();
  const stored = Number(await kv.get("generation:default"));
  const r2 = await call("/desktop/__screen", {
    method: "POST",
    headers: { ...cookieHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "view", gen: stored + 50, computer: "default" }),
  });
  const j2 = await r2.json();
  const capGen = Number(String(j2.url || "").split("/")[4]?.split(".")[0] || 0);
  // The capability must carry the STORED generation, not the inflated one.
  const verified = await call(j2.url || "/desktop/session/view/0.x/");
  check("43 a client cannot inflate the generation (future value ignored)",
    verified.status === 200 && stored === Number(await kv.get("generation:default")),
    `stored=${stored} capUrl=${j2.url} verify=${verified.status}`);
  kv.map.delete("lease:default");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
