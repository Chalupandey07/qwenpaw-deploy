# #22 — Evals / prompt versioning

Status: **Done (runner built, live run pending creds).** Prompts are
versioned; the runner is written and dry-run verified. It has **not** been
run live — no credentials were read or stored during this build, and the
first live run needs the user/coordinator to supply them.

## Prompt versioning — done

`prompts/v1/` holds exact copies of the live default agent's prompts,
snapshotted 2026-11-15 (byte counts match the live files: SOUL 1,679,
PROFILE 726, AGENTS 1,870, HEARTBEAT 171). Rules in `prompts/v1/README.md`:
new versions go in a new directory (`v2/`), never by overwriting `v1/`;
prompts only, never MEMORY/chats/history.

## Eval runner — built, live run pending

`evals/run-evals.py` + `evals/cases.json` (5 fixed cases: identity in
English, English-only answer, no-China-endpoint answer, timezone
awareness, destructive-action refusal).

Verified API surface (read from the installed QwenPaw v2.3.0 source):

- `POST /api/auth/login` `{"username","password"}` → `{"token","username"}`
- `POST /api/console/chat/task` with Agent API envelope
  `{"channel":"console","user_id":"eval","session_id":"eval-<case>",`
  `"input":[{"content":[{"type":"text","text": <prompt>"}]}],"timeout": N}`
  → `{"task_id": ...}`
- `GET /api/console/chat/task/{task_id}` → task status
- Auth header: `Authorization: Bearer <token>` (verified in `auth.py`)
- Login is rate-limited: 423 = locked, 429 = throttled with `Retry-After`

Runner behaviour (per source + GPT Astra design review):

- Logs in **once** per run, token in memory only, never written to disk.
- 423 ends the run immediately; 429 honours `Retry-After` + backoff.
- 401 on a task call: one re-login, retry once.
- Pass/fail is a case-insensitive substring check on the reply; every run
  writes one JSONL file with the raw task response, so a failure can be
  inspected by hand. If the task response shape is not recognised, the
  case is marked **unverified**, never faked as pass.
- `--dry-run` validates the cases and prints the exact request envelope
  with no login and no network calls. Dry-run was verified locally.

## What still needs the user/coordinator

1. Run the first live eval: `QWENPAW_USER=satwik QWENPAW_PASS='...' python3
   evals/run-evals.py` (from the machine, or anywhere that can reach the
   console URL). The password must be supplied at run time, never stored.
   Note: the default chat model changed during this build from Kilo to
   GPT Astra (`xingchiapi/gpt-6-astra`, user action 01:04 IST) — evals
   will run against Astra unless the model is changed back first.
2. Review the recorded replies: substring checks are heuristic. The
   `destructive-refusal` case especially needs a human read.
3. After any prompt change (new `prompts/v2/`), re-run and keep the
   results file next to the new version.

## Limits (honest)

- No GPU/benchmark harness, no LLM judge — substring checks only.
- The `GET /chat/task/{id}` response shape was read from the router
  signature, not from a live response; the runner handles unknown shapes
  by marking cases unverified. If the first live run shows a different
  shape, the extractor in `run-evals.py` needs one update, not a redesign.
- Evals run against the live agent, so they create real eval chats in the
  console (session ids `eval-<case>`). That is by design and visible.
