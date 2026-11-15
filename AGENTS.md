# AGENTS.md — working on the QwenPaw deployment

You are working on **`Ratulbaba7/qwenpaw-deploy`**: the control plane for a
QwenPaw agent running on an InstaBox **Free** machine, fronted by Cloudflare
Pages + Workers. This file is the contract. Read it before touching anything.

---

## 1. The one rule

**Nothing is "done" until it is verified live by whoever can see the live
system.** Code that compiles, a harness that passes, and a protocol check are
*evidence*, never *proof*. Write down which of the three you have.

The two known failure modes this rule exists to stop:

- A deploy-generated admin password was reported as working ("login 200") for
  hours; the real account was a different user. **Verify the actual thing.**
- A browser round lost three tests to a spent Cloudflare KV write quota that
  no protocol test could see. **Check the quota before spending a session.**

## 2. Division of labour

| Role | Who | Does |
|---|---|---|
| Code + docs | the coding agent (AutoClaw) | edits the repo, runs local harnesses, commits to `main` |
| Deploy + live verify | Muse | deploys Workers/Pages, syncs machine files, drives a real browser, records results |

If you are the coding agent: **never claim anything is live.** Commit, state
exactly which repo file maps to which live path, and say what you did *not*
run. If Muse is unavailable, the task stays "code complete, unverified".

## 3. Hard constraints (non-negotiable)

- **Free tier only.** InstaBox Free, Cloudflare Workers/Pages/D1/R2 free.
  Never propose or use a paid plan.
- **English only.** Code, comments, docs, UI strings, commit messages. No CJK.
- **No China endpoints or data.** No ModelScope, Alibaba Cloud/ACR, DashScope
  defaults, Chinese CDNs or fonts.
- **Never commit secrets.** No token, key, password or cookie in code, docs,
  tests, commit messages, or memory. Worker tokens live only as Worker
  secrets; machine tokens only in `/data/home/**/.env` (mode 600).
- **Never invent a key.** If a task needs one and it is missing, stop and say
  which key, which scope, and who must supply it.
- **Never touch `working.secret/auth.json`, user chats, or `history.db`.**
- **The InstaBox account `custom.instabox2` is READ-ONLY.** Never call it.
- **No container restart unless proven necessary.** A restart drops in-flight
  agent work. Env/volume changes require a recreate — that is the one accepted
  exception, and it is Muse's call.
- **Cloud LLM only**, with the user's own keys. No local models, no Ollama.

## 4. What is where

```
instabox/            machine-side deploy: docker-compose, .env.example, systemd, setup.sh
worker/              keep-alive Worker (cron 5m, KV status) — README.md §2
pages/public/        Pages proxy: _worker.js (console + /desktop), desktop-chrome.html
  _worker.js         the single most important file: proxy, auth gate, lease, capabilities
features/desktop/    live desktop: services, lease-watcher.py, pty-server.py, harnesses
features/routines/   routines Worker (cron wake + pending prompts)
features/groupchat/  group-chat Worker (Durable Object) + machine-side relay
features/board/      ticket board Worker (KV today, D1 planned)
features/botpages/   self-contained page builder + Pages deploy
features/memory/     bounded recall, lessons ledger, ReMe doctor, ripwire installer
features/codemode/   Code Mode pilot (measures; does not claim)
features/test-project/  the test catalogue, runner, preflight, log-check
features/audit-2026-11-15/  the security audit of record (19 findings, 6 fixed)
features/research/   research notes that code decisions rest on
```

Machine paths (on the InstaBox box): `/data/home/qwenpaw/` (`.env`,
`docker-compose.yml`, `working/`, `working.secret/`), `/data/home/mcp-proxy/`
(lease-watcher, MCP proxy venv), `/data/home/camoufox/` (bridge + profile),
`/data/home/ripwire/` (optional code-map binary).

## 5. Change protocol

1. **Read** the relevant `features/*/README.md` and the matching section of
   `PLAN.md` first. Most "bugs" here are documented decisions.
2. **Research before implementing.** Prefer reading upstream source over
   trusting a research note — a note can be right about the *need* and wrong
   about whether it is *already solved*. (Phase 4's FTS5 bridge was already
   upstream; the note did not know.)
3. **Write the test with the code.** Every feature in this repo has a harness
   (`node features/**/harness-*.mjs`, `python3 features/**/test_*.py`) or a
   `T##` row in `features/test-project/TESTS.md`. Add one. A feature without
   a test is a rumour.
4. **Run the suite before committing:**
   ```bash
   python3 features/test-project/run-tests.py --only T46,T47,T48,T62,T63,T64,T66,T67
   ```
   These are the machine-free tests. Everything else needs Muse's box.
5. **Secret-scan before pushing:** `grep -rniE 'ghp_|github_pat_|sk-[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}' --include='*.{js,py,md,toml,json}' .`
6. **Commit** with a message that says what changed, what it cost (quota
   numbers), what you verified, and what you did **not**.
7. **Update docs in the same commit:** `PLAN.md` status line, and
   `features/test-project/TESTS.md` if you added a test.

## 6. Quota discipline

Free-tier quotas are the hard constraint that shapes the architecture. Before
adding any periodic behaviour, price it:

| Service | Free limit | Our budget rule |
|---|---|---|
| Workers requests | 100,000/day | keep fixed pollers under 10,000/day |
| Workers KV writes | **1,000/day** | treat as **zero** — a spent quota broke every desktop write once |
| Workers KV reads | 100,000/day | fine, but no N+1 loops |
| D1 rows written | 100,000/day | fine if writes are per-action, not per-tick |
| D1 rows read | 5,000,000/day | **index every WHERE** — an unindexed scan is a row-read charge |
| D1 row size | 2 MB | never store image bytes here |
| Durable Objects | 100,000 req/day | fine at human pace; do not put heartbeats in a DO |

Rule of thumb: **cost must be proportional to user action, never to wall
clock.** The KV incident happened because a preview upload ran every 15s
whether or not anything changed — ~11,500 writes/day against a 1,000 budget.

## 7. Writing style for this repo

- Lead with the constraint or the root cause, not the feature.
- State measured numbers and how they were measured (`chars / 3.6` for
  token estimates, both here and in `features/memory/recall.py`).
- Put the honest negative result in the same paragraph as the positive one.
  ("Code Mode wins on a 10-step job and is *worse* on a single call.")
- If you could not verify something, write "not verified" — never imply it.
- No marketing adjectives. "Works" or "does not work yet".

## 8. When you are blocked

Say so explicitly, in the commit message **and** in chat, with:

- what you need (a key? a browser session? a container recreate?),
- which scope/format it must have,
- what is already done and waiting on it,
- what you did *instead* in the meantime.

Do not invent, fake, or work around a missing secret or an unverified live
check. A blocked task reported honestly is worth more than a fake pass.
