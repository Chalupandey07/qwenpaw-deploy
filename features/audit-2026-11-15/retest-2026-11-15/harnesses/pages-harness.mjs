// Harness for pages/public/_worker.js wake (503) + cooldown (409) paths.
// Stubs global fetch: origin returns scripted statuses; WAKE_WAIT_MS is 45s
// so the 503 path takes ~45s once. Run with node.
import worker from "/home/hatch/workspace/qwenpaw-deploy/pages/public/_worker.js";
let pass = 0, fail = 0;
const check = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };
let script = [];
globalThis.fetch = async () => {
  const s = script.shift() ?? { status: 200, body: "<html>console</html>", headers: {} };
  return new Response(s.body, { status: s.status, headers: { "Content-Type": s.headers?.ct || "text/html", ...(s.headers?.loc ? { Location: s.headers.loc } : {}), ...(s.headers?.ra ? { "Retry-After": s.headers.ra } : {}) } });
};
const req = (path) => worker.fetch(new Request("https://qwenpawx.pages.dev" + path), { ASSETS: null });
// 1. normal 200 passthrough with framing headers
script = [{ status: 200, body: "<html>console</html>" }];
let r = await req("/");
check("GET / 200 passthrough", r.status === 200);
check("framing headers on HTML", r.headers.get("X-Frame-Options") === "SAMEORIGIN" && r.headers.get("Content-Security-Policy") === "frame-ancestors 'self'");
// 2. 503 then 200 after wait -> console (takes ~45s)
script = [{ status: 503, body: '{"error":{"code":"waking"}}', headers: { ct: "application/json" } }, { status: 200, body: "<html>console</html>" }];
let t0 = Date.now();
r = await req("/");
check("503 then up -> 200 after wait", r.status === 200 && Date.now() - t0 >= 44000);
// 3. 503 then 503 -> waking page 503 with Retry-After
script = [{ status: 503, body: '{"error":{"retryAfterSeconds":90}}', headers: { ct: "application/json" } }, { status: 503, body: '{"error":{"retryAfterSeconds":90}}', headers: { ct: "application/json" } }];
r = await req("/");
check("503 then 503 -> waking page 503", r.status === 503 && (await r.text()).includes("waking up"));
// 4. 409 machine_cooldown -> cooldown page (status 503 per code) with Retry-After
script = [{ status: 409, body: '{"error":{"code":"machine_cooldown","retryAfterSeconds":600}}', headers: { ct: "application/json" } }];
r = await req("/");
check("409 machine_cooldown -> cooldown page", r.status === 503 && r.headers.get("Retry-After") === "600" && (await r.text()).includes("cooldown"));
// 5. 409 other code -> plain 409
script = [{ status: 409, body: '{"error":{"code":"other"}}', headers: { ct: "application/json" } }];
r = await req("/");
check("409 other -> plain 409", r.status === 409);
// 6. foreign Location dropped
script = [{ status: 302, body: "", headers: { ct: "text/html", loc: "https://evil.example/x" } }];
r = await req("/");
check("foreign Location dropped", r.headers.get("Location") === null);
// 7. origin-absolute Location rewritten to Pages
script = [{ status: 302, body: "", headers: { ct: "text/html", loc: "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/foo" } }];
r = await req("/");
check("origin Location rewritten", r.headers.get("Location") === "https://qwenpawx.pages.dev/foo");
// 8. origin unreachable -> generic 502
globalThis.fetch = async () => { throw new Error("boom https://origin-secret"); };
r = await req("/");
check("origin down -> generic 502, no leak", r.status === 502 && !(await r.text()).includes("origin-secret"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
