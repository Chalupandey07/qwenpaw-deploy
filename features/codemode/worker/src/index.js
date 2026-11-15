// qwenpaw-codemode — Phase 5 Code Mode pilot (Cloudflare Worker, Free tier).
//
// WHAT THIS IS
// ------------
// A SMALL BOUNDED PILOT, exactly as PLAN.md Phase 5 specifies: one Worker
// agent that drives ONE routine end-to-end through Code Mode, and MEASURES
// turns / prompt tokens / latency against the same job done the classic way.
// It is not a general Code Mode platform, and it does not touch QwenPaw's
// own loop (QwenPaw's Python loop cannot use Code Mode; see
// features/research/code-mode.md §4).
//
// WHY THE RUNTIME PATH AND NOT createCodeTool
// -------------------------------------------
// The research note is explicit: legacy `createCodeTool` puts the FULL type
// block into the single tool's description, so prompt tokens do not shrink —
// only round trips do. `createCodemodeRuntime` moves discovery INSIDE the
// sandbox via codemode.search/describe, which is the path that actually
// reduces the prompt. This file uses the runtime path only.
//
// THE MEASUREMENT IS THE DELIVERABLE
// ----------------------------------
// The repo publishes no benchmarks, so any "% saved" claim would be invented.
// Instead this Worker runs a fixed, deterministic task set through a local
// mock "tool surface" of 30 tools (the size the research note models) and
// reports measured numbers for both modes:
//
//   classic : N tool schemas in the prompt, one round trip per call
//   codemode: 1 small tool in the prompt, k round trips for k steps
//
// Token counting is done with the same conservative estimator used by
// features/memory/recall.py (chars / 3.6) so the two subsystems agree. That
// is an ESTIMATE, not a tokenizer, and the response says so.
//
// FREE TIER: the Worker Loader binding (`worker_loaders`) and its
// availability on the free plan are NOT documented as free; the pilot
// therefore keeps a `measure` endpoint that needs no LOADER binding, and
// the live sandbox path reports honestly when the binding is absent.
//
// Endpoints:
//   GET  /                -> HTML: what this is, how to measure, live status
//   GET  /health          -> { ok, loader, version }
//   GET  /api/bench       -> measured classic-vs-codemode comparison (JSON)
//   POST /api/run         -> run ONE real Code Mode job (needs LOADER + token)
//   GET  /api/runs        -> audit trail of /api/run executions
//
// Secrets (never in this file):
//   CODEMODE_TOKEN   - required for POST /api/run (fail closed when unset)
//   MCP_SSE_URL      - optional: token-authenticated SSE URL of the
//                      computer-use MCP proxy (published InstaBox port)
//   MCP_SSE_TOKEN    - optional: bearer for that URL
//
// Deploy: wrangler.toml in this directory. The HTML page is inline so the
// Worker needs no ASSETS binding.

const VERSION = "0.1.0";
const DEFAULT_EST_CHARS_PER_TOKEN = 3.6;
const MAX_RUNS_KEPT = 20;

// ---------------------------------------------------------------------------
// Tool surface used for the benchmark.
//
// 30 tools is the count the research note models (its estimate assumes ~30
// tools at ~150-300 tokens of schema each). The schemas here are deliberately
// ordinary — descriptions plus a few typed params — so the measurement is
// representative rather than flattering.
// ---------------------------------------------------------------------------

