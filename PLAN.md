# QwenPaw 100% Working Plan

Goal (user, 2026-11-15): finish ALL fixes, a 100% working system, ALL Rakazo features working in ours, test everything 2–3 times with a bigger test project, add a log-check option to find issues constantly, then add JEV (optional) + Drex/NACE models (optional), improve memory (deja-vu / lessons file / Ripwire), and Cloudflare Code Mode. Research FIRST, implement slowly, verify live in a real browser before claiming anything. Days are fine — results are what matter.

Rules that never change: English only, no China endpoints/data, InstaBox Free only, cloud LLM only with the user's own keys, GitHub is the control plane, no secrets in git or files, instabox2 account is READ-ONLY (never change anything there), Astra is used for knowledge help with BIG context (full docs/source pasted, never small snippets — small context gives wrong answers), verify every Astra claim against real source.

## Current state (verified live, 2026-11-15)

- Console: https://qwenpawx.pages.dev (login satwik), backup https://qwenpaw-frontend.pages.dev; InstaBox machine m_agq5wqqo2fvypym7rjlpvngc2m, QwenPaw Docker v2.3.0 healthy; keep-alive Worker up; Pages proxy live.
- Desktop: XFCE 1920x1080 on :1, Chromium + wordsolverx.com open; Camoufox Firefox on :99 with x.com/0xsatwik; dashboard stream link VERIFIED rendering (22:13 UTC token, expires 2026-11-15T22:13:52Z); noVNC 6080 Connect works with NO password; /desktop embedded view VERIFIED rendering and staying rendered.
- QwenPaw → desktop MCP wired natively (mcp-proxy, DriverCard computer-use.yaml). Agent screenshot FIXED (container phantom-desktop cause; mss now captures the host display; browser proof 04:23 IST shows the window). Approval prompts FIXED (DriverCard ask→allow; browser proof 04:23 IST: zero prompts).
- Rakazo study DONE (features/desktop/rakazo-computer-study.md, commit 0c97840). Live exploration of grokagent.pages.dev done by the user signing in himself.
- Rakazo-style full build RUNNING (subagent 0eec724e): P0/P1 (view/control split, take-control lease, sealed capabilities, overlay chrome, shim + state machine, Wake/Asleep) + extended scope (teach-by-showing, needs-you flow, maintenance UI, per-bot computer + Team/Private, terminal tab, side-panel preview, chat tool-call display, screen generations + preview in chat).
- NACE key: supplied by the user in chat. It is NOT written in any file, memory, or repo. It will be stored only through the secure connector flow (pending: API base + auth scheme confirmation from docs research), then used as an optional provider. Never paste it in chat again.

## Todo list

### Phase 0 — Finish existing tasks first (IN PROGRESS)
- [ ] Rakazo-style full build completes (P0/P1 + teach + needs-you + maintenance UI + per-bot + terminal + side-panel + tool-call display + generations/preview) — subagent 0eec724e
- [ ] Verify each built item in a real browser (parent) — dashboard link, /desktop overlay, take-control pill, Wake/Asleep, teach recording, needs-you card, terminal, maintenance menu
- [ ] Reconcile shared files if parallel fixes touched them (computer-use.yaml policy must stay `allow`; _worker.js merges)

### Phase 1 — Prove it works (testing + log check)
- [ ] Build a BIGGER test project that exercises EVERY feature: console login, chat + models, desktop view/control, agent screenshot, bridge open, MCP tools, routines, group chat, ticket board, bot pages, skills, mailbox, heartbeat, approvals, fleet, evals, import/export, teach, needs-you, terminal, maintenance
- [ ] Test everything 2–3 full rounds; each round: run all tests, record pass/fail, fix failures, re-test
- [ ] Add a LOG-CHECK option: one place to see all logs (QwenPaw log, container log, Worker logs, bridge log, MCP log) with issue-finding (errors/warnings grouped, new-issue alerts) so issues are found and fixed constantly
- [ ] Final confirmation round after all fixes; no "done" claim without a passing round

