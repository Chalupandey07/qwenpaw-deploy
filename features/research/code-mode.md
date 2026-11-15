# Cloudflare Code Mode — research note

Source: `cloudflare/agents` repo (cloned 2026-11-15, `main`, package
`@cloudflare/codemode` v0.5.6). Status in repo: **Experimental — may have
breaking changes. Use with caution in production.** (README header.)

Local clone for reference: `~/workspace/research/cloudflare-agents/`

## 1. What Code Mode is

Instead of the model calling tools one at a time, the model gets **one tool**
(`codemode({ code })`) and writes TypeScript/JavaScript that orchestrates
many operations inside a sandboxed Worker. The repo's own summary: "LLMs are
better at writing code than calling tools — they've seen millions of lines of
real-world code but only contrived tool-calling examples."

Two layers, do not confuse them:

| Layer | What it is | Token behaviour |
|---|---|---|
| **Legacy `createCodeTool`** (`@cloudflare/codemode/ai`, `createCodeTool({ tools, executor })`) | Generates TypeScript types from your tool providers and builds ONE AI-SDK tool whose description contains the full type block (`{{types}}` replaced by the generated types — verified in `packages/codemode/src/tool.ts:102-117`). The model writes an `async () => {...}` function calling `codemode.toolName(args)`. | All tool schemas ARE still in the prompt (same as classic tool calling). Savings come only from fewer round trips, not from a smaller prompt. Also `resolveProvider` **filters out** tools with `needsApproval` instead of pausing (verified `tool.ts:82-89`). |
| **Runtime `createCodemodeRuntime`** (`createCodemodeRuntime({ ctx, executor, connectors })`, `runtime.tool()`) | Durable engine on a Durable Object facet. Connectors are classes (MCP / OpenAPI / AI-SDK toolset / custom). The model discovers tools **inside the sandbox** via `codemode.search(query)` / `codemode.describe(target)`; results return into the running code, **not into the context window** (verified `docs/codemode/runtime.md`). The tool description carries only short per-connector hints, not full schemas (verified `packages/codemode/src/proxy-tool.ts`). | This is the path that actually shrinks the prompt. |

### The sandbox SDK (what the model writes)

```ts
async () => {
  const matches = await codemode.search("open pull requests");   // discover
  const docs = await codemode.describe(matches.results[0].path); // learn, on demand
  const prs = await github.list_pull_requests({ owner, repo, state: "open" }); // act
  const stamp = await codemode.step("now", () => Date.now());    // do-once (replay-safe)
  return { count: prs.length, stamp };
};
// reuse: const prs = await codemode.run("open-prs", { owner, repo });
```

### How the code runs

1. `createCodeTool` / `runtime.tool()` builds the tool; the LLM writes an async
   arrow function (AST-normalised via acorn, markdown fences stripped).
2. `DynamicWorkerExecutor` spins up an isolated Worker via a **Worker Loader**
   binding (`env.LOADER`), one `ToolDispatcher` per namespace; calls route back
   via Workers RPC through a `Proxy` per namespace.
3. Console output is captured and returned with the result.
4. **Network isolation: external `fetch()` / `connect()` are blocked by default**
   (`globalOutbound: null`, enforced at the Workers runtime level). Controlled
   outbound access only by passing a `Fetcher` as `globalOutbound`.
5. Default execution timeout **60,000 ms** (`DEFAULT_DYNAMIC_WORKER_EXECUTION_TIMEOUT_MS`,
   `packages/codemode/src/executor.ts:261`), configurable via `timeout` option.
   The `Executor` interface is minimal and replaceable (Node VM, QuickJS,
   containers) — `DynamicWorkerExecutor` is just the Workers implementation.

### Connectors

- **`McpConnector`** — wraps an MCP connection; each MCP tool becomes one
  method on the connector namespace (`github.list_pull_requests(...)`).
  Fetches tools via `listTools()`, dispatches via
  `connection.client.callTool()`; tool names sanitised to valid JS identifiers
  (verified `packages/codemode/src/connectors/mcp.ts`). The `tool(name, t)`
  hook decorates derived tools (e.g. mark `create_issue` `requiresApproval`).
- **`OpenApiConnector`** — spec read **once, host-side**; one typed tool per
  operation, derived on the host at zero prompt-token cost; `request()` does
  the authenticated fetch; low-level `request` tool is the escape hatch.
- **`CodemodeConnector` (base)** — `name()`, `instructions()`, `tools()`; each
  tool carries description, schema, `requiresApproval`, `execute`, optional
  `revert` (rollback). An AI-SDK `ToolSet` is shape-compatible.
