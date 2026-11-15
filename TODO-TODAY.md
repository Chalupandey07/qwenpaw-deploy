# TODO — Today, 2026-11-15: everything, verified

Owner split: **AutoClaw codes + commits to main. Muse deploys to Cloudflare, syncs the machine, and tests live (protocol + real browser). Nothing counts as live until Muse tested it.**

## Done today (do not redo)
- KV → D1 migration LIVE: D1 `qwenpaw-state`, 12 tables, USE_D1=1 on Pages (qwenpawx `50600362`, frontend `572c5932`), keep-alive, routines. Storage harness 38/38. Test-project Round 6: 49 PASS, 0 FAIL.
- Board → D1 migration: IN PROGRESS by a separate agent right now — do not duplicate it. (Tickets table, KV export backup first, rate-limit + auth fix, deploy, verify.)

## P0 — verify TODAY (Muse runs the browser; AutoClaw fixes whatever fails)
- T52 take/release (pill appears once, clears on release, no stuck "Connecting…" overlay)
- T53 Team → Private switch (renders the :2 screen, distinct from Team, no "Screen link expired")
- T56 needs-you banner (real agent run hitting the Gmail sign-in must raise the banner with Skip / I'm done / Take control — no Chromium workaround)
- T59 group-chat post flow — needs GROUPCHAT_TOKEN (user-held; ask Muse, never invent it)
- T60 board CRUD — needs the board key (user-held); runs after the board D1 migration
- T61 evals live run — satwik password is with Muse (safe env)
- T58 console login as satwik — already verified live 01:04 IST, do not re-ask for the password

## P1 — fix TODAY
- Open audit items: `qwenpaw-query-token-leak`, `infra-email-prompt-injection`. (Board rate-limit/auth is being fixed in the board migration — do not duplicate.)
- AutoClaw's pending full reply (D1 plan + bug list, asked 13:12 IST) — fold its best ideas in when it arrives.
- Every bug from the comprehensive audit (the big best-agent request) — fix in severity order, with a live test for each.

## P2 — build TODAY (unblocked)
- Phase 4 memory: Ripwire first (verify AVX2, install under /data/home, never /tmp), then the Tier 1 FTS5 recall bridge inside the container (≤3 capped excerpts, 2,000-token/turn hard cap), repair ReMe (it produced zero memories), lessons in the EXISTING `## Important Decisions and Lessons` section of MEMORY.md (not a new file; `LESSONS.md` only if split later).
- Phase 5 Code Mode pilot: one Worker-side Code Mode agent (Durable Object, `createCodemodeRuntime`) + McpConnector driving ONE routine end-to-end, measuring turns/tokens/latency against the classic approach. Do NOT rebuild QwenPaw's loop; do NOT use the legacy `createCodeTool` path expecting prompt savings.
- Phase 2 JEV + Phase 3 Drex: BLOCKED on keys (TypeSafe API key, NACE key confirmation) — do the source checks, the `decide` skill, and the designs now; implement the keyed parts when keys land. Drex is a DECISION model, never a chat provider — never put it in `active_model`/`fallback_models`.

## P3 — needs the user (do not invent, do not work around)
- `INSTABOX_API_KEY` as a Worker secret (unblocks the "…" maintenance menu + `__wake` desktop-start)
- Telegram bot token + numeric Telegram ID; `CLOUDFLARE_API_TOKEN` + `GITHUB_TOKEN` in QwenPaw env; mailbox MCP `qwenpawmail` config
- Decisions: enable heartbeat, approvals AUTO → SMART, model-fallback patch (mosicn default / Astra fallback), install the group-chat relay or keep manual replies, voice path (LiveKit free tier vs Twilio trial), bot email (needs a user-owned domain — account has zero zones)
- QwenPaw 2.3.1b1 upgrade: beta — needs explicit user approval, rebuild + restart + snapshot

## Rules (every commit)
- Free tier only. English only. No China endpoints/data. No secrets in git/files — never print a token or key.
- Run the repo harnesses green before committing (desktop gate, chrome, origin, storage).
- Update PLAN.md + RESULTS.md in the same commit as the work.
- Never claim anything is live or fixed until Muse tested it live. Report blockers explicitly instead of working around them.
