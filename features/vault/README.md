# API key vault — the model can USE a key but never SEE it (Rakazo-style)

**Status: DEPLOYED + LIVE 2026-11-17 (D1 schema applied, master/broker
secrets provisioned, both Pages deployed, broker installed on the machine
at 172.18.0.1:8896, /health ready:true, /vault UI verified live in a real
browser with a canary item). Harnesses green: T106 55/55, T107 14/14, full
machine-free suite green. Live fixes during deploy: (1) broker port
8899 -> 8896 (8899 is the Camoufox bridge); (2) broker sends its own
User-Agent `QwenPaw-Vault-Broker/1.0` — Cloudflare blocks Python-urllib's
default UA with 1010, which made /vault/export fail inside the broker and
every broker /request return 502 upstream_error. Remaining live checks:
broker /run redaction test + restart survival + a real GitHub call with a
user-supplied key.**

## What the user wants (their words, 2026-11-17)
A vault where the USER adds API keys (GitHub key, Cloudflare key, any custom
key) and the AGENT/MODEL can USE them but can NEVER SEE the values — like
Rakazo (elie222/rakazo).

## The core rule (Rakazo's design)
The key value is decrypted ONLY inside a server-side boundary. The model
sends only the key NAME + what it wants done. The server builds the request
with the real key itself, and every byte coming back toward the model passes
a redactor that replaces the value with `[redacted]`. The model never sees
the header or the value.

Full study: `~/workspace/rakazo-vault-study.md` (853 lines, in Muse's
workspace, not in the repo). Build spec:
`~/workspace/autoclaw-next-account-vault-prompt.md`. This README is the
record of what was actually built, in this repo's style.

## What is where

```
pages/public/vault/crypto.js      WebCrypto AES-256-GCM seal/open + redaction forms
pages/public/vault/router.js      /vault/* routes (list/put/reveal/remove/activity/request/export)
pages/public/vault/ui.html        vault page (served like /computer)
pages/public/vault/vault.js       page logic (ensureSession first, token key qwenpaw_auth_token)
features/vault/vault-broker.py    machine-side broker (env-var injection + output scrubbing)
features/vault/redact.py          shared redaction module (broker + skills)
features/vault/harness-vault.mjs  machine-free harness (fail-first on all three properties)
features/skills/vault/SKILL.md   the agent-facing skill (names only, never values)
features/storage/schema.sql       vault_item + vault_use tables (D1 qwenpaw-state)
```

Mounted in `pages/public/_worker.js` exactly like `handleComputer`:
`/vault` and `/vault/*` go to `handleVault`. The page itself is exempt from
the session gate (B-39 lesson: the page is static bytes, the only way in);
every endpoint it calls is gated by `requiresSession()` — a new endpoint is
protected by default.

## The store (D1 qwenpaw-state)

`vault_item`: id (random 24-hex, PK), name (UNIQUE, lowercase-kebab
`^[a-z][a-z0-9_-]{0,63}$`), kind (`bearer | header | basic | command`),
origin (https origin the key may be sent to, `''` for command), header_name
(kind=header only), username (kind=basic only), ciphertext
(`v1:<base64url(iv|ciphertext|tag)>`), title, note, policy (`allow | off`,
default allow), scope (default `'agent'`, reserved), created_at, updated_at
(epoch ms).

`vault_use`: id, item_id, tool (`request | reveal | export | run`), site
(origin the key was sent to, `''` for reveal), created_at. Index on
(item_id, created_at DESC). Activity reads are capped at the latest 50.

## The crypto (WebCrypto, same style as `pages/public/computer/capability.js`)

- Master key from `VAULT_MASTER_SECRET` (Pages secret, 32-byte hex;
  reject placeholders; fail closed 503 `vault_unavailable` if unset).
  **The 32 raw bytes are imported DIRECTLY as the AES-256-GCM key — no
  SHA-256, no HKDF** (DeepSeek design review, 2026-11-17): the secret
  already has 256 bits of uniform entropy, which is exactly the AES-256
  key size, and a KDF cannot "improve" uniform randomness. Worse,
  SHA-256(secretString) is encoding-dependent — hashing the 64-char hex
  string and hashing the 32 decoded bytes produce different keys, and any
  environment where one path has quotes/`0x`/whitespace and another
  doesn't silently produces a second key. Decode-then-import makes the
  byte→key mapping explicit. One encoding only (hex), syntactically
  permissive about transport artifacts (quotes, `0x`, trailing newline).
  `extractable: false`, per-isolate cache keyed on the raw string (a
  rotated secret invalidates automatically).
- `sealValue`: AES-256-GCM, random 12-byte IV, AAD
  `vault\0v1\0<itemId>\0<kind>\0<host>\0value\0<key_version>`, output
  `v1:<base64url(iv|ciphertext|tag)>`. **`name` is deliberately NOT in the
  AAD** — it is mutable display metadata, and binding it forces a re-seal
  on every rename for zero security gain (name authorises nothing).
  `kind` stops cross-type confusion (a sealed `basic` blob re-labelled
  `header`). `host` is the important one: if the destination is editable
  metadata and not in the AAD, an attacker who can write the row points
  the key at their own server and the Worker exfiltrates it on next use.
  `key_version` allows rotation with dual-read.