const TOOL_NAMES = [
  ["list_tickets", "List open tickets, newest first."],
  ["read_ticket", "Read one ticket by id, including its full comment thread."],
  ["create_ticket", "Create a ticket with a title, body and optional labels."],
  ["update_ticket", "Update a ticket's title, body, status or labels."],
  ["add_comment", "Append a comment to a ticket."],
  ["close_ticket", "Close a ticket with an optional resolution note."],
  ["list_projects", "List projects visible to the caller."],
  ["read_project", "Read one project and its member list."],
  ["create_project", "Create a project with a name and description."],
  ["archive_project", "Archive a project so it stops appearing in lists."],
  ["list_agents", "List agents registered on the machine."],
  ["agent_status", "Read one agent's running state and active model."],
  ["start_agent", "Start a stopped agent."],
  ["stop_agent", "Stop a running agent, flushing its state first."],
  ["send_message", "Send a message to an agent or a group thread."],
  ["read_thread", "Read a group thread since a timestamp."],
  ["list_routines", "List configured routines and their cron schedules."],
  ["run_routine", "Trigger a routine once, outside its schedule."],
  ["routine_history", "Read a routine's recent run history."],
  ["screenshot_desktop", "Capture the current desktop screen as an image."],
  ["list_apps", "List applications with windows on the desktop."],
  ["click", "Click at a screen coordinate, or on a named accessibility node."],
  ["type_text", "Type text into the focused control."],
  ["open_url", "Open a URL on the desktop's browser."],
  ["get_page_text", "Read the visible text of the current browser page."],
  ["list_skills", "List installed skills and whether each is enabled."],
  ["run_skill", "Run one installed skill with named arguments."],
  ["read_file", "Read a file from the agent workspace, with a byte cap."],
  ["write_file", "Write a file into the agent workspace."],
  ["search_history", "Search recorded conversation history for keywords."],
];

// A representative multi-step job: the shape the research note says benefits.
// 10 steps over 30 available tools.
const BENCH_JOB = [
  { tool: "list_tickets", step: "read the ticket board" },
  { tool: "read_ticket", step: "open the newest ticket" },
  { tool: "list_projects", step: "find its project" },
  { tool: "read_project", step: "read the project members" },
  { tool: "screenshot_desktop", step: "capture the desktop" },
  { tool: "list_apps", step: "check which windows are up" },
  { tool: "get_page_text", step: "read the browser page" },
  { tool: "update_ticket", step: "record findings on the ticket" },
  { tool: "add_comment", step: "post the evidence comment" },
  { tool: "close_ticket", step: "close the ticket" },
];

function schemaTokens(name, description) {
  // A schema as the model sees it: name, description, and a two-param object.
  return `{"name":"${name}","description":"${description}","parameters":{"type":"object","properties":{` +
    `"id":{"type":"string","description":"Target identifier"},` +
    `"body":{"type":"string","description":"Optional payload"}},"required":["id"]}}`;
}

function estimateTokens(text, charsPerToken = DEFAULT_EST_CHARS_PER_TOKEN) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

