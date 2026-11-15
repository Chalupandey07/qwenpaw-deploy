// Origin harness for the /desktop stream failure (fix round 2).
// Run: node features/desktop/harness-desktop-origin.mjs
//
// WHY THIS HARNESS EXISTS: features/desktop/harness-desktop-gate.mjs stubs
// globalThis.fetch with a mock that returns the InstaBox proxy's 303
// DIRECTLY. The real Workers fetch() (and Node's undici fetch) FOLLOWS
// redirects by default, so in production the 303 was auto-followed without
// its Set-Cookie and the follow-up 401'd — the gate harness could never
// catch that. This harness uses the REAL fetch against REAL local HTTP
// servers that mimic the InstaBox private-port proxy exactly as measured
// live (2026-11-15 ~01:00 UTC):
//   - no token/cookie        -> 401
//   - wrong ?_token=         -> 403 "This link's token is not valid."
//   - valid ?_token=         -> 303 + Set-Cookie __Host-instabox_port_auth
//                              + relative Location with the token stripped
//   - valid cookie           -> 200 (vnc.html / / / assets)
//   - the proxy honors the FIRST __Host-instabox_port_auth cookie when
//     several are sent (per-port cookie, first wins)
// A fetch wrapper rewrites *.instabox.tech to the local mock servers and
// delegates to the real undici fetch, so redirect-following, cookie
// handling and header behavior are the real ones. The keep-alive Worker
// and the QwenPaw console are stubbed in the wrapper (no real network).
// NOT deployed — test-only.
import http from "node:http";
import { createHmac } from "node:crypto";

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const KEEPALIVE_URL = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev";
const TEST_SECRET = "test-desktop-secret";
const TEST_VIEW_SECRET = "test-view-secret";
const TEST_SYNC_SECRET = "test-sync-secret";
const TEST_TERMINAL_SECRET = "test-terminal-secret";
const TEST_QA_VIEW_SECRET = "test-qa-view-secret";
const TEST_QA_SECRET = "test-qa-secret";

// One mock proxy server per desktop origin. Each has its own token and
// its own cookie value (the proxy cookie is per-port).
const MOCK_ORIGINS = [
  { name: "control", real: "https://6081-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech", port: 18081, token: "tok-control", cookie: "auth-control" },
  { name: "view", real: "https://6082-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech", port: 18082, token: "tok-view", cookie: "auth-view" },
  { name: "terminal", real: "https://6083-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech", port: 18083, token: "tok-terminal", cookie: "auth-terminal" },
  { name: "qa-view", real: "https://6084-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech", port: 18084, token: "tok-qa-view", cookie: "auth-qa-view" },
  { name: "qa-control", real: "https://6085-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech", port: 18085, token: "tok-qa-control", cookie: "auth-qa-control" },
];
const byRealOrigin = new Map(MOCK_ORIGINS.map((o) => [new URL(o.real).origin, o]));
const byPort = new Map(MOCK_ORIGINS.map((o) => [o.port, o]));

// Set a server's `down` flag to make it destroy every socket (fetch
// throws) — the "desktop is down" case.
function firstProxyCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k === "__Host-instabox_port_auth") return rest.join("=");
  }
  return null;
}