- **ToolProviders** — compose capabilities from different packages under
  namespaces (`codemode.*`, `workspace.*`, `db.*`) in one sandbox run.

### Approvals, durability, snippets (runtime only)

- A `requiresApproval: true` call **pauses** the run; the tool returns
  `{ status: "paused", executionId, pending }`. After
  `runtime.approve({ executionId })` the same code re-runs: completed calls
  **replay from the durable log**, the approved action executes, the script
  continues — the model never writes pause/resume logic (verified
  `docs/codemode/approvals.md`, `docs/codemode/runtime.md`).
- Handle methods: `pending()`, `approve()`, `reject()`, `rollback()`
  (reverts applied actions in reverse via each tool's `revert`),
  `executions()` (audit trail), `expirePaused()`, `saveSnippet()` /
  `snippets()` / `deleteSnippet()`.
- **Snippets**: durable saved scripts; the model re-runs them by name via
  `codemode.run("name")`; they appear in `codemode.search` results.
- The runtime is a Durable Object facet (`CodemodeRuntime`); the Vite plugin
  (`@cloudflare/codemode/vite`) exports it so `createCodemodeRuntime()` can
  spawn it. Runtime state (tool-call log, pending approvals, snippets)
  survives hibernation/DO restarts — that is the whole point of the runtime
  vs the stateless executor.

### Other executors

- `IframeSandboxExecutor` (`@cloudflare/codemode/browser`) — runs code in a
  browser iframe against browser-owned tools; timeout cannot preempt tight
  synchronous loops.
- TanStack AI variant: `@cloudflare/codemode/tanstack-ai`
  (`createCodeTool`, `tanstackTools`).

## 2. Setup (from the repo)

Requirements: Node.js, Wrangler, a Cloudflare account. Install:

```sh
npm install @cloudflare/codemode agents ai zod   # Vercel AI SDK flavour
```

`wrangler.jsonc` needs (verified `examples/codemode/wrangler.jsonc`):

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "Codemode", "class_name": "Codemode" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Codemode"] }],
  "ai": { "binding": "AI", "remote": true },
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

Vite plugin (`vite.config.ts`):
`plugins: [agents(), codemode(), cloudflare()]`.

Run: `npm install` (repo root) → `npm run build` → `npm start` in the
example dir (Vite dev server); or `npx wrangler dev` for the Worker.
No plan requirement for the Worker Loader binding is stated anywhere in the
codemode docs — verify at deploy time on the free tier; the docs do not claim
it needs a paid plan.

Working examples (verified present in repo):
- `examples/codemode/` — project-management chat app (10 SQLite tools,
  `AIChatAgent` + `createCodeTool` + `DynamicWorkerExecutor`, Workers AI model
  `@cf/moonshotai/kimi-k2.7-code`, deploy-to-Cloudflare button). Try: "Create a
  project called Alpha", "Add 3 tasks to Alpha".
- `examples/codemode-connectors/` — runtime + MCP and OpenAPI connectors.
- `examples/codemode-browser/` — browser iframe executor.

## 3. Token economics (my calculation — the repo gives NO benchmarks)

The repo's claim is qualitative only ("thousands of prompt tokens … mostly
for tools it won't call"). No measured percentages exist in the repo; treat
any % as an estimate, not a fact.

- **Classic style, ~30 tools:** each tool schema is ~150–300 tokens, so
  ~4,500–9,000 tokens of tool definitions ride in the prompt on **every**
  request/turn, plus one full LLM round trip per tool call (each turn re-sends
  the conversation + tool definitions).
- **Runtime Code Mode:** the prompt carries one small tool (the codemode tool
  + short connector hints, roughly 500–1,500 tokens). Type info is pulled
  on demand inside the sandbox and never enters the context window. A
  10-step workflow (screenshot → observe → click → type → screenshot …)
  becomes 1–2 LLM turns instead of ~10.
- **Rough estimate (assumptions stated):** for a 10-step workflow with 30
  available tools, prompt tokens per turn fall from ~6–10K to ~1–2K, and
  turns fall from ~10 to ~1–2 — i.e. order-of-magnitude fewer tokens on
  multi-step work. For a single simple call, Code Mode is **worse** (the code
  the model writes + sandbox overhead exceeds one direct call). Savings scale
  with tool count and step count; they are mostly prompt-side at high tool
  counts, mostly turn-count at high step counts.
- **New costs:** the code the model writes, `search`/`describe` results
  (inside the sandbox, not the context — but the final result + logs DO come
  back), and retries when generated code fails.
- **Legacy `createCodeTool` does NOT shrink the prompt** (full type block in
  the description) — only the runtime path does. Do not build the legacy path
  expecting prompt savings.

## 4. How it fits OUR system

Our system: QwenPaw v2.3.0 (Python agent, its own console + LLM tool loop —
**not** built on the Vercel AI SDK) in Docker on InstaBox Free; computer-use
MCP (open-computer-use, 9 tools incl. `list_apps`, `get_app_state`,
screenshot, click, type) via mcp-proxy over SSE at `172.18.0.1:8898` inside
the machine; Cloudflare Workers (keep-alive cron, routines cron+KV,
group-chat Durable Object, ticket board) + Pages proxy; LLM is GPT Astra
(OpenAI-compatible, 922K context).

### What is true from the source
- The agents SDK MCP client supports **remote** transports:
  `StreamableHTTPClientTransport` and `SSEClientTransport` (verified
  `packages/agents/src/mcp/client/connection.ts:1028,1039`). So a Worker-side
  agent CAN connect to a remote SSE MCP server by URL (`addMcpServer`), and
  that connection can be wrapped by `McpConnector`. This is the key enabler.
- Code Mode is **TypeScript/Workers-only**. There is nothing in the repo a
  Python app (QwenPaw) can consume directly. QwenPaw's own loop cannot "use
  Code Mode" without QwenPaw itself gaining a code-execution tool — that
  would be a QwenPaw feature (a Python executor tool), not a Cloudflare
  integration.

### Concrete integration points (ranked)
1. **Worker-side "Code Mode agent" for routines/tickets/group-chat (best fit).**
   A new `Agent` (Durable Object) on Workers with `createCodemodeRuntime` +
   an `McpConnector` pointed at the computer-use MCP, plus connectors for
   GitHub (MCP/OpenAPI), routines KV, board DO, etc. The model (Workers AI
   or Astra via OpenAI-compatible client) writes one script per job: e.g. a
   routine that reads the ticket board, screenshots the desktop, clicks
   through a check, and posts the result — one LLM turn instead of a dozen.
   The runtime gives approvals (pause/resume), audit log, and snippets
   (promote a good routine script to a reusable snippet).
2. **MCP reachability is the hard part.** The MCP SSE lives on the Docker
   gateway `172.18.0.1` inside the VM — NOT publicly exposed. For a Worker
   to reach it, either (a) publish the mcp-proxy port (8089/8898) as an
   InstaBox port with a token (same pattern as 6080/6081) and have the
   Worker connect to the public SSE URL with the token, or (b) keep the MCP
   behind the Pages proxy and expose an `/mcp` route. Either way the SSE
   endpoint must be reachable from Cloudflare's edge AND authenticated —
   the token must live as a Worker secret, never in code. Note the sandbox
   itself has no network; the MCP connection is host-side (the connector
   lives in the Worker), so the sandbox's `globalOutbound: null` does not
   block MCP calls — but any `fetch()` the generated code itself tries
   would be blocked.
3. **QwenPaw-side (later, bigger change).** If the goal is QwenPaw's own
   desktop loop in fewer turns, the equivalent inside QwenPaw is a Python
   "run code" tool (an executor tool that runs a Python snippet calling the
   MCP tools in a loop) — i.e. re-implementing the Code Mode idea inside
   QwenPaw. That is a QwenPaw feature, not a Cloudflare one; do not confuse
   the two. The Worker-side agent (point 1) delivers the savings without
   touching QwenPaw.
4. **Where the savings land:** on the NEW Worker agent's calls (routines,
   ticket triage, group-chat turns) — not on QwenPaw's own chat loop, which
   keeps calling one tool per turn until/unless point 3 is built. With
   Astra's 922K context the prompt-size saving matters less to us than the
   turn-count saving (fewer slow Astra round trips — Astra has stalled at
   30–120s before).

