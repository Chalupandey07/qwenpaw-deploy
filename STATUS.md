# STATUS.md — what exists vs what we want

One page, two lists, no ambiguity. "Implemented" means the code is merged;
where it is not yet verified live, that is stated.

Last updated: 2026-11-15 (after the correctness pass).

---

## Part A — Already implemented

### Infrastructure

| Thing | Where | Verified live? |
|---|---|---|
| QwenPaw v2.3.0 container on InstaBox Free | `instabox/` | **Yes** — healthy, pinned image |
| Pages reverse proxy + auth gate | `pages/public/_worker.js` | **Yes** |
| Keep-alive Worker (5-min cron) | `worker/` | **Yes** — `/status` up, 0 failures |
| Backup keep-alive (GitHub Actions, 15 min) | `.github/workflows/` | **Yes** |
| Status page + waking/cooldown pages | `pages/public/status-page.html` | **Yes** |
| Snapshot restore point | InstaBox | **Yes** — `qwenpaw-phase0-verified` |

### Desktop

| Thing | Where | Verified live? |
|---|---|---|
| Embedded desktop (Team `:1`, Private `:2`) | `pages/public/desktop-chrome.html` | **Yes** — both render |
| View/control split + 90 s lease + heartbeat | `_worker.js` | **Yes** |
| Sealed capabilities (AES-GCM, generation-scoped) | `_worker.js` | **Yes** |
| Terminal (PTY over websockify) | `pty-server.py` | **Yes** — real shell prompt |
| Side-panel preview beside chat | `_worker.js` injection | **Yes** |
| Teach-by-showing (record → playbook → skill) | `_worker.js` + watcher | **Yes** (T55 blocked only by lease) |
| Needs-you banner + resolve | `_worker.js` + chrome | **Yes** (single global record — see B-2) |
| Per-computer lease + generation | `_worker.js` | **Yes** |
| Screen previews (change-only, 120 s floor) | `lease-watcher.py` | **Yes** |
| computer-use MCP over SSE (both displays) | `mcp-computer-use*.service` | **Yes** — 9 tools each |
| Camoufox anti-detect bridge | `features/camoufox/` | **Yes** — X.com loads |
| Window re-map service | `desktop-window-watch.py` | **Yes** |
| 17 desktop services | systemd units | **Yes** — all active |

### Cloudflare features

| Thing | Where | Verified live? |
|---|---|---|
| Routines Worker (wake tick + pending) | `features/routines/` | **Yes** |
| Group chat (Durable Object, turn-taking) | `features/groupchat/` | **Yes** — token-gated |
| Ticket board (KV) | `features/board/` | **Yes** — works, loses updates under concurrency (B-3) |
| Bot pages builder | `features/botpages/` | **Yes** |
| Activity feed | `features/infra/workers/activity-feed/` | **Yes** |
| Cost + open-work dashboards | `features/board/*.html` | **Yes** |

### Testing & tooling

| Thing | Where | Verified live? |
|---|---|---|
| 67-test catalogue + runner | `features/test-project/` | **Yes** (protocol rounds) |
| Log-check (8 logs + 15 services + 8 remotes) | `features/test-project/logcheck/` | **Yes** |
| Preflight gate (KV quota, machine, watcher) | `features/test-project/preflight.py` | Code; needs Muse's box |
| 3 desktop harnesses (gate 127, chrome 34, origin 9) | `features/desktop/` | **Yes** — local |
| Memory: bounded recall / lessons / ReMe doctor / ripwire | `features/memory/` | Code, 149 checks; T65 needs sync |
| Code Mode measurement pilot | `features/codemode/` | Code, 59 checks; live path gated |
| Security audit (19 findings, 6 fix batches) | `features/audit-2026-11-15/` | **Yes** |
| Docs: AGENTS / ARCHITECTURE / BUGS / PLAN / IMPROVEMENTS / STATUS | repo root | n/a |

### Skills installed in QwenPaw

`camoufox-browser`, `build-page`, `github`, `delegate`, `mailbox` (+ 14 more)
= 19 enabled.

