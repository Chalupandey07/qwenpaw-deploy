# Trending repos review — 2026-11-15

> **Verification note (AutoClaw, same day).** Every repo below was checked to
> exist via the GitHub API. I independently re-verified the two claims this
> document's recommendations *depend* on, and corrected one:
>
> - **`RoutingPolicy.decide()` really is a stub.** Read from
>   `agentscope-ai/QwenPaw@v2.3.0:src/qwenpaw/agents/routing_chat_model.py`:
>   it does `del text, channel, tools_available` and returns a constant based
>   on `mode`. The hook point exists and is empty. Confirmed.
> - **`gpt-6-astra` really is in the price catalogue.** Verified by unpacking
>   the `genai-prices` 0.2.3 wheel: the bundled snapshot lists 450 provider
>   entries including `gpt-6-astra`, `gpt-6-sol`, `typesafe` and
>   `openai-decisions`.
> - **CORRECTION:** this brief says calc_price "does not split input/output".
>   It does — `PriceCalculation` carries `input_price` and `output_price`
>   separately (verified in `genai_prices/types.py`). The implementation in
>   `features/board/pricing.py` uses both.
> - **CONSTRAINT FOUND:** `genai-prices` requires **Python >= 3.11**
>   (`datetime.UTC`) plus `pydantic`, `pydantic-core`, `httpx2`,
>   `typing-inspection`, `annotated-types`. The QwenPaw container is >= 3.11
>   (upstream `requires-python = ">=3.11,<3.14"`), but a bare host may not be.
>   It is therefore implemented as an **optional** dependency that degrades to
>   an honest UNKNOWN — which is what `features/board/pricing.py` does.

# Research Brief — QwenPaw on InstaBox Free
**Scope:** memory/self-learning · decision models · computer-use · sandboxes · evals · cost/observability · durable routines · guardrails
**Method:** every repo below verified with `gh api /repos/<owner>/<name>` (existence, stars, `pushed_at`, SPDX license) plus its actual README. Nothing named here is guessed. Star counts on this mirror run higher than github.com normally shows, so ranking below weighs *fit* over stars. Repo baseline: 212 files, `features/{memory,infra/evals,board,routines,desktop,camoufox,skill-library}` all already exist.

---

## Verdict first — implement these 5, in this order

| # | Repo | Why now | Effort |
|---|---|---|---|
| 1 | **pydantic/genai-prices** | Fixes a live bug: `features/board/refresh-cost.py` prints `UNKNOWN` for GPT Astra because the provider catalog returns `{}`. Zero-dependency price DB. | ~1h |
| 2 | **aurelio-labs/semantic-router** | Plugs into a real hole in QwenPaw: `RoutingPolicy.decide()` currently does `del text, channel, tools_available` then returns a constant. This makes routing actually content-aware on CPU. | ~1 day |
| 3 | **NVIDIA/SkillSpector** | You install third-party `SKILL.md` bundles into `working/skill_pool/`. Their own scan of 31,132 skills found **26.1% contain vulnerabilities, 5.2% likely malicious**. CI gate, not runtime. | ~half day |
| 4 | **langfuse/langfuse** (Cloud free tier, *not* self-host) | QwenPaw already ships the integration — `observability/langfuse.py` + `hooks/observability/langfuse_hook.py` with a `PRE_EXECUTE` trace scope. It's three env vars. | ~30 min |
| 5 | **UKGovernmentBEIS/inspect_ai** | Replaces the hand-rolled 5-case `features/infra/evals/run-evals.py` with 200+ maintained evals and proper scoring. | ~1–2 days |

**Explicit non-recommendations:** don't add a memory framework, a sandbox, or a workflow engine. QwenPaw v2.3.0 already ships all three (details in each section). Adding them would duplicate working code — the exact mistake `features/memory/README.md` already documents avoiding.

---

## 1. Memory + self-learning

**Critical baseline:** QwenPaw v2.3.0 has embedded ReMe memory — `src/qwenpaw/agents/memory/reme_light_memory_manager.py`, `reme_config.py` (deliberately scoped to `daily_dir` + `digest_dir` markdown), `reme_inbox.py`, `reme_reranker.py`. Plus `agents/context/scroll/memoryspace.py` FTS5 recall and a `recall_history` tool. Your `features/memory/` already adds the *token-budgeted, redacting, host-side* layer upstream lacks. The remaining genuine gap is **consolidation** — nothing turns daily logs into durable lessons on a schedule.

