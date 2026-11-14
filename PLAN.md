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

### Phase 2 — JEV (research first, then implement)
- [ ] Research: awesome-jev-tools repo — what JEV is, full project list, which fit our system (research subagent running)
- [ ] Implement the best-fitting JEV features as OPTIONAL — user must be able to use JEV or not, never forced
- [ ] Test JEV features in the test project rounds

### Phase 3 — NACE / Drex models (research first, then implement)
- [ ] Research: console.nace.ai/docs — Drex models, API base, auth, endpoints, OpenAI-compat (research subagent running)
- [ ] Store the NACE key via the secure connector flow (never in files/git)
- [ ] Add Drex as an OPTIONAL QwenPaw provider alongside Astra/Kilo/mosicn — never a replacement. NOTE from docs landing page: Drex is a calibrated decision/evaluation model + document intelligence (Perception/NDI), not a general chat LLM — the research must confirm exactly how it can (and cannot) be used as a provider before building anything
- [ ] Test Drex provider in the test project rounds

### Phase 4 — Memory (research first, then implement)
- [ ] Research: deja-vu (vshulcz/deja-vu) — verdict replace-vs-augment for QwenPaw memory (research subagent running)
- [ ] Lessons file: agent keeps writing lessons.md (correct spelling — verify against repo/QwenPaw convention) recording lessons + mistakes so it improves itself
- [ ] Fast, low-token memory search (embeddings/indexed retrieval/summaries — design from research)
- [ ] Research: Ripwire (redhat-et/ripwire) — ranked code map; verdict vs/complementing deja-vu (research subagent running)
- [ ] Implement the winning memory setup; test recall speed + token cost in the test project

### Phase 5 — Cloudflare Code Mode (research first, then implement)
- [ ] Research: cloudflare/agents Code Mode docs — MCP tools through TypeScript code, token savings, setup (research subagent running)
- [ ] Wire our MCP tools through Code Mode where it fits; measure token savings on multi-step workflows
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