### Phase 2 — JEV (research DONE 2026-11-15, implement after Phase 0/1)
- [x] Research: awesome-jev-tools repo (research subagent, 2026-11-15). Full list saved: features/jev/awesome-jev-tools-full-list.md (1,206 entries, 23 categories). KEY CORRECTION: Jev is TypeSafe AI's System One DECISION model, NOT a chat model — you send unstructured state + typed questions (Choice/Score/Noul/Box) and get typed decisions with calibrated probabilities. 70–500 ms/call, input $0.042/MTok, output free, ~32k token cap, API POST /v1/systemone, model jev-latest. Early access — needs a TypeSafe API key from console.typesafe.ai (alternate routes: OpenRouter typesafe/jev-1.13, Vercel AI Gateway). Astra consultation for this research hit HTTP 429 (hard stop, not retried) — analysis is from direct reading of the repo + TypeSafe docs.
- [ ] Implement in priority order (all OPTIONAL, flag-gated, no key = no Jev, existing LLM path used): (1) access layer — typesafe-ai/skills + jev-mcp-server (second MCP beside computer-use) + jevclient; (2) browser/computer-use Jev loop — copy the jev-ultrafast pattern (indexed action table → one Jev Choice → execute → verify; Astra only for typing/reasoning), do NOT buy the hosted bu-ultrafast model; (3) approval/guardrail verdicts — pi-verdict / jev-auto-approve / actiongate-jev patterns (Jev verdict if enabled, else current allow); (4) context compaction — fast-jev-compaction algorithm adapted to QwenPaw sessions (verbatim keep/drop, 25k tokens); (5) model routing/fallback — Jevonian (route around Astra stalls); (6) routines/wake gating — wakegate / openclaw-jev-trigger (save Free run-minutes); (7) skill selection + memory rerank — jev-skills, jev-recall/Oko/jev-carryforward; (8) triage + test gates — jev-triage, jev-test-filter, jev-lint, jev-browser-qa (for the bigger-project QA loop); (9) calibration tooling throughout — jev-workbench/tenbin/jevcal. Traps: macOS-only entries won't run on our Linux desktop (take the pattern, not the code); Claude Code/Pi plugins are shapes to adapt, not installs; jevseo is UNLICENSED — do not copy; cost/latency claims are author-reported, calibrate on our own data first.
- [ ] NEEDS FROM USER (when Phase 2 starts): a TypeSafe API key (early access — request at console.typesafe.ai) OR confirmation to use the OpenRouter/Vercel Gateway route instead.
- [ ] Test JEV features in the test project rounds