| Repo | ⭐ | Last commit | License | Lang | Verdict |
|---|---|---|---|---|---|
| **MemTensor/MemOS** | 12,402 | 2026-11-09 | Apache-2.0 | TS/Py | **Reject self-host** — see anti-picks |
| **EverMind-AI/EverOS** | 13,916 | 2026-11-13 | Apache-2.0 | Python | *Maybe* — Markdown-native, but see below |
| **doobidoo/mcp-memory-service** | 2,127 | 2026-11-14 | Apache-2.0 | Python | Best-fit external option |
| **BAI-LAB/MemoryOS** | 1,622 | 2026-07-07 | Apache-2.0 | Python | Stale, academic |
| **rohitg00/agentmemory** | 30,366 | 2026-11-13 | Apache-2.0 | TypeScript | Wrong shape (coding-agent hooks) |

**doobidoo/mcp-memory-service** is the only one I'd consider. Verified install: `pip install "mcp-memory-service[sqlite]"` — "The `[sqlite]` extra brings the local ONNX embedding model." README: *"REST API + knowledge graph + autonomous consolidation."* Autonomous consolidation is precisely the missing piece. Cost: an ONNX embedding model resident in RAM on an 8 GB box that also runs QwenPaw + Chromium. **Conditional.**

**EverMind-AI/EverOS** — README is unusually honest and the architecture matches your constraints: *"stores conversations, files, and agent trajectories as readable Markdown, then syncs local SQLite and LanceDB indexes."* Markdown-as-source-of-truth is exactly your `MEMORY.md` convention. **But** the quickstart says *"One OpenRouter API key is enough to start"* and pre-fills `base_url = "https://openrouter.ai/api/v1"`. That's repointable at your OpenAI-compatible provider (mosicn/nex-n2.6) since it's a plain `base_url`. Requires Python 3.12+. **Watch, don't adopt** — created 2025-10-28, still churning.

> **Verdict for this area:** write a new file at features/memory/consolidate.py — a cron-invoked script that reads `daily_dir`/`digest_dir`, extracts candidate lessons, and feeds `lessons.py`'s existing candidate→accept ledger. Zero new dependencies, zero new DB. If you want retrieval quality later, add `mcp-memory-service` behind the same CLI.

---

## 2. Decision models / cheap classifiers

**Critical baseline:** `src/qwenpaw/agents/routing_chat_model.py` defines `RoutingPolicy.decide(text, channel, tools_available)` — and the body is:

```python
del text, channel, tools_available
if getattr(self.cfg, "mode", "local_first") == "cloud_first":
    return RoutingDecision(route="cloud", reasons=["mode:cloud_first"])
return RoutingDecision(route="local", reasons=["mode:local_first"])
```

