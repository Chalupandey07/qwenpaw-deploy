// Local harness for the /desktop gate in pages/public/_worker.js.
// Run: node features/desktop/harness-desktop-gate.mjs
// Mocks the origin (QwenPaw healthz + noVNC) and exercises the worker's
// fetch handler. NOT deployed — test-only.
import { createHmac } from "node:crypto";

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const DESKTOP_ORIGIN = "https://6081-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const TEST_SECRET = "test-desktop-secret";

// Mock origin: healthz 200 only for the good token, 401 otherwise;
// noVNC serves vnc.html; console root serves the SPA.
// The desktop origin simulates the InstaBox private-port proxy exactly:
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
  if (url.startsWith(DESKTOP_ORIGIN)) {
    const u = new URL(url);
    const cookie = req.headers.get("Cookie") || "";
    seen.push({ path: u.pathname, hadToken: u.searchParams.has("_token"), hadAuth: cookie.includes("__Host-instabox_port_auth=test-auth") });
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
      return new Response(isJs ? "ui.js content" : "<html>vnc</html>", {
        status: 200,
        headers: { "Content-Type": isJs ? "text/javascript" : "text/html; charset=utf-8" },
      });
    }
    return new Response("unauthorized", { status: 401 });
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
const env = { DESKTOP_ORIGIN_TOKEN: TEST_SECRET };

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
async function call(path, opts = {}) {
  const req = new Request("https://qwenpawx.pages.dev" + path, opts);
  return worker.fetch(req, env);
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

// 5. /desktop with the minted cookie -> 302 to vnc.html.
r = await call("/desktop", { headers: { Cookie: goodCookie } });
check("5 /desktop with valid cookie -> 302 vnc.html", r.status === 302 && (r.headers.get("Location") || "").includes("/desktop/vnc.html?autoconnect=true"), `status=${r.status} loc=${r.headers.get("Location")}`);

// 6. Forged cookie -> gate page again.
const forgedExp = String(Math.floor(Date.now() / 1000) + 3600);
r = await call("/desktop", { headers: { Cookie: `qwenpaw_desktop=${forgedExp}.${"0".repeat(64)}` } });
check("6 forged cookie -> gate page", r.status === 200 && (await r.text()).includes("/desktop/__verify"), `status=${r.status}`);

// 7. Expired cookie -> gate page again.
const expExp = String(Math.floor(Date.now() / 1000) - 10);
r = await call("/desktop", { headers: { Cookie: `qwenpaw_desktop=${expExp}.${hmac(expExp)}` } });
check("7 expired cookie -> gate page", r.status === 200 && (await r.text()).includes("/desktop/__verify"), `status=${r.status}`);

// 8. vnc.html with a valid cookie -> proxied 200 from the noVNC origin.
r = await call("/desktop/vnc.html", { headers: { Cookie: goodCookie } });
check("8 vnc.html with valid cookie -> 200 proxied", r.status === 200 && (await r.text()).includes("vnc"), `status=${r.status}`);

// 9. __verify bad JSON -> 400; GET __verify -> 405.
r = await call("/desktop/__verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
check("9a __verify bad JSON -> 400", r.status === 400, `status=${r.status}`);
r = await call("/desktop/__verify", { method: "GET" });
check("9b __verify GET -> 405", r.status === 405, `status=${r.status}`);

// 10. Console root still proxies fine (no regression).
r = await call("/");
check("10 console / still proxies 200", r.status === 200 && (await r.text()).includes("console spa"), `status=${r.status}`);

// 11. BUG 1 (2026-11-15): vnc.html, first visit (no proxy cookie) — the
// worker must follow the proxy's 303 server-side and return 200 noVNC,
// never a root-relative Location, and must pass the proxy auth cookie
// through to the browser.
seen.length = 0;
r = await call("/desktop/vnc.html", { headers: { Cookie: goodCookie } });
body = await r.text();
const loc11 = r.headers.get("Location");
const sc11 = (typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie().join(";") : (r.headers.get("Set-Cookie") || ""));
check("11 vnc.html first visit -> 200 via 303-follow, no root Location, auth cookie set",
  r.status === 200 && body.includes("vnc") && !loc11 && sc11.includes("__Host-instabox_port_auth"),
  `status=${r.status} loc=${loc11} cookies=${sc11.slice(0, 80)} seen=${JSON.stringify(seen)}`);
check("11b token used only as 401 fallback; follow-up carried the auth cookie",
  seen.some((s) => s.hadToken) && seen.some((s) => s.hadAuth && !s.hadToken),
  `seen=${JSON.stringify(seen)}`);

// 12. Returning visitor (proxy cookie present) -> 200 without any _token fetch.
seen.length = 0;
r = await call("/desktop/vnc.html", { headers: { Cookie: goodCookie + "; __Host-instabox_port_auth=test-auth" } });
check("12 vnc.html with proxy cookie -> 200, no _token fetch",
  r.status === 200 && (await r.text()).includes("vnc") && !seen.some((s) => s.hadToken),
  `status=${r.status} seen=${JSON.stringify(seen)}`);

// 13. Asset through the same 303 flow.
seen.length = 0;
r = await call("/desktop/app/ui.js", { headers: { Cookie: goodCookie } });
check("13 asset /desktop/app/ui.js -> 200 via 303-follow, no Location",
  r.status === 200 && (await r.text()).includes("ui.js content") && !r.headers.get("Location"),
  `status=${r.status} loc=${r.headers.get("Location")}`);

// 14. Foreign redirect from the origin is dropped, never sent to the browser.
r = await call("/desktop/foreign-redirect", { headers: { Cookie: goodCookie } });
check("14 foreign redirect dropped (no Location)", r.status === 302 && !r.headers.get("Location"), `status=${r.status} loc=${r.headers.get("Location")}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
