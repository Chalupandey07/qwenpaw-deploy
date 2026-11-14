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
    return new Response("<html>vnc</html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