It ignores content entirely. `AgentsLLMRoutingConfig` (config.py:2089) has `enabled`, `mode`, and `local`/`cloud` `ModelSlotConfig` slots. There is also a distinct `decision` model type (`create_decision_model_async`, used by ReMe's `DecisionCompactor`). **The hook point already exists and is empty.**

| Repo | ⭐ | Last commit | License | Lang | Verdict |
|---|---|---|---|---|---|
| **aurelio-labs/semantic-router** | 4,033 | 2026-11-09 | MIT | Python 3.10–3.13 | ✅ **Adopt** |
| vllm-project/semantic-router | 6,477 | 2026-11-15 | Apache-2.0 | Go | ❌ Anti-pick |
| lm-sys/RouteLLM | 5,704 | **2024-08-10** | Apache-2.0 | Python | ❌ Anti-pick |
| NadirRouter/NadirClaw | 665 | 2026-11-12 | PolyForm NC | Python | ❌ Anti-pick |
| katanemo/plano | 7,117 | 2026-10-24 | Apache-2.0 | Rust | Overkill (Envoy proxy) |

**aurelio-labs/semantic-router** is the clear winner. Verified from README (v1.x line): *"it decides in milliseconds: it compares the semantic meaning of a request against your routes in vector space… Every decision comes with a confidence you can calibrate into a real probability."* And crucially: *"This quickstart runs entirely on your machine, with a small local embedding model and no API keys"* → `pip install -qU "semantic-router[fastembed]"`, encoder `BAAI/bge-small-en-v1.5`.

Two API details that matter for you:
- **Calibration:** `router.fit(X=[...], y=[... , None, ...])` then `router.confidence_threshold = 0.5` — *"now a probability: act only when it's more likely right than wrong."* Returning `None` when unsure is exactly the "gate" semantics you want before escalating to a paid model.
- **`Chain`:** *"answers easy queries from a fast router and falls through to a slower one only when it isn't sure."* That maps 1:1 onto nex-n2.6 → GPT Astra fallback.

**Avoid `DecisionRouter`** — it calls "TypeSafe's Jev, Laya or Von" decision models, which are hosted/paid. Stick to `IndexedRouter` + FastEmbed. Base deps pull in `cohere`, `mistralai`, `voyageai`, `openai` SDKs (heavy but inert); the `local` extra pulls `torch` — **do not install `[local]`**, that's a GPU-sized download.

**Integration sketch:** new a new file at features/routing/policy.py; patch `RoutingPolicy.decide()` to consult a routes YAML (a proposed routes file under `features/routing/`) and return `reasons=["semantic:<name>:<confidence>"]`. Keep `local_first`/`cloud_first` as the fallback when confidence < threshold, so behaviour is unchanged if the model is missing. **Note:** `local` slot is unusable here (no local models allowed) — repurpose it as "cheap cloud" (nex-n2.6) and `cloud` as "expensive" (GPT Astra).

---

## 3. Computer-use / desktop agents

**Critical baseline:** you already have a full stack: `features/desktop/` (Xvfb `:1`, Xfce, Chromium, VNC, takeover/handback via InstaBox API), `features/camoufox/` (anti-detect Firefox bridge with `/goto`, `/snapshot`, `/screenshot`), and a live `computer-use` MCP DriverCard at `http://172.18.0.1:8898/sse` with a `default_effect: deny` policy. **This area is solved.** Only add something if it beats the hand-rolled bridge.

| Repo | ⭐ | Last commit | License | Lang | Verdict |
|---|---|---|---|---|---|
| **browser-use/browser-use** | 121,060 | 2026-11-15 | MIT | Python 3.11+ | ✅ Best fit |
| trycua/cua | 32,360 | 2026-11-15 | MIT | Rust/Py | Heavy (786 MB repo) |
| simular-ai/Agent-S | 12,973 | 2026-11-13 | Apache-2.0 | Python | Viable but GUI-only |
| microsoft/OmniParser | 25,623 | 2026-07-20 | CC-BY-4.0 | Jupyter | ❌ Anti-pick |

**browser-use** — README: *"The open-source browser agent. Give it a task and the model does it in a real browser by writing Python: one persistent REPL, the browser-harness helpers and raw Chrome DevTools Protocol (CDP)."* Critically for your constraints, the FAQ answers the cost question directly: *"The Python library is free and MIT-licensed… You can also use `Browser('chromium')` with a local model, e.g. Ollama through `ChatOpenAI(model, base_url='http://localhost:11434/v1')`"* — i.e. **any OpenAI-compatible `base_url` works**, so it runs against nex-n2.6. `Browser('chromium')` also *"Headless when there is no display (Docker, CI)"*, which is your container exactly.

**Integration sketch:** `features/browseruse/` with a thin `task.py` that exposes `POST /task {"url","goal"}` the same shape as the Camoufox bridge, so the existing SKILL.md can call either. Use it for **deterministic, repeatable site tasks** (form fills, scrapes); keep Camoufox for anti-detect/session work where its fingerprint spoofing matters. Don't retire the bridge.

**simular-ai/Agent-S** — *"Give it a task in plain English. It looks at the screen and completes the task by clicking, typing, and scrolling… It runs on macOS, Windows, and Linux."* Works, but needs pyautogui + a display and is screenshot-loop expensive (every step = one vision call). On a 4 vCPU box with metered tokens that's the worst cost profile of the three. **Only if** you need cross-app desktop actions the MCP can't express.

---

## 4. Code execution sandboxes

**Critical baseline — read this before adding anything:** QwenPaw already ships `src/qwenpaw/sandbox/` with a real backend matrix: `bubblewrap_sandbox.py` (documented as **preferred** on Linux), `linux_sandbox.py` (Landlock LSM **fallback**), `macos_sandbox.py` (seatbelt), three Windows backends, plus `runtime_boundary.py` and `_cleanup_logging.py`. `create_sandbox(SandboxConfig(mode=SandboxMode.BUBBLEWRAP, workspace_dir=...))`. **A sandbox is a solved problem in this product.**

| Repo | ⭐ | Last commit | License | Lang | Verdict |
|---|---|---|---|---|---|
| **vndee/llm-sandbox** | 1,144 | 2026-11-06 | MIT | Python | ✅ If you need a `run_python` *tool* |
| e2b-dev/E2B | 14,865 | 2026-11-14 | Apache-2.0 | Python | ❌ Anti-pick |
| opensandbox-group/OpenSandbox | 17,311 | 2026-11-15 | Apache-2.0 | Go | K8s-oriented |

**vndee/llm-sandbox** is the only defensible addition, and only conditionally. Verified `pyproject.toml`: **`dependencies = ["pydantic>=2.11.5"]`** — that is the entire dependency list. Docker is an extra (`llm-sandbox[docker]`). README: *"runs LLM generated code through a common API for container and local Linux and Windows sandbox backends"* with *"Resource Limits: Set CPU, memory, and execution time limits"* and *"Network Isolation."* Also ships an MCP server (`llm-sandbox-mcp`), so it could be exposed to QwenPaw as an MCP driver card rather than imported.

**Honest assessment:** the *marginal* value over QwenPaw's bubblewrap backend is resource limits + a clean `SandboxSession.run()` API + MCP packaging. If QwenPaw's sandbox already enforces CPU/mem/time via the tool-guard, **skip this entirely.**

---

## 5. Evals / benchmarking

| Repo | ⭐ | Last commit | License | Lang | Verdict |
|---|---|---|---|---|---|
| **UKGovernmentBEIS/inspect_ai** | 3,251 | 2026-11-15 | MIT | Python 3.11+ | ✅ **Adopt** |
| promptfoo/promptfoo | 27,206 | 2026-11-15 | MIT | TypeScript | ✅ If you prefer YAML |
| confident-ai/deepeval | 19,483 | 2026-11-12 | Apache-2.0 | Python | ✅ pytest-native |
| openai/evals | 19,744 | 2026-04-14 | NOASSERTION | Python | Stale-ish |
| claw-eval/claw-eval | 934 | 2026-11-14 | MIT | Python | ⚠️ ModelScope mirror |

**inspect_ai** — UK AI Security Institute. README: *"a framework for large language model evaluations… facilities for prompt engineering, tool usage, multi-turn dialog, and model graded evaluations"* and *"over 200 pre-built evaluations ready to run on any model."* MIT, Python 3.11+, `uv sync`. It has a documented agent/tool-use path and a `--model` flag that accepts OpenAI-compatible endpoints. This is the right home for cases beyond your current 5.

**deepeval** is the lower-ceremony alternative and would let you keep cases in pytest with `assert_test()`. If your `run-evals.py` works, migrating to deepeval is a half-day; inspect_ai is a day or two but scales to real benchmarks.

**claw-eval** is genuinely interesting — 300 human-verified agent tasks, Pass^3 methodology (*"a model must now consistently pass a task across three independent trials"*) — but its dataset is mirrored on **ModelScope**, and I'd want to confirm the HF primary is reachable before depending on it. Also Pass^3 triples your token spend.

**Integration sketch:** keep `features/infra/evals/cases.json` as the source of truth; add `features/infra/evals/inspect/` with a task file that wraps the *console chat* envelope (`POST /api/console/chat/task`) rather than the raw model — you want to eval the *agent*, not the model. Keep the existing auth handling (single login, honour 429 `Retry-After`, 423 = abort).

---

## 6. Cost tracking / observability

**Critical baseline:** QwenPaw already has `src/qwenpaw/observability/langfuse.py` (optional, no-op if the lib is absent), `hooks/observability/langfuse_hook.py` (`Phase.PRE_EXECUTE`, priority 12, groups each request into one trace with `session_id`/`agent_id`/`channel` metadata), `token_usage/` (manager, `model_wrapper.py`, `turn_usage.py`), and `agent_stats/` with a `DailyStats` model carrying `prompt_tokens`, `completion_tokens`, `llm_calls`, `cache_read_tokens`, `cache_hit_rate`. **Token accounting exists. What's missing is per-call price.**

| Repo | ⭐ | Last commit | License | Lang | Verdict |
|---|---|---|---|---|---|
| **pydantic/genai-prices** | 415 | 2026-11-15 | MIT | Python 3.11+ | ✅ **Adopt (highest ROI)** |
| **langfuse/langfuse** | 37,443 | 2026-11-14 | MIT + `ee/` | TS | ✅ Cloud free tier only |
| Arize-ai/phoenix | 12,298 | 2026-11-15 | **ELv2** | Python | ✅ Local, but non-OSI |
| traceloop/openllmetry | 7,537 | 2026-11-09 | Apache-2.0 | Python | OTel plumbing |
| AgentOps-AI/agentops | 5,958 | 2026-06-25 | MIT | Python | Staleing |

**pydantic/genai-prices** is the single highest-value item in this entire brief because it fixes a *known, documented* defect. `features/board/README.md` says of GPT Astra: *"cost **UNKNOWN** — the provider catalog reports no pricing (`{}`, billing `unknown`), so the page shows UNKNOWN rather than guessing a price."* That's the correct behaviour given bad input; genai-prices supplies the input. MIT, `requires-python = ">=3.11"`, and the root package is *"Do not publish this package to PyPI"* — you install the `packages/python` subpackage (`genai-prices`), which is published. README: *"Advanced logic for matching on model and provider IDs… Support for historic prices and prices changes… tiered pricing support."* Includes a **Cloudflare Workers AI** provider file (54 models) — relevant if you ever route through Workers AI.

**langfuse** — self-hosting is **not viable** here: the compose stack needs Postgres + ClickHouse + Redis + MinIO; ClickHouse alone won't sit comfortably in 8 GB alongside QwenPaw and Chromium. But because QwenPaw's `is_langfuse_enabled()` only checks `LANGFUSE_SECRET_KEY` + importability, pointing it at **Langfuse Cloud's free tier** is three env vars and zero code. License note: MIT except `ee/`, `web/src/ee/`, `worker/src/ee/` — fine for internal use.

**Arize-ai/phoenix** — closest thing to a true local fit: `pip install arize-phoenix && phoenix serve`, single process, SQLite-backed, OpenInference instrumentation. **But license is Elastic License 2.0**, which forbids providing it as a hosted service. For internal observability that's acceptable; if you ever expose the console to users, it isn't. Flagging because "open source" is routinely claimed for it and isn't accurate.

---

## 7. Routines / durable scheduling

**Critical baseline:** QwenPaw has a native APScheduler cron manager (`app/crons/`), `jobs.json` v2 per workspace, full REST surface (`GET/POST/PUT/DELETE /api/cron/jobs`, pause/resume/run/promote, `/{id}/state|history`), and `hooks/cron/cron_hook.py`. Your `features/routines/worker/` is the wake+history layer because the Free box pauses after 30 min idle. **There is no scheduler gap.**

The real gap is **resume-on-failure for multi-step jobs** — a 6-step routine that dies at step 4 restarts from zero.

| Repo | ⭐ | Last commit | License | Lang | Verdict |
|---|---|---|---|---|---|
| **dbos-inc/dbos-transact-py** | 1,684 | 2026-11-14 | MIT | Python 3.10+ | ⚠️ Conditional |
| restatedev/restate | 4,700 | 2026-11-14 | NOASSERTION | Rust | Too heavy |
| conductor-oss/conductor | 32,475 | 2026-11-15 | Apache-2.0 | Java | ❌ JVM |

**DBOS** is the honest candidate. README: *"annotate workflows and steps in your program to make it durable… If your program ever fails, when it restarts all your workflows will automatically resume from the last completed step."* Plus *"Schedule workflows using cron syntax, or use durable sleep to pause workflows for as long as you like."* `dependencies` = `pyyaml, python-dateutil, croniter, psycopg[binary], click, sqlalchemy[asyncio]` — **Postgres is mandatory**; there is no SQLite path. That's a new always-on service on a 20 GB disk / 8 GB RAM box.

**My recommendation: don't take it yet.** Instead, add a `steps` JSON column to the routine payload and make the existing cron dispatcher idempotent per step. That's ~100 lines and no new process. Revisit DBOS only if routines grow past ~3 steps with side effects (payments, sends, writes) where re-running is dangerous.

---

## 8. Guardrails, prompt-injection, skill supply chain

| Repo | ⭐ | Last commit | License | Lang | Verdict |
|---|---|---|---|---|---|
| **NVIDIA/SkillSpector** | 26,096 | 2026-11-14 | Apache-2.0 | Python 3.12+ | ✅ **Adopt** |
| microsoft/agent-governance-toolkit | 6,567 | 2026-11-14 | MIT | Python | ✅ Optional |
| hashgraph-online/hol-guard | 1,106 | 2026-11-15 | Apache-2.0 | Rust | Watch |
| anthropics/skills | 194,775 | 2026-11-14 | mixed Apache-2.0 | Python | ✅ Reference only |
| obra/superpowers | 317,757 | 2026-11-03 | MIT | Shell | Methodology, not code |

**NVIDIA/SkillSpector** — the most directly applicable security repo here. From its README: *"In the 31,132-skill analyzed subset of the research dataset, **26.1% of skills contain vulnerabilities** and **5.2% show likely malicious intent**."* Features: *"71 vulnerability patterns across 17 categories: prompt injection, data exfiltration, privilege escalation, supply chain, excessive agency, system prompt leakage, memory poisoning, tool misuse…"*, output in *"Terminal, JSON, Markdown, and SARIF"*, plus *"Baseline / false-positive suppression."*

This matters concretely: `features/skill-library/README.md` documents two writable skill stores (`working/skill_pool/<name>/SKILL.md` and `working/workspaces/<id>/skills/`), and `skill_paths` can add more roots. Anything entering those directories executes with the agent's full trust. Pipeline: `skillspector scan working/skill_pool` → SARIF → block on HIGH+. Run it in CI *and* as a pre-install check.

**microsoft/agent-governance-toolkit** — the conceptual pitch is right and quotable: *"Every tool call, message send, and delegation is intercepted in deterministic application code before the model's intent reaches the wire. Actions the AGT kernel denies are not 'unlikely.' They are structurally impossible."* And the honest caveat it leads with: *"Prompt-level safety… is not a control surface. It is a polite request to a stochastic system."* API is `safe_tool = govern(my_tool, policy="policy.yaml")`.

**But** QwenPaw already has `governance/policy.py`, `tool_adapter.py`, `tool_registry.py`, `resource_governor.py`, and `detectors.py` with `detect_sensitive_paths`, `detect_dangerous_patterns`, `detect_shell_evasion` — and writes decisions to `governance/audit.db`. **Adding AGT would be a second, competing policy engine.** Read it for the policy-YAML vocabulary; don't install it.

**anthropics/skills** — worth reading for the spec only. Your `SKILL.md` frontmatter already matches (YAML with `name`/`description`/`metadata.qwenpaw`). Don't vendor the repo.

---

## Anti-picks — hyped, wrong for these constraints

**1. MemTensor/MemOS (12,402⭐) — self-host path.**
README's own comparison table is the rejection: self-host needs **"Neo4j + Qdrant"** via `docker compose up`. On 4 vCPU/8 GB/20 GB that's two JVM/vector services competing with QwenPaw and Chromium. Worse, the Cloud API dashboard link is `memos-dashboard.openmem.net/**cn**/quickstart` and assets load from `statics.memtensor.com.cn` — a China endpoint, which you've ruled out. The `apps/memos-local-plugin` (SQLite + FTS5, genuinely `100% local, zero cloud dependency`) is real, but its `package.json` declares `"openclaw": {"kind": "memory"}` with a DeepSeek-Harness `peerDependency` — **it is an OpenClaw/Hermes plugin, not usable from QwenPaw.** Stars are for the hosted story.

**2. e2b-dev/E2B (14,865⭐) — self-hosting.**
README, verbatim: *"Read the embed deployment guide to learn how to set up the E2B runtime on your own. **The infrastructure is deployed using Terraform.** Supported cloud providers: AWS, Google Cloud."* Firecracker needs KVM and a hypervisor-capable host. There is no Free-VM path. The SDK is fine *if* you pay E2B Cloud — which violates the free-tier constraint.

**3. lm-sys/RouteLLM (5,704⭐).**
Last commit **2024-08-10** — roughly two years stale, and `pushed_at` matches. It's a research artifact: routers are *trained* artifacts (`mf`, `bert`, `causal_llm`) that need fitting on preference data before they route anything. You'd be maintaining a dead repo to get a classifier that `semantic-router`'s `fit()` gives you in 18 labelled lines. Star count is legacy from the 2024 cost-saving wave.

**4. microsoft/OmniParser (25,623⭐).**
License is **CC-BY-4.0** (weights, not code) and it needs `icon_detect_v3/model.pt` (YOLOv9-E) plus a Florence-2 captioner downloaded from HuggingFace. That's a **local vision model** — a direct violation of "no local models," and ~2–4 GB of disk you don't have. Last commit 2026-07-20 while `pushed_at` shows 2026-11-14 (README/badge churn only). It also solves a problem you don't have: QwenPaw's computer-use MCP already returns structured screen state.

**5. NadirRouter/NadirClaw (665⭐).**
README states it plainly: *"licensed under **PolyForm Noncommercial 1.0.0**, so it is source-available, not open source."* Commercial use requires their hosted tier at *"a flat $0.002 per request, first 50 a month free."* It's a freemium funnel for a classifier. `semantic-router` is MIT and does the same job.

*(Honourable mention: **vllm-project/semantic-router** (6,477⭐, Apache-2.0) is excellent engineering but it's a Go inference-side router in the vLLM/k8s ecosystem — it assumes you're serving models, and its topics are `["vllm","kubernetes","inference","mixture-of-models"]`. Wrong layer for an OpenAI-compatible client.)*

---

## What I'd actually build, in order

1. **`features/board/refresh-cost.py`** → import `genai_prices.calc_price()`, map `provider/model` to its `(provider_id, model_id)` matcher, delete the `UNKNOWN` branch. Keep `UNKNOWN` as the fallback when the matcher misses — that honesty is good.
2. **`features/routing/`** → `routes.yaml` (e.g. `chitchat`, `tool-use`, `code`, `long-context`, `escalate`) + `policy.py`. Wire into `RoutingPolicy.decide()`. Log `reasons` to the existing `audit.db` so you can measure the router against actual escalations. Ship behind `enabled: false` and A/B it.
3. **a proposed scanner under `features/skill-library/`** → `skillspector scan` over `working/skill_pool` + every `working/workspaces/*/skills`, SARIF out, non-zero exit on HIGH. Add to the CI workflow and to the skill-install convention in `README.md`.
4. **Langfuse Cloud free tier** → set `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_HOST` in the container env store (`qwenpaw env set`). Verify `is_langfuse_enabled()` returns true. Then the `token_usage` numbers get per-turn trace structure for free.
5. **`features/infra/evals/inspect/`** → port `cases.json` to inspect tasks that call `/api/console/chat/task`, keeping the existing auth/rate-limit handling. Grow to 20–30 cases before you touch prompts again.

**Deliberately not doing:** a memory framework (#1), a sandbox (#4), a workflow engine (#7), a second policy engine (#8). Each would duplicate code that already ships and works — the failure mode `features/memory/README.md` was written to prevent.

---

*All repos verified via `gh api /repos/<owner>/<name>` on 2026-11-15. Licenses from the GitHub license API, cross-checked against in-repo `LICENSE` files where the API returned `NOASSERTION` (Langfuse → MIT + `ee/`; Phoenix → Elastic 2.0; TiMEM → Apache-2.0 core + MIT tools).*