---

## Part B — Wanted, not yet implemented

### Blocked on a key or a user decision (no code can unblock these)

| Want | Blocked on |
|---|---|
| JEV decision model (approvals, routing, compaction) | TypeSafe API key, or an OpenRouter-route decision |
| Drex/NACE decision model | NACE key submitted via the secure link |
| Telegram bridge | bot token + numeric user id |
| Bot email receive path | a domain on Cloudflare (account has 0 zones) |
| Voice calls | LiveKit free tier or Twilio trial keys |
| `build-page` / `github` skills actually working | `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN` in QwenPaw's env store |
| Maintenance Stop action + `__wake` desktop-start | `INSTABOX_API_KEY` Worker secret |
| T58–T61 token tests | user-held passwords/tokens |
| T50–T57 browser re-run | KV quota reset (midnight UTC) + Muse's browser |

### Planned and designed, not built

| Want | Design lives in | Effort |
|---|---|---|
| **D1 migration** (leases, generations, modes, needs-you, skills, board, routines) | `PLAN.md` Phase 2, `BUGS.md` | Large — highest value |
| **R2 for preview images** | `PLAN.md` Phase 2 | Small, follows D1 |
| Per-computer needs-you records (B-2) | `BUGS.md` | Small |
| Rate limits on desktop endpoints (B-10) | `BUGS.md` | Small |
| Keep-alive write-on-change (B-7) | `BUGS.md` | Small |
| `__pending-skills` TTL + single query (B-6) | `BUGS.md` | Small |
| Idle-adaptive lease-watcher polling | `IMPROVEMENTS.md` §9.2 | Small |
| Combined `__state` endpoint | `IMPROVEMENTS.md` §9.3 | Small |
| Screenshot diffing to skip no-op turns | `IMPROVEMENTS.md` §1.2 | Medium |
| a11y-tree actions before pixels | `IMPROVEMENTS.md` §1.3 | Medium |
| Deterministic replay of taught skills | `IMPROVEMENTS.md` §1.4 | Medium |
| Routine delivery via the loopback relay | `IMPROVEMENTS.md` §3.1 | Medium — turns routines into automation |
| Durable routine runs with retry | `IMPROVEMENTS.md` §3.2 | Medium |
| Prompt-injection guard on agent-read content | `IMPROVEMENTS.md` §7.2 | Medium |
| Approvals AUTO → SMART with narrow rules | `IMPROVEMENTS.md` §7.1 | Small |
| Quota dashboard + 50/80% alerts | `IMPROVEMENTS.md` §8.1/8.3 | Small |
| Token cost per feature and per routine | `IMPROVEMENTS.md` §8.2/8.5 | Small |
| Session-start memory block (≤665 tokens) | `IMPROVEMENTS.md` §2.6 | Small |
| Bot-page manifest + prune | `IMPROVEMENTS.md` §6.1 | Small |
| Board pagination + optimistic concurrency | `IMPROVEMENTS.md` §5.2/5.3 | Small (after D1) |
| `make check` + docs link check | `IMPROVEMENTS.md` §10.2/10.3 | Small |

### Explicitly rejected (so nobody re-proposes them)

| Idea | Why not |
|---|---|
| Cloudflare Tunnel on Free | Not viable on the free tier |
| Local models / Ollama / QwenPaw-Flash | Violates the cloud-LLM-only constraint |
| QwenPaw-Flash / any China endpoint | Hard constraint |
| Ripwire MCP instead of CLI | MCP loads tool schemas into every prompt; the CLI is cheaper |
| deja-vu as a replacement for history.db FTS5 | Upstream already indexes; deja-vu needs a custom parser for marginal gain |
| Code Mode inside QwenPaw's loop | QwenPaw is Python; Code Mode is Workers-only. The pilot measures a separate Worker, honestly. |
| `createCodeTool` (legacy) for prompt savings | Its description carries the full type block — no savings |
| Paid InstaBox plan | Free only |
