# Approval TTL — expire pending approvals + secret requests (gap #18, T132)

Date: 2026-11-18. Port of gogibeta/rakazo PR #50 (F6). **Code complete,
NOT verified live:** the module is repo code, not yet wired into
QwenPaw's approval-card path — see "What is NOT verified live" below.
No machine file was changed by this work.

## TL;DR

A pending approval card or secret request now carries an expiry
(`expires_at_ms`, stamped at issue). If nobody answers in time it
resolves as a denial — the bot carries on without doing the action —
and the card shows it expired. A late answer is refused, in the app
and in chat apps. Approval TTL defaults to 24 hours, secret TTL to
1 hour (secrets shorter than approvals). Plain questions carry no
effect and never expire. The store is a JSON file with an exclusive
file lock, so `expires_at` survives a restart and a sweep can never
lose an answer's update.

## What changed 2026-11-18 (all-20 gap #18, T132, 41/41 machine-free)

One new directory, stdlib-only Python, all machine-free tested
(`python3 features/approval-ttl/test_approval_ttl.py`, **41/41**):

| File | What it is |
|---|---|
| `ttl.py` | The TTL module + store + sweep + CLI. |
| `test_approval_ttl.py` | The test (T132). |
| `README.md` | This file. |

## The rule (what the module enforces)

- `issue(kind, request_id, tool)` stamps `expires_at_ms = now + TTL`
  (approval 24h, secret 1h; env overrides `APPROVAL_TTL_MS` /
  `SECRET_REQUEST_TTL_MS`). A `question` gets no expiry.
- `read(request_id)` is **pure** — it reports the effective state but
  never mutates. A pending item past its TTL reads as denied with
  reason `"timed out"` (never pending, never allow). The boundary is
  `now >= expires_at` (the same boundary the routines Worker's
  `expires_at > now` read enforces).