### Risks / blockers (verified)
- **Experimental.** README header: may have breaking changes; do not treat
  the API as stable.
- **60s default execution timeout** (configurable). Long desktop tasks (a
  browser flow can take minutes) must be split into multiple code runs or
  the timeout raised; on timeout the run errors (`{ status: "error" }`).
- **Approvals interaction.** Code Mode approvals pause/resume via the
  runtime; our computer-use DriverCard policy is now `allow` in QwenPaw, so
  a Worker-side Code Mode agent needs its OWN approval annotations
  (`requiresApproval` on destructive connector tools) — the two approval
  systems are independent; do not assume QwenPaw's policy covers the Worker.
- **Worker Loader binding** availability on the free tier is not stated in
  the docs — verify at deploy time.
- **Sandbox has no network** — generated code cannot `fetch()` the InstaBox
  API directly; all external effects must go through connectors (host-side).
- **MCP reachability is the hard part — and remote SSE IS supported.**
  The MCP SSE lives on the Docker gateway `172.18.0.1` inside the VM — NOT
  publicly exposed. For a Worker to reach it, either (a) publish the
  mcp-proxy port as an InstaBox port with a token (same pattern as 6080/6081)
  and have the Worker connect to the public SSE URL with the token, or
  (b) keep the MCP behind the Pages proxy and expose an `/mcp` route. Either
  way the SSE endpoint must be reachable from Cloudflare's edge AND
  authenticated — the token must live as a Worker secret, never in code.
  Transport check (done after Astra, repo-wide, not just the pasted files):
  the agents SDK MCP client supports remote transports —
  `StreamableHTTPClientTransport` and `SSEClientTransport`
  (`packages/agents/src/mcp/client/connection.ts:1028,1039`), and
  `addMcpServer(serverName, url)` connects by URL. So a Worker-side agent
  CAN connect to a remote SSE MCP server, and `McpConnector` can wrap that
  connection. (Astra, given only the pasted files, correctly said this was
  "not established" — the wider repo check closes that gap.)
