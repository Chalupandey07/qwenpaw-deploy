# AGENTS.md — working on the QwenPaw deployment

You are working on **`Chalupandey07/qwenpaw-deploy`**: the control plane for a
QwenPaw agent running on an InstaBox **Free** machine, fronted by Cloudflare
Pages + Workers. This file is the contract. Read it before touching anything.

Keep this file under **20,000 characters** — the size an agent loads whole.
Put long rules in the owning feature guide and leave a one-line pointer
here. **Every new rule cites an incident:** the date + the failure that paid
for it (see `docs/LESSONS.md` for the full symptom → cause → fix story).
A convention that lives only in prose gets violated within a week; a rule +
a mechanical check survives — the checks live in `scripts/checks/` and run
before every push (see §5).

---

## 1. The one rule

**Nothing is "done" until it is verified live by whoever can see the live
system.** Code that compiles, a harness that passes, and a protocol check are
*evidence*, never *proof*. Write down which of the three you have.

The two known failure modes this rule exists to stop:

- A deploy-generated admin password was reported as working ("login 200") for
  hours; the real account was a different user. **Verify the actual thing.**
  (2026-11-15, docs/LESSONS.md.)
- A browser round lost three tests to a spent Cloudflare KV write quota that
  no protocol test could see. **Check the quota before spending a session.**
  (2026-11-15/17, docs/LESSONS.md.)
- A rendered `docker run --tmpfs` with a bare size (`16m` instead of
  `size=16m`) passed 50/50 machine-free and failed live with exit 125.
  **Validate rendered commands against the tool's real option grammar, and
  run the rendering live the first time it executes.** (2026-11-19,
  docs/LESSONS.md.)
- A control that silently reverts looks broken — show the server's reason
  next to it. A load-bearing guard scoped to a whole ancestor hides
  legitimate renames — scope it to code-like parents only. (2026-11-19,
  docs/LESSONS.md.)
- A hide/match rule must use the control's real live label, not a label
  found in the bundle's strings for another screen — verify against the
  live DOM. A display name may render truncated — rename the truncated
  form too, never only the full phrase. (2026-11-19, docs/LESSONS.md.)
- Before assuming a live UI element belongs to the upstream app, grep the
  deployed bundles for its distinguishing string; if the string exists
  nowhere in the app, the element is ours. (2026-11-19, docs/LESSONS.md.)
- An injected element that can be created under different anchors needs a
  document-wide guard, never an anchor-scoped one — the anchor can resolve
  to a different container on different passes. (2026-11-19,
  docs/LESSONS.md.)
- Never patch a content-hashed asset in place when it is served immutable
  — the browser keeps the old bytes under the same name; change the URL
  (rename the file or add a version query) or the fix never reaches the
  tab. (2026-11-19, docs/LESSONS.md.)
- A timestamp that is only written on change is a stale clock, not an
  uptime source — guard uptime needs its own run-start observation, set
  at the down→up transition and never refreshed while up; and a fix that
  only fires on a future state transition is dead code when the live
  state is already past it — reconcile the current state on the next
  tick. (2026-11-19, docs/LESSONS.md.)

**When you learn something new:** add the one-line rule here and the full
symptom → cause → fix story to `docs/LESSONS.md` (append-only, timestamped,
never rewritten). If the lesson can be checked mechanically, add a check
under `scripts/checks/` — the check is the backup.

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
worker/              keep-alive Worker (cron 5m, status write-on-change)
pages/public/        Pages proxy: _worker.js (console + /desktop), desktop-chrome.html
  _worker.js         the single most important file: proxy, auth gate, lease, capabilities
features/desktop/    live desktop: services, lease-watcher.py, pty-server.py, harnesses
features/routines/   routines Worker (cron wake + pending prompts)
features/groupchat/  group-chat Worker (Durable Object) + machine-side relay
features/board/      ticket board Worker (D1 + DO rate limiter)
features/botpages/   self-contained page builder + Pages deploy
features/memory/     bounded recall, lessons ledger, ReMe doctor, ripwire installer
features/codemode/   Code Mode pilot (measures; does not claim)
features/test-project/  the test catalogue, runner, preflight, log-check
features/audit-2026-11-15/  the security audit of record (19 findings, 6 fixed)
features/research/   research notes that code decisions rest on
scripts/checks/      mechanical checks (no China endpoints, no secrets,
                     AGENTS.md under its 20,000-char cap, no polling as the
                     main path) — run `bash scripts/checks/run-checks.sh`
                     before every push; see scripts/checks/README.md
docs/LESSONS.md      the lessons log — full symptom → cause → fix stories,
                     append-only, timestamped, never rewritten; AGENTS.md
                     holds the distilled one-line rules
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
4. **Run the suite and the checks before committing:**
   ```bash
   python3 features/test-project/run-tests.py \
     --only T46,T47,T48,T62,T70,T71,T72,T73,T74,T75,T76,T77,T78,T79,T80,T81,T82,T83,T84
   bash scripts/checks/run-checks.sh
   ```
   These are the machine-free tests (~20 groups, ~600 checks). Everything else
   needs Muse's box. **Registrations get lost when `run-tests.py` is rewritten
   — it has happened three times.** After any change to that file, count the
   `("T##"` registrations; a suite that stays green because nothing runs is
   the worst failure mode this repo has. The checks are the mechanical backup
   for the rules in §3: a check that exits nonzero blocks the push until the
   violation is fixed or an allowlist entry is added with a comment explaining
   why — never weaken the check.
5. **Secret-scan before pushing:** `bash scripts/checks/check-no-secrets.sh`
   (the mechanical check; it uses the stricter length-qualified pattern so
   documentation and regex-pattern definitions do not fail). The raw scan is
   `grep -rniE 'ghp_|github_pat_|sk-[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}' --include='*.{js,py,md,toml,json}' .`
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
| D1 rows written | 100,000/day | fine if writes are per-action, not per-tick (heartbeat alone is 5,760) |
| D1 rows read | 5,000,000/day | **index every WHERE** — an unindexed scan is a row-read charge |
| D1 row size | **2 MB** (whole row) | previews are capped at 1.5 MB to leave headroom; never add a larger BLOB |
| D1 queries/invocation | **50** | batch writes — `batch()` counts as one |
| D1 storage | 5 GB total | previews are ~1.1 MB total because one row is overwritten per computer |
| Workers KV writes | **1,000/day** | legacy/rollback path only — treat as **zero**; a spent quota once broke every desktop write |
| Durable Objects | 100,000 req/day | fine at human pace; do not put heartbeats in a DO |
| R2 (if adopted) | 10 GB-months, 1M Class A/mo | the ceiling-free home for preview bytes |

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