- `openValue`: verify AAD + tag; returns null for genuine AEAD failure
  (tamper / wrong AAD / wrong key). A `VaultConfigError` is NOT swallowed
  into null — a misconfigured deployment is loud, not silently "wrong
  key". Callers must pass the row's own id/kind/host/keyVersion, never a
  request field, into the AAD.
- `redactionForms` + `redactText`: per-kind form sets (raw, JSON-escaped,
  percent-encoded, scheme-prefixed, basic decoded forms), **minimum form
  length 8** (6-char forms cause collateral redaction of ordinary
  substrings); substring replace with `[redacted]`, overlapping matches
  merged by collecting ALL ranges manually (never one alternation regex —
  it returns non-overlapping matches and silently drops overlapping
  longer forms). Base64 of a whole header and base64 of a header value
  are NOT generated (over-engineering — not reachable in a response).
  Multi-line values contribute the full value AND each long unspaced
  line. The Worker buffers the upstream response and redacts the whole
  body (simpler and strictly safer than streaming); the streaming
  variant (`makeStreamRedactor`, hold back maxLen-1 chars) exists for the
  broker, which relays a live child process's output.

## The routes (ALL behind the session gate)

- `GET /vault/list` → metadata only: name, kind, origin, title, note,
  policy, createdAt, updatedAt. NEVER ciphertext, never a value, never a
  row id.
- `POST /vault/put` {name, kind, origin?, headerName?, username?, value,
  title?, note?} → validate (name pattern; origin must be a bare `https://`
  origin, no path/query/userinfo; header name against the blocklist;
  `command` items must map to a valid, unreserved env var); seal; upsert
  by name. 409 on a command-variable conflict.
- `POST /vault/reveal` {name} → owner only: the session cookie proves a
  console login, AND the caller must ALSO present the console bearer
  token (verified against `/api/cron/jobs`, the endpoint that actually
  protects a session — the `/api/auth/status` lesson, B-37). A machine
  token is NOT enough: the broker must never be able to reveal a value.
  Returns `{value}` once; writes a `vault_use` row with tool='reveal'.
  Rate-limited hard (10/min) — it is the only route that ever returns a
  value. Note: reveal requires a running machine (the console must answer
  the probe), like `/api/session/mint`.
- `POST /vault/remove` {name} → delete row (+ its uses).
- `GET /vault/activity?name=<name>` → uses for one item (time, tool, site —
  never values).
- `POST /vault/request` {name, url, method?, body?, contentType?} — **the
  injection endpoint, the heart of the build**: load the item; refuse if
  policy is `off` or kind is `command`; refuse if
  `new URL(url).origin !== item.origin` or the URL has username/password/
  hash; decrypt server-side; build the auth header; fetch with
  `redirect: 'manual'`, 30s timeout, 1MB body cap; record a `vault_use`
  row once the request may have gone out (including send-then-fail); redact
  the response body + any paging headers/links with the redaction forms
  BEFORE truncation (20,000 chars); return {status, links?, headers?,
  body, truncated}. Never return the request headers.
- `POST /vault/export` {names[]} → broker-only (VAULT_BROKER_TOKEN,
  constant-time, fail-closed when unset). Returns each value over the
  mutually-authenticated channel so the broker can export it into a child
  process env — plus the metadata the broker needs to enforce the same
  rules the Worker enforces (the origin pin and the header name).
  Never callable from a browser session.

## The broker (machine-side, Phase 2)

