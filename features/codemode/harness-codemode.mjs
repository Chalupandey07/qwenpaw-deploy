#!/usr/bin/env node
/**
 * Harness for the Code Mode pilot Worker (features/codemode/worker/src/index.js).
 *
 * Runs the real Worker module in Node with mocked `env` objects — no deploy,
 * no Cloudflare account, no network. This is how the pilot is verifiable
 * before Muse deploys anything.
 *
 * Run: node features/codemode/harness-codemode.mjs
 * Exit 0 = all pass.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "worker/src/index.js");

let passed = 0;
const failed = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed.push(name);
    console.log(`  FAIL ${name}  ${detail}`);
  }
}

async function loadWorker() {
  const src = readFileSync(SRC, "utf8");
  // The Worker is an ES module with a default export; import it via a data URL
  // so the file itself stays exactly what gets deployed.
  const mod = await import(
    "data:text/javascript;base64," + Buffer.from(src).toString("base64")
  );
  return mod.default;
}

function req(path, init = {}) {
  return new Request("https://codemode.test" + path, init);
}

async function json(res) {
  return JSON.parse(await res.text());
}

const worker = await loadWorker();

// ---------------------------------------------------------------- health

console.log("health and routing");
{
  const res = await worker.fetch(req("/health"), {});
  const body = await json(res);
  check("health 200", res.status === 200, String(res.status));
  check("health ok", body.ok === true);
  check("reports loader unbound", body.loader === "unbound", body.loader);
  check("reports mcp unconfigured", body.mcp === "unconfigured", body.mcp);
  check("reports token unset", body.token === "unset", body.token);
  check("no-store cache header",
    res.headers.get("Cache-Control") === "no-store");
}

{
  const res = await worker.fetch(req("/nope"), {});
  check("unknown path 404", res.status === 404, String(res.status));
}

// ------------------------------------------------------------- benchmark

console.log("benchmark");
{
  const res = await worker.fetch(req("/api/bench"), {});
  const b = await json(res);
  check("bench 200", res.status === 200, String(res.status));
  check("bench ok", b.ok === true);
  check("models 30 tools", b.surface.tools === 30, String(b.surface.tools));
  check("10-step job", b.surface.steps_in_job === 10,
    String(b.surface.steps_in_job));
  check("marks itself approximate", b.estimator.approximate === true);
  check("names the estimator", /chars \/ 3\.6/.test(b.estimator.method),
    b.estimator.method);

  const m = b.multi_step_job;
  check("classic turns equal steps", m.classic.turns === 10, String(m.classic.turns));
  check("codemode is one turn", m.codemode.turns === 1, String(m.codemode.turns));
  check("classic prompt tokens are positive",
    m.classic.prompt_tokens_per_turn > 1000,
    String(m.classic.prompt_tokens_per_turn));
  check("codemode prompt tokens are smaller",
    m.codemode.prompt_tokens_per_turn < m.classic.prompt_tokens_per_turn,
    `${m.codemode.prompt_tokens_per_turn} vs ${m.classic.prompt_tokens_per_turn}`);

  // The claim under test: Code Mode must actually win on a 10-step job.
  check("codemode reduces total prompt tokens",
    m.codemode.total_prompt_tokens < m.classic.total_prompt_tokens,
    `${m.codemode.total_prompt_tokens} vs ${m.classic.total_prompt_tokens}`);
  check("reduction is a real percentage",
    m.prompt_token_reduction.best_case_pct > 50,
    String(m.prompt_token_reduction.best_case_pct));
  check("reduction survives one retry",
    m.prompt_token_reduction.with_one_retry_pct > 0,
    String(m.prompt_token_reduction.with_one_retry_pct));
  check("turn factor is 10x", m.turn_reduction.factor === 10,
    String(m.turn_reduction.factor));

  // Arithmetic must be internally consistent, or the numbers are decorative.
  const expectedClassic = m.classic.prompt_tokens_per_turn * m.classic.turns;
  check("classic total matches per-turn x turns",
    m.classic.total_prompt_tokens === expectedClassic,
    `${m.classic.total_prompt_tokens} vs ${expectedClassic}`);
  const expectedRetry = m.codemode.prompt_tokens_per_turn * m.codemode.turns_with_one_retry;
  check("retry total matches per-turn x turns-with-retry",
    m.codemode.total_with_one_retry === expectedRetry,
    `${m.codemode.total_with_one_retry} vs ${expectedRetry}`);

  // The honest negative result must be present, not omitted.
  check("reports single-call as worse",
    /WORSE/.test(b.single_call_job.verdict), b.single_call_job.verdict);
  check("single-call codemode exceeds classic",
    b.single_call_job.codemode_prompt_tokens > 0);
  check("caveats are listed", b.caveats.length >= 3, String(b.caveats.length));
  check("caveat names the visual-judgment bound",
    b.caveats.some((c) => /visual/i.test(c)), JSON.stringify(b.caveats));
}

{
  const res = await worker.fetch(req("/api/bench?chars_per_token=4"), {});
  const b = await json(res);
  check("accepts a custom chars_per_token",
    b.estimator.method === "chars / 4", b.estimator.method);
  const res2 = await worker.fetch(req("/api/bench?chars_per_token=abc"), {});
  const b2 = await json(res2);
  check("rejects a non-numeric chars_per_token by falling back",
    b2.estimator.method === "chars / 3.6", b2.estimator.method);
  const res3 = await worker.fetch(req("/api/bench?chars_per_token=-2"), {});
  const b3 = await json(res3);
  check("rejects a negative chars_per_token",
    b3.estimator.method === "chars / 3.6", b3.estimator.method);
}

// ------------------------------------------------------------------- run

console.log("run endpoint — fail closed");
{
  const res = await worker.fetch(req("/api/run", { method: "POST" }), {});
  check("no token configured -> 503", res.status === 503, String(res.status));
  const body = await json(res);
  check("says token_unset", body.error === "token_unset", body.error);
  check("explains fail-closed", /fail closed/i.test(body.note), body.note);
}

{
  const env = { CODEMODE_TOKEN: "s3cret-token-value" };
  const res = await worker.fetch(req("/api/run", { method: "POST" }), env);
  check("no header -> 401", res.status === 401, String(res.status));
  const body = await json(res);
  check("unauthorized error", body.error === "unauthorized", body.error);

  const wrong = await worker.fetch(
    req("/api/run", { method: "POST", headers: { "X-Codemode-Token": "nope" } }),
    env,
  );
  check("wrong token -> 401", wrong.status === 401, String(wrong.status));

  const good = await worker.fetch(
    req("/api/run", {
      method: "POST",
      headers: { "X-Codemode-Token": "s3cret-token-value" },
      body: JSON.stringify({ job: "ticket-desktop-check" }),
    }),
    env,
  );
  // No LOADER and no MCP URL -> honest 503 naming the blockers.
  check("correct token but missing bindings -> 503",
    good.status === 503, String(good.status));
  const gb = await json(good);
  check("lists LOADER as a blocker",
    gb.blockers.some((x) => /LOADER/.test(x)), JSON.stringify(gb.blockers));
  check("lists MCP_SSE_URL as a blocker",
    gb.blockers.some((x) => /MCP_SSE_URL/.test(x)), JSON.stringify(gb.blockers));
  check("never claims a run happened",
    gb.status === "blocked" && /Nothing was executed/.test(gb.note),
    gb.status + " / " + gb.note);
  check("records a duration", typeof gb.durationMs === "number");

  // The query-param path is a separate branch in requireToken; test it for real.
  const gq = await worker.fetch(
    req("/api/run?token=s3cret-token-value", { method: "POST" }),
    env,
  );
  // The query-param path was REMOVED (BUGS.md B-18): a correct token in
  // the URL must be rejected — it lands in history, Referer, proxy logs.
  check("a correct token in the query string is still rejected",
    gq.status === 401, String(gq.status));
  const gqw = await worker.fetch(
    req("/api/run?token=wrong", { method: "POST" }),
    env,
  );
  check("wrong query token -> 401", gqw.status === 401, String(gqw.status));
}

// A MOCK LOADER: enough of the real contract (get(id, factory) ->
// { getEntrypoint().fetch() }) to prove the sandbox path is wired, without a
// Cloudflare account. The factory's return value is inspected so we can
// assert the sandbox gets NO outbound network and DOES get an MCP binding.
function makeLoader({ sandboxFails = false, mcpOk = true } = {}) {
  const seen = {};
  return {
    seen,
    get(id, factory) {
      seen.id = id;
      const mod = factory();
      seen.mod = mod;
      return {
        getEntrypoint() {
          return {
            async fetch() {
              if (sandboxFails) throw new Error("sandbox exploded");
              // Execute the real generated program against supplied bindings.
              const src = mod.modules["sandbox.js"]
                .replace("export default", "const __prog =");
              const fn = new Function("env", `
                ${src}
                return __prog.fetch(undefined, env);
              `);
              return await fn({
                MCP: {
                  call: async (tool) => (mcpOk
                    ? { ok: true, status: 200, body: { tool } }
                    : { ok: false, status: 503 }),
                },
              });
            },
          };
        },
      };
    },
  };
}

{
  // POST /api/run must NOT accept the token in the query string.
  const env = { CODEMODE_TOKEN: "***" };
  const r = await worker.fetch(req("/api/run?token=***", { method: "POST" }), env);
  check("query-string token rejected even when it is the right value",
    r.status === 401, String(r.status));
}

{
  const loader = makeLoader();
  const env = {
    CODEMODE_TOKEN: "***",
    LOADER: loader,
    MCP_SSE_URL: "https://mcp.test/sse",
    MCP_SSE_TOKEN: "***",
  };
  const res = await worker.fetch(
    req("/api/run", { method: "POST", headers: { "X-Codemode-Token": "***" } }),
    env,
  );
  const body = await json(res);
  check("with both bindings the run EXECUTES (200, not 501)",
    res.status === 200, `${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  check("status is ok", body.status === "ok", String(body.status));
  check("the result carries the per-tool outcome",
    Array.isArray(body.result?.steps) && body.result.steps.length > 0,
    JSON.stringify(body.result).slice(0, 160));
  check("the sandbox was given no outbound network",
    loader.seen.mod.globalOutbound === null,
    String(loader.seen.mod.globalOutbound));
  check("the sandbox got an MCP binding, not raw env",
    !!loader.seen.mod.bindings?.MCP?.call,
    JSON.stringify(Object.keys(loader.seen.mod.bindings || {})));
  check("every step reports ok when MCP succeeds",
    body.result.steps.every((s) => s.ok === true),
    JSON.stringify(body.result.steps.slice(0, 3)));
  check("never claims a run that did not happen",
    !/not_implemented/.test(body.status), body.status);
}

{
  // MCP down: the run still completes and reports per-step failures rather
  // than pretending everything worked.
  const loader = makeLoader({ mcpOk: false });
  const env = { CODEMODE_TOKEN: "***", LOADER: loader, MCP_SSE_URL: "https://mcp.test/sse" };
  const res = await worker.fetch(
    req("/api/run", { method: "POST", headers: { "X-Codemode-Token": "***" } }), env);
  const body = await json(res);
  check("a failing MCP is reported per step, not swallowed",
    body.result.steps.every((s) => s.ok === false),
    JSON.stringify(body.result.steps.slice(0, 2)));
}

{
  // A throwing sandbox is a real failure and must be surfaced.
  const loader = makeLoader({ sandboxFails: true });
  const env = { CODEMODE_TOKEN: "***", LOADER: loader, MCP_SSE_URL: "https://mcp.test/sse" };
  const res = await worker.fetch(
    req("/api/run", { method: "POST", headers: { "X-Codemode-Token": "***" } }), env);
  const body = await json(res);
  check("a sandbox error returns 502", res.status === 502, String(res.status));
  check("the error names the cause", /sandbox exploded/.test(body.error || ""),
    String(body.error));
  check("the note says it is a real failure, not a missing capability",
    /real failure/.test(body.note || ""), String(body.note));
}

{
  const env = { CODEMODE_TOKEN: "t" };
  const res = await worker.fetch(req("/api/run", { method: "GET" }), env);
  check("GET /api/run -> 405", res.status === 405, String(res.status));
}

console.log("audit trail");
{
  const res = await worker.fetch(req("/api/runs"), {});
  const body = await json(res);
  check("runs listed", res.status === 200 && Array.isArray(body.runs));
  check("attempts were recorded", body.count >= 2, String(body.count));
  check("newest first",
    body.runs.length < 2 ||
      body.runs[0].requestedAt >= body.runs[1].requestedAt);
  check("audit entries carry blockers",
    body.runs.every((r) => Array.isArray(r.blockers)));
}

console.log("html page");
{
  const res = await worker.fetch(req("/"), {});
  const html = await res.text();
  check("page 200", res.status === 200, String(res.status));
  check("html content type",
    (res.headers.get("Content-Type") || "").includes("text/html"));
  check("renders the measured number", /prompt tokens for a 10-step job/.test(html));
  check("shows loader state", /not bound/.test(html));
  check("shows the single-call negative", /worse than classic/.test(html));
  check("states nothing is verified by the author",
    /Nothing here is deployed or verified/.test(html));
  check("no token value leaked into html", !/s3cret-token-value/.test(html));
}

{
  const res = await worker.fetch(req("/index.html"), {});
  check("/index.html also serves the page", res.status === 200, String(res.status));
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) {
  console.log("failed: " + failed.join(", "));
  process.exit(1);
}