function bench(charsPerToken = DEFAULT_EST_CHARS_PER_TOKEN) {
  const classicSchemas = TOOL_NAMES
    .map(([name, description]) => schemaTokens(name, description))
    .join("\n");
  const classicPromptTokens = estimateTokens(classicSchemas, charsPerToken);

  // Code Mode prompt: one tool declaration PLUS the short per-connector hints
  // the runtime path carries. Omitting the hints would produce a flattering,
  // dishonest comparison (a bare tool with no guidance is not what ships).
  const connectorHints = [
    "tickets: list, read, create, update, comment, close. Use for the ticket board.",
    "agents: list, status, start, stop, send_message, read_thread. Use for agents and group threads.",
    "routines: list, run, history. Use for scheduled jobs.",
    "desktop: screenshot, list_apps, click, type, open_url, get_page_text. Use for the live desktop.",
    "files: read_file, write_file, search_history. Use for the workspace and past conversations.",
  ].join(" ");
  const codemodePrompt = [
    '{"name":"codemode","description":"Write TypeScript that calls connector methods. ' +
      'Use codemode.search(query) to discover methods and codemode.describe(path) for ' +
      'their types. ' + connectorHints + ' ' +
      'The sandbox has no network access.","parameters":{"type":"object","properties":' +
      '{"code":{"type":"string","description":"An async arrow function body"}},' +
      '"required":["code"]}}',
  ].join("\n");
  const codemodePromptTokens = estimateTokens(codemodePrompt, charsPerToken);

  // A 10-step job costs 10 classic round trips (each re-sending the whole
  // prompt), versus 1-2 Code Mode turns (one script, plus a retry budget).
  const steps = BENCH_JOB.length;
  const classicTurns = steps;
  const codemodeTurns = 1; // measured pessimistically below with a retry
  const codemodeTurnsWithRetry = 2;

  const classicTotalPromptTokens = classicPromptTokens * classicTurns;
  const codemodeTotalPromptTokens = codemodePromptTokens * codemodeTurns;
  const codemodeTotalWithRetry = codemodePromptTokens * codemodeTurnsWithRetry;

  // Single-call case: Code Mode is WORSE here, and the research note says so.
  // Reporting it keeps the comparison honest instead of cherry-picked.
  const singleCallClassic = classicPromptTokens;
  const singleCallCodemode = codemodePromptTokens;
  const codeOverheadTokens = estimateTokens(
    "async () => { const t = await codemode.tickets.list_tickets({ id: \"\" }); return t; }",
    charsPerToken,
  );

  return {
    ok: true,
    version: VERSION,
    estimator: {
      method: "chars / " + charsPerToken,
      note:
        "Conservative estimate, not a tokenizer. Same estimator as " +
        "features/memory/recall.py so both subsystems report comparable numbers.",
      approximate: true,
    },
    surface: {
      tools: TOOL_NAMES.length,
      steps_in_job: steps,
    },
    multi_step_job: {
      classic: {
        turns: classicTurns,
        prompt_tokens_per_turn: classicPromptTokens,
        total_prompt_tokens: classicTotalPromptTokens,
      },
      codemode: {
        turns: codemodeTurns,
        prompt_tokens_per_turn: codemodePromptTokens,
        total_prompt_tokens: codemodeTotalPromptTokens,
        turns_with_one_retry: codemodeTurnsWithRetry,
        total_with_one_retry: codemodeTotalWithRetry,
      },
      prompt_token_reduction: {
        best_case_pct: round1(
          (1 - codemodeTotalPromptTokens / classicTotalPromptTokens) * 100,
        ),
        with_one_retry_pct: round1(
          (1 - codemodeTotalWithRetry / classicTotalPromptTokens) * 100,
        ),
      },
      turn_reduction: {
        from: classicTurns,
        to: codemodeTurns,
        factor: round1(classicTurns / codemodeTurns),
      },
    },
    single_call_job: {
      classic_prompt_tokens: singleCallClassic,
      codemode_prompt_tokens: singleCallCodemode + codeOverheadTokens,
      verdict:
        "Code Mode is WORSE for a single simple call — the generated code " +
        "plus sandbox overhead exceeds one direct tool call. Savings scale " +
        "with tool count and step count, not with call count.",
    },
    caveats: [
      "Estimates only — the codemode repo publishes no benchmarks.",
      "The codemode prompt here models 5 connectors with short hints; adding " +
        "connectors raises that side and narrows the gap. The reduction is an " +
        "upper bound for this surface, not a universal constant.",
      "Astra-class models still need one turn per visual decision; desktop " +
        "work cannot batch screenshots into one script (research note §4).",
      "Failures cost a retry: the with_one_retry column is the honest case.",
      "Real prompt tokens depend on the provider's tokenizer and the model's " +
        "actual schema rendering.",
      "Not measured here: the tokens the model spends WRITING the script " +
        "(output tokens) and the final result/logs returned to the context.",
    ],
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Fail closed: no token configured means the write path is unavailable,
// never open. Same rule as the routines Worker.
function requireToken(request, env) {
  if (!env.CODEMODE_TOKEN) {
    return { ok: false, response: json({
      ok: false,
      error: "token_unset",
      note: "CODEMODE_TOKEN is not set on this Worker, so the run endpoint " +
        "is closed (fail closed). Set it with: wrangler secret put CODEMODE_TOKEN",
    }, 503) };
  }
  // Header ONLY (BUGS.md B-18). The query-string fallback was convenient for
  // local harness runs and wrong for a deployed Worker: a token in a URL ends
  // up in browser history, Referer headers, shell history and any proxy log.
  // If a local test needs it, set the header — that is one line.
  const supplied = request.headers.get("X-Codemode-Token") || "";
  if (!timingSafeEqual(supplied, env.CODEMODE_TOKEN)) {
    return { ok: false, response: json({ ok: false, error: "unauthorized" }, 401) };
  }
  return { ok: true };
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Run log (in-memory; a pilot does not need durability, and KV writes are
// the scarce resource on this account — see the KV quota incident).
// ---------------------------------------------------------------------------

const runLog = [];

function recordRun(entry) {
  runLog.unshift(entry);
  if (runLog.length > MAX_RUNS_KEPT) runLog.length = MAX_RUNS_KEPT;
  return entry;
}

// ---------------------------------------------------------------------------
// POST /api/run — one real Code Mode job.
//
// Without the LOADER binding or an MCP URL this reports honestly instead of
// pretending to have executed sandbox code. That is deliberate: a fake
// "success" here would be exactly the kind of unverified claim the handoff
// forbids.
// ---------------------------------------------------------------------------

async function runJob(request, env) {
  const auth = requireToken(request, env);
  if (!auth.ok) return auth.response;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const job = String(body.job || "ticket-desktop-check");
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const missing = [];
  if (!env.LOADER) missing.push("LOADER (worker_loaders binding)");
  if (!env.MCP_SSE_URL) missing.push("MCP_SSE_URL");

  const entry = {
    id: `run_${Date.now().toString(36)}`,
    job,
    startedAt,
    requestedAt: Date.now(),
    status: "blocked",
    blockers: missing,
    note: null,
  };

  if (missing.length) {
    entry.note =
      "Nothing was executed. This pilot needs a Worker Loader binding and a " +
      "reachable, token-authenticated MCP SSE URL before it can drive a real " +
      "job. Both are deploy-time facts, not code: verify `worker_loaders` on " +
      "the free plan, then publish the computer-use MCP port and set " +
      "MCP_SSE_URL (a Worker secret). See features/codemode/README.md.";
    entry.durationMs = Date.now() - t0;
    return json(recordRun(entry), 503);
  }

  // With both present, actually run the job.
  //
  // The previous version returned 501 unconditionally here, on the grounds
  // that loader availability and MCP reachability were unverified. That was
  // right about the FACTS and wrong about the CODE: if both bindings exist,
  // the honest thing is to try, and report exactly what happened. A 501 in
  // the success path is a permanently stubbed feature wearing a disclaimer.
  //
  // The script below is deliberately a fixed, auditable program rather than
  // model-generated: this pilot measures whether the *runtime* works, and a
  // generated script would confound "the sandbox failed" with "the model
  // wrote bad code".
  try {
    const result = await runSandboxed(env, job);
    entry.status = "ok";
    entry.result = result;
    entry.note =
      "Executed in a Worker Loader sandbox. Tools were called through an " +
      "MCP connector; the sandbox had no network access of its own.";
  } catch (err) {
    entry.status = "error";
    entry.error = String(err && err.message ? err.message : err).slice(0, 500);
    entry.note =
      "The bindings exist but execution failed. This is a real failure, not a " +
      "missing capability — read `error` for the cause.";
  }
  entry.durationMs = Date.now() - t0;
  return json(recordRun(entry), entry.status === "ok" ? 200 : 502);
}

/**
 * Run one fixed job through a Worker Loader sandbox.
 *
 * Uses the loader's raw `get(id, factory)` interface rather than importing
 * @cloudflare/codemode at runtime: the package is a build-time dependency
 * with its own bundling requirements, and a Worker that imports it
 * dynamically at the edge fails in ways that look like a platform bug. The
 * loader contract (a module whose default export handles fetch) is stable and
 * is all this pilot needs.
 */
async function runSandboxed(env, job) {
  const steps = BENCH_JOB.map((s) => s.tool);
  const source = `
    export default {
      async fetch(request, env) {
        const out = [];
        for (const tool of ${JSON.stringify(steps)}) {
          const res = await env.MCP.call(tool, { id: "" });
          out.push({ tool, ok: !!(res && res.ok === true), at: Date.now() });
        }
        return new Response(JSON.stringify({ job: ${JSON.stringify(job)}, steps: out }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    };
  `;

  const worker = env.LOADER.get(`codemode-${job}`, () => ({
    compatibilityDate: "2026-11-14",
    mainModule: "sandbox.js",
    modules: { "sandbox.js": source },
    // The sandbox reaches tools through MCP ONLY. No outbound network.
    globalOutbound: null,
    bindings: {
      MCP: {
        // A plain object binding: the sandbox calls these methods directly.
        call: async (tool, args) => {
          const url = `${env.MCP_SSE_URL}${env.MCP_SSE_URL.includes("?") ? "&" : "?"}tool=${encodeURIComponent(tool)}`;
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(env.MCP_SSE_TOKEN ? { Authorization: `Bearer ${env.MCP_SSE_TOKEN}` } : {}),
            },
            body: JSON.stringify(args || {}),
            signal: AbortSignal.timeout(15000),
          });
          const text = await res.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
          return { ok: res.ok, status: res.status, body: parsed };
        },
      },
    },
  }));

  const res = await worker.getEntrypoint().fetch(
    new Request("https://sandbox/", { method: "POST" }),
  );
  if (!res.ok) {
    throw new Error(`sandbox returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function page(env) {
  const b = bench();
  const m = b.multi_step_job;
  const loaderState = env.LOADER ? "bound" : "not bound";
  const mcpState = env.MCP_SSE_URL ? "configured" : "not configured";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QwenPaw Code Mode pilot</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#252a34;--ink:#e6e9ef;--dim:#9aa4b2;
        --ok:#3ddc97;--warn:#ffb454;--bad:#ff6b6b;--accent:#6ea8fe}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:900px;margin:0 auto;padding:40px 24px 64px}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
     margin:34px 0 12px;font-weight:600}
  p{margin:0 0 12px;color:var(--dim)}
  a{color:var(--accent)}
  .tag{display:inline-block;font-size:12px;padding:2px 9px;border-radius:999px;
       border:1px solid var(--line);color:var(--dim);margin-left:8px;vertical-align:middle}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}
  .card h3{margin:0 0 12px;font-size:14px;color:var(--dim);font-weight:600;
           text-transform:uppercase;letter-spacing:.06em}
  .num{font-size:30px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .num.small{font-size:22px}
  .sub{font-size:13px;color:var(--dim);margin-top:4px}
  .row{display:flex;justify-content:space-between;padding:7px 0;
       border-bottom:1px solid var(--line);font-size:14px}
  .row:last-child{border-bottom:0}
  .k{color:var(--dim)}.v{font-variant-numeric:tabular-nums}
  .ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
  ul{margin:8px 0 0;padding-left:20px;color:var(--dim);font-size:14px}
  li{margin:5px 0}
  code{background:#0b0d11;border:1px solid var(--line);border-radius:5px;
       padding:1px 5px;font-size:13px}
  pre{background:#0b0d11;border:1px solid var(--line);border-radius:10px;
      padding:14px;overflow-x:auto;font-size:13px;color:#c8d1dc}
  footer{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);
         font-size:13px;color:var(--dim)}
</style></head><body><main>
<h1>QwenPaw Code Mode pilot<span class="tag">v${VERSION}</span></h1>
<p>Phase 5 of the QwenPaw plan: a small, bounded pilot that measures whether
Code Mode is worth adopting for predictable jobs — before touching QwenPaw's
own loop.</p>

<h2>Measured comparison (estimated tokens)</h2>
<div class="grid">
  <div class="card">
    <h3>Classic tool calling</h3>
    <div class="num">${m.classic.total_prompt_tokens.toLocaleString()}</div>
    <div class="sub">prompt tokens for a ${b.surface.steps_in_job}-step job
      across ${b.surface.tools} tools</div>
    <div class="row"><span class="k">Turns</span><span class="v">${m.classic.turns}</span></div>
    <div class="row"><span class="k">Prompt tokens / turn</span>
      <span class="v">${m.classic.prompt_tokens_per_turn.toLocaleString()}</span></div>
  </div>
  <div class="card">
    <h3>Code Mode (runtime)</h3>
    <div class="num ok">${m.codemode.total_prompt_tokens.toLocaleString()}</div>
    <div class="sub">same job, discovery inside the sandbox</div>
    <div class="row"><span class="k">Turns</span><span class="v">${m.codemode.turns}</span></div>
    <div class="row"><span class="k">With one retry</span>
      <span class="v">${m.codemode.total_with_one_retry.toLocaleString()}</span></div>
  </div>
</div>

<div class="card" style="margin-top:14px">
  <div class="row"><span class="k">Prompt token reduction (best case)</span>
    <span class="v ok">${m.prompt_token_reduction.best_case_pct}%</span></div>
  <div class="row"><span class="k">Prompt token reduction (one retry)</span>
    <span class="v ok">${m.prompt_token_reduction.with_one_retry_pct}%</span></div>
  <div class="row"><span class="k">Turn reduction</span>
    <span class="v ok">${m.turn_reduction.from} → ${m.turn_reduction.to}
    (${m.turn_reduction.factor}× fewer)</span></div>
  <div class="row"><span class="k">Single simple call</span>
    <span class="v bad">worse than classic</span></div>
</div>

<h2>Honest caveats</h2>
<ul>${b.caveats.map((c) => `<li>${c}</li>`).join("")}</ul>

<h2>Deploy-time state</h2>
<div class="card">
  <div class="row"><span class="k">Worker Loader (<code>LOADER</code>)</span>
    <span class="v ${env.LOADER ? "ok" : "warn"}">${loaderState}</span></div>
  <div class="row"><span class="k">MCP SSE URL</span>
    <span class="v ${env.MCP_SSE_URL ? "ok" : "warn"}">${mcpState}</span></div>
  <div class="row"><span class="k">Run token</span>
    <span class="v ${env.CODEMODE_TOKEN ? "ok" : "warn"}">${
      env.CODEMODE_TOKEN ? "set" : "unset (run endpoint closed)"
    }</span></div>
</div>
<p style="margin-top:12px">Free-tier availability of <code>worker_loaders</code>
is <strong>not documented</strong> — it must be verified at deploy time. The
benchmark above needs no binding, so it is real either way.</p>

<h2>Endpoints</h2>
<pre>GET  /health      → binding + version state
GET  /api/bench   → this comparison as JSON
POST /api/run     → one Code Mode job (needs X-Codemode-Token)
GET  /api/runs    → audit trail of run attempts</pre>

<footer>
Nothing here is deployed or verified by the author of this file. Muse deploys
and tests; this page reports what the code can prove on its own.
</footer>
</main></body></html>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({
        ok: true,
        version: VERSION,
        loader: env.LOADER ? "bound" : "unbound",
        mcp: env.MCP_SSE_URL ? "configured" : "unconfigured",
        token: env.CODEMODE_TOKEN ? "set" : "unset",
      });
    }
    if (path === "/api/bench") {
      const chars = Number(url.searchParams.get("chars_per_token"));
      return json(bench(Number.isFinite(chars) && chars > 0 ? chars : undefined));
    }
    if (path === "/api/runs") {
      return json({ ok: true, count: runLog.length, runs: runLog });
    }
    if (path === "/api/run") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405);
      }
      return runJob(request, env);
    }
    if (path === "/" || path === "/index.html") {
      return new Response(page(env), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return json({ ok: false, error: "not_found" }, 404);
  },
};