- `answer(request_id, approve)` checks **terminal state before the
  clock**: an already-answered item raises `AlreadyAnsweredError`
  (never flips, whatever the clock says); a pending item past its TTL
  is persisted as denied-expired with its audit row and then raises
  `ExpiredError` ("This request expired before it was answered." —
  the fork's message), so the late approval is never applied.
- `sweep()` resolves every pending item past its TTL (idempotent).
  Only items still pending inside the lock are resolved — the
  conditional-update equivalent of the fork's
  `updateMany({status: "waiting_input"})` guard.
- Expiry is a pure function of the stored `expires_at_ms` and now, so
  a restart cannot resurrect a stale card: the timestamp survives in
  the file and every read after the restart still denies it.
- A bad TTL env value can never make approvals expire instantly: an
  unparsable value, or one below the 1-second floor, falls back to the
  default (the fork's rule, verified from its test). Changing the env
  after issue never moves a stored expiry.

## What an expiry looks like

Approval — status `denied`, `answer: "expired"`, card copy
`"This approval expired"` (the fork's AskCard copy):

```json
{"request_id": "req-1", "kind": "approval", "status": "denied",
 "reason": "timed out", "expired": true, "do_not_retry": true,
 "card": "This approval expired"}
```

Secret — status `completed`, result `{"ok": false, "expired": true}`,
card copy `"Expired"`, and the resumed run sees the prompt
`"The request expired before it was answered."` (the fork's
`EXPIRED_SECRET_RESULT` / `EXPIRED_SECRET_PROMPT`).

Audit (one row per expiry, fork-shaped, snake_case):

```json
{"actor": "system", "outcome": "denied", "tool": "execute_shell_command",
 "request_id": "req-1", "decision": "expired", "via": "sweep",
 "age_ms": 61234, "at_ms": 1799999999999}
```

`via` is `"sweep"` or `"answer"` — the fork's two values. `age_ms`
is how long the item waited past its expiry.

## The store (persistence + concurrency)

`CardStore(path)` — one JSON file `{version, items: [...], audit:
[...]}` under the working dir (the parent's live path is
`working/approval-ttl/pending.json`; see "Machine-apply" below).

- Atomic writes: temp file in the same directory + flush + fsync +
  `os.replace` + a best-effort directory fsync. Mode `0600`.
- Every read-modify-write (`issue` / `answer` / `sweep`) runs inside
  an exclusive `fcntl.flock` on `<store>.lock`, re-reading the store
  after acquiring the lock — so a sweep and a late answer cannot lose
  each other's update (the lost-update hole DeepSeek found in the
  first design, fixed before the test was written). A caller that
  cannot acquire the lock within `--lock-timeout` (default 10 s) gets
  `TimeoutError` and must not proceed with a stale snapshot.
- `read()` takes no lock: `os.replace` gives it a consistent
  old-or-new snapshot, and it mutates nothing.
- Audit is pruned to the last 1000 rows on save (unbounded growth
  would eventually breach the 2 MB D1-style row thinking — here it is
  just disk hygiene).
- Missing file = empty store. 0-byte file = empty store. Anything else
  that does not parse as `{items: [...], audit: [...]}` raises
  `CorruptStoreError` — never a silent empty store, so a corrupt file
  can never be mistaken for "nothing pending" (which would be an
  allow path).

## Backward compatibility (the fork's migration rule, tightened)

Items recorded before this feature carry no `ttl_version` and no
`expires_at_ms`. Those **legacy** items are never swept and never
auto-denied, and they stay answerable — exactly the fork's rule
("effects recorded before it carry no expiry and are never swept").
`check` counts them separately so the operator can see them.

DeepSeek's correction, applied: the exemption is keyed on the
**missing `ttl_version`**, not just the missing expiry. A
post-migration item (one this module stamped) whose `expires_at_ms`
is missing or unusable fails **closed** as expired — a truncated
write or a code path that forgot `issue()` can never leave an
immortal, re-approvable card behind. The store starts empty (QwenPaw's
in-memory `PendingApproval` dies on restart), so the legacy population
is empty in practice; the rule exists for an imported old file.

## CLI

```bash
python3 ttl.py sweep --store PATH [--lock-timeout SECONDS] [--now-ms N]
python3 ttl.py check --store PATH
python3 ttl.py issue --store PATH --kind approval|secret|question \
                     --request-id ID --tool TOOL [--session-id S]
```

- `sweep` exits 0 and prints one line per expired id (or "no expired
  approvals"); exit 2 on a corrupt store, exit 3 on a lock timeout.
- `check` is read-only and exits 0, printing
  `pending=N stale=M expired=E legacy=L answered=A total=T` (stale =
  pending but past expiry — what the sweep would resolve).
- `issue` prints the stamped record as JSON. Re-issuing an existing
  request_id is an idempotent no-op (the fork's idempotency-key
  behaviour): the existing record is returned unchanged.

Invoke with `python3`, never execute directly — the exec bit does not
survive a GitHub API push (gh-push.py stores everything as mode
100644).

## DeepSeek design review (2026-11-18, required)

One call via `seek.py` (deepseek-v4.1-flash-free, 9,664 tokens) on
the design in `~/workspace/approval-ttl-deepseek-context.md`. It
returned 6 answers with concrete failures; all 6 were checked against
the fork diff + the repo and fixed before the test was written:

1. **The endpoint is the real gate.** `POST /api/approval/approve`
   resolves `PendingApproval.future` directly; unless the
   derived-image change makes that handler call `answer()`/`read()`
   first, the file says "expired" while the future resolves approved.
   Fixed by documenting the handler as the single choke point (see
   "Machine-apply") and stating the module is advisory until then.
2. **Lost update between `answer()` and `sweep()`.** Both did
   read-modify-write on a whole-file snapshot. Fixed with `flock` +
   re-read inside the lock (see "The store").
3. **`answer()` checked only the clock.** A caller-supplied
   `now_ms < expires_at` (clock rollback, stale snapshot) could flip
   an already-swept card to approved. Fixed: terminal state is
   checked first and is sticky; a late answer persists the expired
   state before raising.
4. **`read()` was a mutation.** A poller iterating it would mislabel
   audit (`via: "answer"`) and race the sweep. Fixed: `read()` is
   pure; only `answer()` and `sweep()` mutate (the fork's shape).
5. **Scope gap: standing grants are immortal.** AUTO/SMART
   auto-approvals and approve-with-scope `similar` grants never go
   through `issue()`, so they carry no expiry. Documented as a known
   limit below — TTLing them is a separate change to QwenPaw's
   approval model, not this gap.
6. **Legacy rule keyed on the wrong discriminator.** Keying on the
   absent `expires_at` would leave any post-migration record that
   lost its expiry permanently pending. Fixed: the exemption needs
   the missing `ttl_version`; a stamped record without a valid
   expiry fails closed.

Other review findings applied: env validated at issue time with the
fork's fallback rule; fsync-before-replace crash safety; boundary
`>=`; store mode `0600`; audit pruning; epoch-ms UTC only; the
denial carries `do_not_retry: True` (the shape the runtime already
attaches to a denied call); the secret kind is flagged as having no
live consumer in QwenPaw yet (no pending secret queue), so its TTL
is defined and tested at module level but currently inert.

## Machine-apply (the parent runs this on the machine)

This repo work changes nothing live. The parent applies it after
syncing this directory to the machine:

```bash
# 1. Sync the module (read-only until wired in):
#    features/approval-ttl/ttl.py -> /app/working/approval-ttl/ttl.py
# 2. Sweep on a timer (the store lives in the container, so the timer
#    must run where the store is — inside the container or on a shared
#    mount; a host timer pointed at the container overlay would
#    silently no-op):
python3 /app/working/approval-ttl/ttl.py sweep \
  --store /app/working/approval-ttl/pending.json
# 3. Check the queue any time:
python3 /app/working/approval-ttl/ttl.py check \
  --store /app/working/approval-ttl/pending.json
```

A systemd timer (daily is enough for 24h/1h TTLs; the read-time
check is the real enforcement and needs no timer) is the sweep's
home. The routines Worker cron cannot sweep directly: it has no
route into the container, and a separate-process sweep cannot resolve
QwenPaw's in-memory `PendingApproval.future` — it resolves the file
record and the audit, while the blocked ASK call waits for the
in-process check. That is an honest ceiling of the file-store design,
not a bug in the sweep.

## Wiring into QwenPaw (derived-image change, parent's job)

To make TTL live, the derived image must call this module at exactly
one choke point — the approve/deny handlers in
`/app/src/qwenpaw/app/routers/approval.py` (`POST /approve`,
`POST /deny`), before they resolve `PendingApproval.future`:

1. On `POST /approve` or `POST /deny`, load the store and call
   `answer(store, request_id, approve)` first.
2. If it raises `ExpiredError`, return HTTP 409 with
   `{"error": "approval_expired", "reason": "timed out"}` (the fork
   maps the same error to a conflict; chat apps reply "That approval
   expired.") — never resolve the future as approved.
3. On `GET /api/approval/list`, call `read()` per card so an expired
   card renders with the copy `"This approval expired"` (approval) or
   `"Expired"` (secret) instead of a live Approve/Deny button.
4. The store path is `/app/working/approval-ttl/pending.json`
   (working dir, survives container recreates). The TTL env vars
   (`APPROVAL_TTL_MS`, `SECRET_REQUEST_TTL_MS`) go in the container
   env (`.env` / compose), read at issue time only.

Until that change lands, the live guard still decides by
`approval_level` and `denied_tools` alone, and a pending card can
still wait forever. Do not present this module as live enforcement
before the wiring + a browser check (a card left 24h unanswered
shows expired; a late approve is refused with 409).

## Known limits (stated, not hidden)

- **Standing grants are immortal.** Approve-with-scope `similar`
  (a remembered pattern that auto-allows later calls) and AUTO/SMART
  auto-approvals never go through `issue()` and carry no expiry.
  TTLing them needs a change to QwenPaw's remembered-approval store
  — a follow-up, not this gap.
- **The sweep cannot unblock a hung ASK call.** It resolves the file
  record and the audit; the in-memory `PendingApproval.future` is
  resolved only by the in-process check in the derived-image wiring.
  Until the wiring lands, a blocked call waits for a restart or its
  own timeout.
- **The secret kind has no live consumer yet.** QwenPaw has no
  pending secret-request queue (the vault broker's `/request` is
  one-shot). The secret TTL is defined, tested, and ready for the
  queue when it exists — it enforces nothing live today.
- **The connector-declaration half of PR #50 was not ported.**
  The fork also treats connector tools with no read/write declaration
  as writes. QwenPaw's `policy.py` already fails closed on unknown
  tools (T124 F1/F5/F6), so that half adds nothing here; it is noted,
  not silently dropped.

## Verified facts (the fork, read 2026-11-18)

- PR #50 (gogibeta/rakazo, merged, state closed): "Expire pending
  approvals and secret requests after a TTL (F6)". Title/body/diff
  read via the GitHub API. `DEFAULT_APPROVAL_TTL_MS = 24h`,
  `approvalTtlMs(env)`: `Number(env.APPROVAL_TTL)`, finite and
  `>= 1000` → floored value, else the default. Migration
  `20261221120000_effect_expires_at` adds a nullable `expiresAt`
  column + a `(status, expiresAt)` index. `AnswerExpiredError`:
  "This request expired before it was answered."
  `EXPIRED_ASK_ANSWER = "expired"`,
  `EXPIRED_SECRET_RESULT = {ok: false, expired: true}`,
  `EXPIRED_SECRET_PROMPT = "The request expired before it was
  answered."` The sweeper is `createApprovalExpirySweeper`, wired
  into the job reconciler beside the audit reconciler and the
  transient pruner (no new scheduler). The answer path refuses a late
  answer in the app (HTTP conflict) and in chat apps ("That approval
  expired."). Its tests: lazy refusal at answer time, sweep denial,
  secret-request expiry, plain questions untouched, audit rows
  asserted, an AskCard render test for the expired state.

## What is NOT verified live

- The module has never run on the machine; the store file does not
  exist there; no timer is installed.
- The derived-image wiring (approve/deny handlers, `GET /list`)
  is not written, so no browser check exists yet (a card left
  unanswered past its TTL shows expired; a late approve is refused).
- The routines Worker does not sweep (it cannot reach the store);
  that is by design, documented above.
