#!/usr/bin/env node
/**
 * Harness for the group-chat CORS allowlist (BUGS.md B-12).
 *
 * Why this exists: the Worker answered `Access-Control-Allow-Origin: *` on an
 * API that authenticates with a custom header. Any page that learned the
 * token could read every response cross-origin, and combined with the relay
 * pasting thread text into the agent that is a thread-injection path.
 *
 * Runs the real Worker module against a mock Durable Object state.
 *
 * Run: node features/groupchat/harness-groupchat-cors.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "worker/src/index.js");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const src = readFileSync(SRC, "utf8");
// The module exports the Durable Object class; import it via a data URL.
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const Cls = mod.GroupChatThread || mod.default;

/** Minimal Durable Object storage + ctx. */
function makeCtx() {
  const map = new Map();
  return {
    storage: {
      get: async (k) => map.get(k),
      put: async (k, v) => { map.set(k, v); },
      delete: async (k) => { map.delete(k); },
    },
  };
}

function make(envOverrides = {}) {
  const ctx = makeCtx();
  const env = { GROUPCHAT_TOKEN: "test-token", ...envOverrides };
  // Construct without running the DO constructor's ctx wiring if it needs one.
  const inst = new Cls(ctx, env);
  inst.ctx = ctx;
  inst.env = env;
  return inst;
}

const req = (path, init = {}) => new Request("https://gc.test" + path, init);

console.log("preflight (OPTIONS)");
{
  const w = make({ ALLOWED_ORIGINS: "https://qwenpawx.pages.dev" });
  const r = await w.fetch(req("/thread", {
    method: "OPTIONS",
    headers: { Origin: "https://qwenpawx.pages.dev" },
  }));
  check("preflight returns 204", r.status === 204, String(r.status));
  check("an allowed origin is echoed back",
    r.headers.get("Access-Control-Allow-Origin") === "https://qwenpawx.pages.dev",
    String(r.headers.get("Access-Control-Allow-Origin")));
  check("Vary: Origin is set (cache correctness)",
    (r.headers.get("Vary") || "").includes("Origin"), String(r.headers.get("Vary")));
  check("the custom auth header is allowed",
    (r.headers.get("Access-Control-Allow-Headers") || "").includes("X-Groupchat-Token"),
    String(r.headers.get("Access-Control-Allow-Headers")));
}

{
  const w = make({ ALLOWED_ORIGINS: "https://qwenpawx.pages.dev" });
  const r = await w.fetch(req("/thread", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.test" },
  }));
  check("an unlisted origin gets NO allow-origin header",
    r.headers.get("Access-Control-Allow-Origin") === null,
    String(r.headers.get("Access-Control-Allow-Origin")));
}

console.log("never a wildcard");
{
  const w = make({ ALLOWED_ORIGINS: "https://qwenpawx.pages.dev" });
  for (const path of ["/", "/thread"]) {
    const r = await w.fetch(req(path, {
      headers: { Origin: "https://qwenpawx.pages.dev", "X-Groupchat-Token": "test-token" },
    }));
    const acao = r.headers.get("Access-Control-Allow-Origin");
    check(`GET ${path} does not answer "*"`, acao !== "*", String(acao));
  }
}

console.log("fail-closed when unconfigured");
{
  const w = make({});
  const r = await w.fetch(req("/", { headers: { Origin: "https://qwenpawx.pages.dev" } }));
  check("no ALLOWED_ORIGINS -> no CORS header at all",
    r.headers.get("Access-Control-Allow-Origin") === null,
    String(r.headers.get("Access-Control-Allow-Origin")));
  check("the request still succeeds server-side (server callers unaffected)",
    r.status === 200, String(r.status));
}

console.log("server-side callers unaffected");
{
  const w = make({ ALLOWED_ORIGINS: "https://qwenpawx.pages.dev" });
  // No Origin header at all — this is the relay.
  const r = await w.fetch(req("/thread", { headers: { "X-Groupchat-Token": "test-token" } }));
  check("a request with no Origin works", r.status === 200, String(r.status));
  check("and carries no CORS header",
    r.headers.get("Access-Control-Allow-Origin") === null);
}

console.log("rate-limited responses also honour the allowlist");
{
  const w = make({ ALLOWED_ORIGINS: "https://qwenpawx.pages.dev" });
  // Drive the limiter past its window using a fixed IP.
  const ip = { "CF-Connecting-IP": "203.0.113.9", Origin: "https://qwenpawx.pages.dev" };
  let last = null;
  for (let i = 0; i < 40; i++) {
    last = await w.fetch(req("/thread/message", {
      method: "POST",
      headers: { ...ip, "X-Groupchat-Token": "test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ author: "default", role: "user", text: "x" }),
    }));
  }
  check("flooding eventually rate-limits", last.status === 429, String(last.status));
  const acao = last.headers.get("Access-Control-Allow-Origin");
  check("the 429 does not answer a wildcard", acao !== "*", String(acao));
}

console.log();
console.log(`${passed} passed, ${failed.length} failed  (${passed + failed.length} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