`features/vault/vault-broker.py` on the machine (systemd service
`qwenpaw-vault-broker.service`, **TCP on the Docker bridge gateway
172.18.0.1:8896** — not a Unix socket, not 0.0.0.0; see the header comment
in the file for why: the caller is the agent inside a Docker container,
which can reach the bridge gateway but cannot see a host Unix socket,
and adding a volume mount needs a container recreate). Header token
`VAULT_BROKER_TOKEN` from `.env`, fail-closed. The broker is a command
wrapper, NOT a value dispenser: the skill asks it to RUN a command with
the items exported (e.g. `POST /run {names: ["github-api"],
argv: ["gh", "repo", "list"]}`). The broker fetches each value from the
Worker (`POST /vault/export`), exports `NAME → $VAR` into the child env,
runs the command, and scrubs the child's stdout/stderr with the redaction
forms before returning it. The value never enters the agent's process,
context, or any log. The broker keeps an in-memory redaction list for the
whole agent run: every value it has ever handled stays redacted in every
later output. Its `/request` endpoint re-exports the value and makes the
HTTP call locally (it has no session cookie, so it cannot call the
Worker's session-gated `/vault/request`) — enforcing the same origin pin,
policy, and redaction as the Worker.

## The UI (Phase 3)

`pages/public/vault/ui.html` + `vault.js`, served by `_worker.js` (same
pattern as `/computer`: page exempt from the session gate, every endpoint
it calls gated; `ensureSession()` first; token key is `qwenpaw_auth_token`
— the B-39 lesson). List (metadata only), filter by kind, search. Add
form: name, kind (Keys = bearer/header/basic; Variable = command), origin,
header name / username when relevant, value (password field), title, note.
Item detail: metadata, activity (uses), Show (reveals into a transient
dialog that never stores the value in page state; dialog closes on blur),
Edit, Remove (confirm first). All user-facing strings English. Linked from
the console chrome the same way the Computer button is linked (Rest button
precedent, Round 15): a "Vault" entry next to "Computer" on console pages.

## The skill (Phase 4)

`features/skills/vault/SKILL.md`: tools the agent may call — `vault_list`
(names only), `vault_request` (name + URL + method + body → Worker
`/vault/request`), `vault_run` (names + command → broker). Rules: use
names, never placeholders; never ask the user for a key value in chat (send
them to the Vault page); never print, log, or repeat a value; if a tool
result ever contains a value-shaped string, do not quote it — report "the
response contained a credential-shaped string and it was redacted".
Provider keys stay in `working.secret/providers/` (QwenPaw owns that
format; do not move them). The vault is for keys the AGENT uses (GitHub,
Cloudflare, custom). A one-way import is optional phase 5, not v1.

## The tests (Phase 5) — prove the three properties

Harness `features/vault/harness-vault.mjs` (machine-free where possible).
Fail-first: each test must fail against a vault that returns values, and
pass against the real one.

**(a) The model cannot read a key value.** Store a canary (random 32-hex,
never reused). `/vault/list` → the canary and every encoded form (base64,
percent-encoded, `Bearer <canary>`) appear nowhere. `/vault/request` to a
URL whose response echoes request headers (a local echo endpoint on the
machine) → no canary form in the returned body. `/vault/reveal` with
no/invalid session → 401; with a session but no console bearer → 401.
`/vault/request` with a URL on a different origin than the item's →
refused, and NO `vault_use` row written. Grep agent-visible artefacts
after a full run (tool results, qwenpaw.log, broker log) for the canary →
zero hits. Run the broker with a command that prints its env
(`env | sort`) → value is `[redacted]` in the output while the command
succeeded.

**(b) A tool call using the key still works.** Live (Muse runs this):
`POST /vault/request` with the user's real GitHub token (user-supplied,
never stored in the test) to `https://api.github.com/user` → 200 and the
expected login, no token form in the body. If no real token is available,
use the machine echo endpoint: it asserts the `Authorization` header
arrived intact and returns `{received: true}`.

**(c) Keys survive restart.** Store a canary, redeploy both Pages projects,
`/vault/list` + `/vault/request` again → works. Restart the broker
service → works. D1 is the durability; the master secret is a Pages
secret + `.env` value, both set once in phase 1. Rotation drill: run the
rotation script under a new master secret, verify round-trip on every
item, verify the old secret no longer opens anything.

## Risks (documented, not hidden)

- The agent's context is the leak surface QwenPaw cannot fully control: a
  skill that shells out on its own (bypassing the broker) can still read
  `working.secret/` directly. The vault gives the agent a SAFE path and
  makes the unsafe path unnecessary — the skill docs must say so. The
  vault does not remove the machine-trust boundary.
- Master-secret loss = total loss. Recovery story: the secret lives in two
  places (Pages secret + machine `.env`); if both are lost, vault items
  are unrecoverable and must be re-entered. The provisioning script
  (`scripts/provision-vault-master-secret.py`) writes both sides in one
  coordinated pass and never prints the value.
- `vault_use` rows are one per use — cap activity reads to the latest 50.
- No login/card kinds in v1 (browser-fill is a separate design).
- The broker token (`VAULT_BROKER_TOKEN`) is a high-value secret: it is
  the only credential that can make the Worker dispense values. It is
  provisioned in the same coordinated pass as the master secret, is never
  logged, and is rotated with the master secret.

## Master secret provisioning

One coordinated pass (same pattern as the computer-secrets rotation,
`~/workspace/scripts/rotate-computer-secrets.py`): generate 32 random
bytes once; set `VAULT_MASTER_SECRET` as a Pages secret on BOTH projects
via PATCH-env-vars + redeploy; write the same value to
`/data/home/qwenpaw/.env` (mode 600) for the broker. Never print, log, or
commit it. Muse performs this pass at deploy time — the script is
`scripts/provision-vault-master-secret.py`, do not run it against live
secrets from the repo.

## Quota (free tier, AGENTS.md §6)

- D1 rows written: one per vault use (request/reveal/export/run) + one per
  put/remove. Cost is proportional to user action, never to wall clock.
  No periodic vault writes exist.
- Workers requests: one per vault call. No pollers.
- D1 row size: ciphertext is a few hundred bytes; vault_use rows are
  tens of bytes. No BLOB anywhere.
- Every WHERE is indexed (`vault_item.name` is UNIQUE; `vault_use` has
  (item_id, created_at DESC)).