### Phase 3 — NACE / Drex models (research DONE 2026-11-15, implement after Phase 0/1)
- [x] Research: console.nace.ai/docs + openapi.json (research subagent, 2026-11-15). HEADLINE: Drex is a DECISION model, NOT a chat LLM — same kind as Jev, NOT a drop-in chat provider. There is NO /v1/chat/completions endpoint (confirmed 3 ways: docs endpoint list, public openapi.json, web search). A Drex chat-provider file would 404 on every call and fail QwenPaw's model-slot validation — Drex must NEVER go in `active_model`/`fallback_models` (chat chain only). Base: https://console.nace.ai, auth `Authorization: Bearer <key>` (key format from the docs), max 3 keys/account. Models: drex-max-v1.1 (multimodal, 262K, most accurate, default), drex-max-finance, drex-v2.0 (MoE 3B active, text-only). $0.03/M input, output NEVER billed, up to 512 questions/request, free tier 120 RPM / 8 in-flight, $5 signup balance. Endpoints: POST /v1/systemone (evaluate typed questions), GET /v1/models, POST /v1/decisions (OpenAI-compatible Decisions API — decisions, not chat), plus NDI document endpoints, Workspaces, Batches, Browser runs. Drex is wire-compatible with TypeSafe's Jev (same /v1/systemone shape) and CHEAPER than Jev ($0.03/M vs $0.042/M). Remote MCP at https://console.nace.ai/mcp (free tier 100 decisions/day without a key). Astra attempts for this research: 429 + 120s timeout — conclusions rest on direct docs reads.
- [ ] Store the NACE key via the secure connector flow (never in files/git) — secure entry link to be sent once the connector is set up.
- [ ] Add Drex as an OPTIONAL decision layer alongside Astra/Kilo/mosicn — never a chat replacement. Ranked patterns: (1) `decision_model` slot for JEV approval — best native fit (QwenPaw's JEV approval level + typesafe_provider.py already exist; `decision_model` is currently null on both agents) — BUT first verify in QwenPaw source what request shape typesafe_provider.py sends and what security/decision_model.py `assess_tool_call` expects (chat vs systemone/decisions); if chat-shaped, a small adapter driver is needed; (2) `decide` skill wrapping POST /v1/systemone — most certain, no QwenPaw code changes, key in encrypted env store like GITHUB_TOKEN; (3) Nace remote MCP server as a QwenPaw MCP server — verify remote HTTP MCP + auth headers are accepted. Uses once wired: calibrated go/no-go + routing (triage, moderation, refund/urgency scoring, approval verdicts under JEV, test gates, skill-selection and memory reranking) — ~$0.0000032 for a 3-question triage.
- [ ] Test Drex in the test project rounds

### Phase 4 — Memory (Ripwire research DONE 2026-11-15, deja-vu research still running)
- [x] Research: Ripwire (redhat-et/ripwire, v0.6.10, Apache-2.0) — zero-dependency C++23 CLI, one offline binary, no API key. Reads a source tree, writes a ranked symbol map: what to touch, callers, impact, which tests to run. Commands: `ripwire .` (~5.6K tokens vs 20–25K naive read), `--for="<change>"` (~2.1K tokens), `--callers/--impact/--pack-task/--test-gate/--recall/--edit-check`. 27 languages incl. JS/TS/Python/YAML/JSON/Markdown. Prebuilt binaries or cmake build (needs AVX2 x86-64-v3 — verify on VM first). Astra attempts for this research: gpt-6.1-sol 120s timeout, gpt-6-astra HTTP 429 — claims verified directly against the repo instead.
- [x] Research finding: Ripwire and deja-vu are COMPLEMENTARY, not overlapping. Ripwire indexes code as it is now ("what to touch"); deja-vu indexes history ("what did we do before"). CRITICAL: QwenPaw is NOT one of deja-vu's 46 harnesses, so deja-vu cannot natively index QwenPaw chat history (chats.json/history.db/sessions format has no reader). Workarounds are partial: manual `remember` + repo `.deja/memory.jsonl` curation, or a QwenPaw store adapter (real work). NEITHER tool does lessons.md natively — closest is deja-vu's promoted notes; the honest implementation is a LESSONS.md skill/convention in the QwenPaw workspace (agent appends lesson + mistake + fix after each task, read at session start). GOTCHA: /tmp on the machine is a 512 MB tmpfs at 100% full — build under /data/home, never /tmp.
- [ ] Implement (in this order): (1) Ripwire first — install binary on host /data/home/ripwire, bind-mount into the QwenPaw container (agent runs inside Docker), CLI-first not MCP (saves context); (2) deja-vu limited pilot — install, register MCP manually, use `remember` + repo memory.jsonl for curated decisions, do NOT expect automatic QwenPaw chat indexing; (3) LESSONS.md as a skill — append lesson + mistake + fix after each task, read at session start alongside MEMORY.md/AGENTS.md; optionally mirror code gotchas into .ripwire_notes and curated decisions into .deja/memory.jsonl.
- [ ] Fast, low-token memory search: Ripwire --recall/--for for code+docs; deja-vu recall for session history (pilot); measure token cost per query.
- [ ] Wait for the dedicated deja-vu research report before finalizing the deja-vu pilot scope.
- [ ] Test recall speed + token cost in the test project

### Phase 5 — Cloudflare Code Mode (research DONE 2026-11-15, implement after Phase 0/1)
- [x] Research: cloudflare/agents @cloudflare/codemode v0.5.6 (research subagent, 2026-11-15). Full note: features/research/code-mode.md. KEY FINDINGS: Two layers — legacy `createCodeTool` puts the FULL type block into the single tool's description (no prompt savings, only fewer round trips) vs runtime `createCodemodeRuntime` (discovery happens INSIDE the sandbox via codemode.search/describe — this is the path that actually shrinks the prompt; adds pause/resume approvals, rollback via per-tool revert, audit trail, snippets). Execution: code runs in an isolated Worker via LOADER binding, network blocked by default, 60s default timeout. Repo gives NO benchmarks — subagent's calculation: with ~30 tools and a 10-step workflow, runtime path cuts prompt tokens ~6–10K → ~1–2K per turn and turns ~10 → ~1–2; a single simple call is WORSE. Code Mode is TypeScript/Workers-only — QwenPaw's own Python loop cannot use it unless QwenPaw gains a code-execution tool. Best fit: a NEW Worker-side "Code Mode agent" (Durable Object) with createCodemodeRuntime + McpConnector for the computer-use MCP + GitHub/routines/board connectors — runs routines/ticket-triage/group-chat jobs as one script per job, QwenPaw keeps its own loop. MCP reachability: the SSE endpoint (172.18.0.1:8898 inside the VM) must be published as a token-authenticated InstaBox port or via a Pages /mcp route — the agents SDK MCP client DOES support remote SSE/StreamableHTTP transports. KEY LIMIT: desktop work is observe→decide→act and each step needs the model to LOOK at a screenshot — code can't batch visual judgment, so savings on computer-use are bounded; Code Mode helps most on predictable workflows (routines, triage, data jobs). Risks: Experimental API (pin versions), 60s timeout vs multi-minute tasks, Code Mode approvals are a SEPARATE layer from the DriverCard allow policy, sandbox has no network, Worker Loader free-tier availability unverified, replay replays calls not desktop state. Astra: gpt-6-astra 429 twice, gpt-6.1-sol answered and all structural claims verified against the repo.
- [ ] Implement as a SMALL BOUNDED PILOT first: one Worker agent + MCP connector driving one routine end-to-end, measuring turns/tokens/latency against the classic approach — before touching QwenPaw's loop or exposing the desktop MCP broadly. Do NOT use the legacy createCodeTool path expecting prompt savings.
- [ ] Final full test rounds (2–3x) across the whole system

## Schedule (approximate, days are fine — results matter)

| When | Work |
|---|---|
| Day 1 | Phase 0 finishes; browser verification of every built item |
| Day 2 | Phase 1: bigger test project built; test round 1; log-check option built |
| Day 3 | Test rounds 2–3; fix + re-test; Phase 2 research lands → JEV implementation starts |
| Day 4 | Phase 2 JEV done + tested; Phase 3 Drex research lands → key stored securely, Drex provider added (optional) + tested |
| Day 5 | Phase 4 memory research lands → lessons file + fast low-token search + deja-vu/Ripwire decision implemented + tested |
| Day 6 | Phase 5 Code Mode implemented + token savings measured |
| Day 7 | Final full test rounds (2–3x) across everything; fix remaining issues; final report |

The schedule updates in this file as work completes. A phase is done only when its test round passes in a real browser.

## Research status (2026-11-15 04:28 IST)

Five research subagents running (all read-only, Astra with big context, verify against real source):
1. awesome-jev-tools / JEV
2. NACE / Drex (console.nace.ai/docs)
3. deja-vu + lessons file + fast low-token memory search
4. Ripwire
5. Cloudflare Code Mode (cloudflare/agents)

Findings land here as they arrive — nothing in Phases 2–5 is built before its research lands.
