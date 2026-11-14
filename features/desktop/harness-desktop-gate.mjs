// Local harness for the /desktop gate + Rakazo-style lease/capability in
// pages/public/_worker.js. Run: node features/desktop/harness-desktop-gate.mjs
// Mocks the origin (QwenPaw healthz + noVNC + keep-alive) and exercises the
// worker's fetch handler. NOT deployed — test-only.
import { createHmac } from "node:crypto";

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const DESKTOP_ORIGIN = "https://6081-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const DESKTOP_VIEW_ORIGIN = "https://6082-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const KEEPALIVE_URL = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev";
const TEST_SECRET = "test-desktop-secret";
const TEST_VIEW_SECRET = "test-view-secret";

// Mock KV (DESKTOP_KV binding).
class MockKV {
  constructor() { this.map = new Map(); }
  async get(k, type) {
    const v = this.map.get(k);
    if (v === undefined) return null;
    if (type === "json") { try { return JSON.parse(v); } catch { return null; } }
    return v;
  }
  async put(k, v) { this.map.set(k, typeof v === "string" ? v : JSON.stringify(v)); }
  async delete(k) { this.map.delete(k); }
}

// Mock origin: healthz 200 only for the good token, 401 otherwise;
// noVNC serves vnc.html; console root serves the SPA.
// The desktop origins simulate the InstaBox private-port proxy exactly:
//  - a request WITH ?_token= gets 303 + Set-Cookie __Host-instabox_port_auth
//    and a relative Location with the token stripped;
//  - a request WITH that auth cookie (no token) gets 200;
//  - anything else gets 401.
// `seen` records every desktop-origin request for the tests to assert on.
const seen = [];
globalThis.fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = req.url;
  if (url.startsWith(ORIGIN + "/api/healthz")) {
    const auth = req.headers.get("Authorization") || "";
    return new Response(JSON.stringify({ status: "ok" }), {
      status: auth === "Bearer good-token" ? 200 : 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.startsWith(DESKTOP_ORIGIN) || url.startsWith(DESKTOP_VIEW_ORIGIN)) {
    const u = new URL(url);
    const cookie = req.headers.get("Cookie") || "";
    seen.push({ origin: u.origin, path: u.pathname, hadToken: u.searchParams.has("_token"), hadAuth: cookie.includes("__Host-instabox_port_auth=test-auth") });
    if (u.pathname === "/foreign-redirect") {
      return new Response("", { status: 302, headers: { Location: "https://evil.example/x" } });
    }
    if (u.searchParams.has("_token")) {
      u.searchParams.delete("_token");
      const loc = u.pathname + (u.search ? u.search : "");
      return new Response("", { status: 303, headers: { Location: loc, "Set-Cookie": "__Host-instabox_port_auth=test-auth; Path=/; Secure; HttpOnly" } });
    }
    if (cookie.includes("__Host-instabox_port_auth=test-auth")) {
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
    return new Response(JSON.stringify({ status: "up" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.startsWith(KEEPALIVE_URL + "/ping")) {
    return new Response(JSON.stringify({ status: "up" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.startsWith(ORIGIN + "/")) {
    return new Response("<html>console spa</html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
};

const worker = (await import("../../pages/public/_worker.js")).default;
const kv = new MockKV();
const env = {
  DESKTOP_ORIGIN_TOKEN: TEST_SECRET,
  DESKTOP_VIEW_TOKEN: TEST_VIEW_SECRET,
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
const before = (await kv.get("lease", "json")).expiresAt;
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
check("16a __release with wrong leaseId -> stale, lease survives", r.status === 200 && j.error === "stale" && (await kv.get("lease", "json"))?.leaseId === leaseId, `body=${JSON.stringify(j)}`);
const genBefore = await kv.get("generation");
r = await call("/desktop/__release", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ leaseId }) });
j = await r.json();
check("16b __release with right leaseId -> ok", r.status === 200 && j.released === true, `body=${JSON.stringify(j)}`);
check("16c generation bumped on release", Number(await kv.get("generation")) === Number(genBefore) + 1, `gen=${await kv.get("generation")} before=${genBefore}`);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