- **The visual-judgment bound (the key limit for computer-use).** Desktop
  work is observe → decide → act: each step needs the model to LOOK at a
  screenshot before choosing the next action. Code can batch *known* actions,
  but it cannot batch visual judgment, and the repo documents no
  screenshot-understanding facility inside the sandbox. Astra's words: "if
  the model must inspect a screenshot before choosing each next action,
  ordinary JavaScript control flow cannot supply that visual judgment."
  Consequence: for the 9-tool computer-use MCP, the savings are bounded —
  the screenshot still has to come back to the model every step. Code Mode
  helps most where the workflow is predictable (routines, ticket triage,
  multi-step data jobs), not where every step needs fresh eyes. (Nuance on
  one Astra line: it said docs returned by `describe()` don't automatically
  become model context — true for *planning the next script*, but inside one
  script the code CAN search → describe → call the discovered method without
  another model turn; that is the documented index.md pattern.)
- **Model must be good at writing code** — Astra's code-writing quality for
  this pattern is untested; a bad script costs a retry loop.

### Recommended first step
Build point 1 as a **small pilot**: one Worker agent + `McpConnector` to the
computer-use MCP (via a newly published, token-authenticated SSE port) + a
GitHub connector, driving ONE routine end-to-end (e.g. "check the ticket
board, screenshot the desktop, report"). Measure turns + tokens vs the same
job done the classic way before expanding. Do NOT start with point 3
(rebuilding QwenPaw's loop) and do NOT use the legacy `createCodeTool` path
expecting prompt savings.

## 5. Astra check (big-context)

Full prompt was 45,647 bytes: the complete `packages/codemode/README.md` +
`docs/codemode/index.md` + `examples/codemode/src/server.ts` + 13 questions.
- Attempt 1 (gpt-6-astra): HTTP 429.
- Attempt 2 (gpt-6-astra, after 90s wait): HTTP 429.
- Attempt 3 (gpt-6.1-sol): **answered**. Usage: 14,460 prompt tokens
  (4,096 cached), 4,221 completion tokens. Full answer saved at
  `/tmp/astra-answer.txt` (19,505 chars).

Astra's answers were checked against the repo source; all structural claims
verified correct (two-layer distinction, legacy type-block-in-description,
runtime search/describe, pause/resume + replay, McpConnector mechanics,
60s default timeout, no-network default, no benchmarks in repo). Two
corrections/nuances from my own repo-wide verification:
1. Astra (given only the pasted files) said remote-SSE support for
   `McpConnector` was "not established". The wider repo establishes it: the
   agents SDK MCP client supports `SSEClientTransport` and
   `StreamableHTTPClientTransport` (`packages/agents/src/mcp/client/connection.ts:1028,1039`).
2. Astra's line that `describe()` results "do not automatically become new
   model context" is true for planning the *next* script, but inside one
   script the code can search → describe → call without another model turn
   (the documented index.md pattern).

Astra's key conclusions (verified, and I agree): savings land only in the
loop that adopts Code Mode; QwenPaw unchanged gets nothing; there is no
Python/QwenPaw adapter in the repo; the visual-judgment bound limits
computer-use batching; recommended first step is a small bounded pilot on
read-only routines/ticket operations with measured tokens/turns/latency vs
the classic approach, keeping QwenPaw's loop untouched — and do NOT replace
QwenPaw's loop, run long desktop sessions in one sandbox execution, or
expose the desktop MCP broadly before that pilot succeeds.