function mockProxyHandler(cfg) {
  return (req, res) => {
    if (cfg.down) { req.socket.destroy(); return; }
    const u = new URL(req.url, "http://127.0.0.1");
    const cookie = firstProxyCookie(req.headers.cookie);
    if (cookie !== null) {
      if (cookie === cfg.cookie) {
        const isVnc = u.pathname.endsWith("vnc.html") || u.pathname === "/";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(isVnc ? "<html><head></head><body>vnc</body></html>" : "ui.js content");
        return;
      }
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    if (u.searchParams.has("_token")) {
      if (u.searchParams.get("_token") === cfg.token) {
        u.searchParams.delete("_token");
        const loc = u.pathname + (u.search ? u.search : "");
        res.writeHead(303, {
          Location: loc,
          "Set-Cookie": `__Host-instabox_port_auth=${cfg.cookie}; Path=/; Secure; HttpOnly`,
        });
        res.end();
        return;
      }
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("This link's token is not valid. Ask for the port's current link.");
      return;
    }
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("unauthorized");
  };
}

const servers = [];
for (const cfg of MOCK_ORIGINS) {
  const server = http.createServer(mockProxyHandler(cfg));
  // WS upgrades: valid cookie -> 101 (the RFB banner is not asserted
  // here; Node's fetch cannot consume res.webSocket anyway — the
  // worker's screen probe degrades to "unreachable", which is fine).
  server.on("upgrade", (req, socket) => {
    if (cfg.down) { socket.destroy(); return; }
    const u = new URL(req.url, "http://127.0.0.1");
    const cookie = firstProxyCookie(req.headers.cookie);
    if (cookie === cfg.cookie) {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n");
      setTimeout(() => socket.destroy(), 100);
      return;
    }
    if (u.searchParams.get("_token") === cfg.token) {
      socket.write("HTTP/1.1 303 See Other\r\nLocation: /websockify\r\nSet-Cookie: __Host-instabox_port_auth=" + cfg.cookie + "; Path=/; Secure; HttpOnly\r\nContent-Length: 0\r\n\r\n");
      setTimeout(() => socket.destroy(), 100);
      return;
    }
    socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(cfg.port, "127.0.0.1", resolve));
  servers.push(server);
}

// --- Real fetch, with instabox.tech rewritten to the mock servers -------
const realFetch = globalThis.fetch;
let mockMachine = "up"; // keep-alive /status answer (test O5 flips it)
globalThis.fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  const u = new URL(rawUrl);
  // Keep-alive Worker (stubbed, no real network).
  if (u.origin === KEEPALIVE_URL) {
    if (u.pathname === "/status") {
      return new Response(JSON.stringify({ status: mockMachine }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.pathname === "/ping") {
      return new Response(JSON.stringify({ status: "up" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }
  // QwenPaw console healthz (used by __verify): good-token -> 200.
  if (u.origin === ORIGIN && u.pathname === "/api/healthz") {
    const auth = (input instanceof Request ? input.headers.get("Authorization") : new Headers(init?.headers).get("Authorization")) || "";
    return new Response(JSON.stringify({ status: "ok" }), {
      status: auth === "Bearer good-token" ? 200 : 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Desktop origins -> the local mock servers (real fetch, real redirect
  // following — this is the point of the harness).
  const mock = byRealOrigin.get(u.origin);
  if (mock) {
    const local = new URL(u);
    local.protocol = "http:";
    local.hostname = "127.0.0.1";
    local.port = String(mock.port);
    if (input instanceof Request) {
      return realFetch(new Request(local, input), init);
    }
    return realFetch(local.toString(), init);
  }
  return realFetch(input, init);
};

// --- Worker under test (the real pages/public/_worker.js) ---------------
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
  async list({ prefix } = {}) {
    const keys = [];
    for (const k of this.map.keys()) if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
    return { keys };
  }
}

const worker = (await import("../../pages/public/_worker.js")).default;
const kv = new MockKV();
// The worker's origin tokens are the mock servers' tokens (the worker
// sends them as ?_token=; the mock checks them).
const env = {
  DESKTOP_ORIGIN_TOKEN: "tok-control",
  DESKTOP_VIEW_TOKEN: "tok-view",
  DESKTOP_TERMINAL_TOKEN: "tok-terminal",
  DESKTOP_QA_VIEW_TOKEN: "tok-qa-view",
  DESKTOP_QA_ORIGIN_TOKEN: "tok-qa-control",
  DESKTOP_SYNC_TOKEN: TEST_SYNC_SECRET,
  DESKTOP_KV: kv,
  ASSETS: {
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/desktop-chrome.html") return new Response("<html>QwenPaw's computer chrome</html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (u.pathname === "/status-page.html") return new Response("<html>status</html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
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

// Mint the desktop session cookie via __verify (good-token -> 200).
let r = await call("/desktop/__verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "good-token" }) });
const setCookie = r.headers.get("Set-Cookie") || "";
const m = setCookie.match(/qwenpaw_desktop=(\d+)\.([0-9a-f]{64})/);
check("O0 __verify mints a desktop cookie", r.status === 200 && !!m, `status=${r.status}`);
const goodCookie = m ? `qwenpaw_desktop=${m[1]}.${m[2]}` : "";
const cookieHdr = { Cookie: goodCookie };
// A stale proxy-auth cookie in the browser jar (the value minted for a
// DIFFERENT origin — what the browser holds after a control session on
// 6081 while the next probe goes to 6082).
const staleHdr = { Cookie: `${goodCookie}; __Host-instabox_port_auth=stale-wrong-value` };

// O1. __status with no browser cookie: the 303 dance must work through
// the REAL fetch (auto-follow). Before the fix this returned
// desktop "origin_auth" (the 303 was auto-followed without its cookie).
r = await call("/desktop/__status", { headers: cookieHdr });
let j = await r.json();
check("O1 __status (real fetch) -> desktop up, not origin_auth",
  r.status === 200 && j.desktop === "up" && j.machine === "up",
  `status=${r.status} body=${JSON.stringify(j)}`);

// O2. __status with a STALE proxy-auth cookie in the browser jar: the
// Worker must drop it (the proxy honors the FIRST such cookie, so a
// stale one forwarded first 401s every fetch to another origin).
r = await call("/desktop/__status", { headers: staleHdr });
j = await r.json();
check("O2 __status with a stale browser proxy cookie -> desktop up",
  r.status === 200 && j.desktop === "up",
  `status=${r.status} body=${JSON.stringify(j)}`);

// O3. The session pre-probe path the chrome actually uses (mountScreen):
// mint a view capability, then GET its vnc.html with a stale browser
// cookie. Before the fix this was the 502 the browser saw.
r = await call("/desktop/__screen", { method: "POST", headers: { "Content-Type": "application/json", ...cookieHdr }, body: JSON.stringify({ mode: "view" }) });
j = await r.json();
const viewCap = j.url;
check("O3a __screen view -> 200 + session URL", r.status === 200 && typeof viewCap === "string" && viewCap.startsWith("/desktop/session/view/"), `status=${r.status} url=${viewCap}`);
r = await call(viewCap + "/vnc.html", { headers: staleHdr });
const body3 = await r.text();
check("O3b session view vnc.html with a stale cookie -> 200 + shim (not 502)",
  r.status === 200 && body3.includes("__QWENPAW_DESKTOP_MODE") && body3.includes("qwenpawScreen"),
  `status=${r.status} len=${body3.length}`);
// O3c. No proxy-auth cookie is passed through to the browser.
const outCookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : (r.headers.get("Set-Cookie") ? [r.headers.get("Set-Cookie")] : []);
check("O3c session response sets NO __Host-instabox_port_auth cookie",
  !outCookies.some((c) => c.split(";")[0].trim().toLowerCase().startsWith("__host-instabox_port_auth=")),
  `set-cookie=${JSON.stringify(outCookies)}`);

// O4. Cross-port contamination: the browser holds 6081's (control)
// cookie value while the qa probe goes to 6084 — the qa probe must
// still report up.
const controlCookieHdr = { Cookie: `${goodCookie}; __Host-instabox_port_auth=auth-control` };
r = await call("/desktop/__status?computer=qa", { headers: controlCookieHdr });
j = await r.json();
check("O4 __status?computer=qa with 6081's cookie in the jar -> desktop up",
  r.status === 200 && j.computer === "qa" && j.desktop === "up",
  `status=${r.status} body=${JSON.stringify(j)}`);

// O5. A dead origin (socket destroyed -> fetch throws) with the machine
// up must report "down", never "asleep" — a broken probe must not
// masquerade as a sleeping machine.
for (const cfg of MOCK_ORIGINS) cfg.down = true;
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("O5 __status with the origin dead + machine up -> desktop down (not asleep)",
  r.status === 200 && j.desktop === "down",
  `status=${r.status} body=${JSON.stringify(j)}`);
// O5b. Same dead origin, but the machine itself is in cooldown: now
// "asleep" is honest (the machine is the problem, Wake is the path).
mockMachine = "cooldown";
r = await call("/desktop/__status", { headers: cookieHdr });
j = await r.json();
check("O5b __status with the origin dead + machine cooldown -> desktop asleep",
  r.status === 200 && j.desktop === "asleep",
  `status=${r.status} body=${JSON.stringify(j)}`);
mockMachine = "up";
for (const cfg of MOCK_ORIGINS) cfg.down = false;

for (const s of servers) await new Promise((resolve) => s.close(resolve));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
