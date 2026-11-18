# Console fallback Worker (qwenpaw-console)

Temporary front door for the QwenPaw console, deployed 2026-11-18 when
Cloudflare Pages stopped executing `_worker.js` on this account (see the
1027 incident in `docs/LESSONS.md`).

## What it is

The same proxy as `pages/public/_worker.js` — console proxy, AgentX
rebrand injection, `/status`, Your Keys section, session-state read —
running as a standalone Worker at
`https://qwenpaw-console.qwenpaw-rohan.workers.dev/`, built by
`scripts/build-console-fallback-worker.py`.

## How it works

`build-console-fallback-worker.py` bundles `pages/public/_worker.js` with
esbuild (same as the Pages deploy), then replaces every `env.ASSETS`
reference with a shim `__assets(env)`. On Pages, `env.ASSETS` is the real
static-asset binding and is used as-is. In the standalone Worker there is
no ASSETS binding, so the shim fetches the same file from the Pages static
server (`https://qwenpawx.pages.dev/...`), which keeps serving static
files while Functions are down. `fetch()` follows the 308 clean-URL
redirects Pages sends for `.html` files.

D1 (`QWENPAW_DB` / `COMPUTER_DB`, same `qwenpaw-state` database) and KV
(`STATUS`) are bound in `metadata.json`, so the sleep/wake visit signal
(`recordLastVisit`) keeps flowing through the fallback.

## What is DEGRADED (honest, not hidden)

The standalone Worker cannot have the Pages secrets (`DESKTOP_*_TOKEN`,
`VAULT_MASTER_SECRET`, `VAULT_BROKER_TOKEN`, `RESET_TOKEN`,
`INSTABOX_API_KEY`, `COMPUTER_SESSION_SECRET`). Secret values are not
readable via the Cloudflare API and are never invented. So in the
fallback these fail (their routers return 500s):

- `/computer` session mint + desktop proxying (no desktop tokens)
- `/vault` reveal (no vault master secret / broker token)
- `/reset` execution (no reset token)
- The Rest button (needs `INSTABOX_API_KEY`)

The console itself — chat, rebrand, `/status`, Your Keys, session-state —
needs no secret and works fully.

## Deploy / redeploy

```bash
python3 scripts/build-console-fallback-worker.py /tmp/qwenpaw-console-fallback.mjs
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py put-worker \
  /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/workers/scripts/qwenpaw-console \
  /tmp/qwenpaw-console-fallback.mjs @features/infra/workers/console-fallback/metadata.json
# A freshly uploaded script has its workers.dev route DISABLED — enable it:
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py post \
  /client/v4/accounts/ca85fe3692c3f378200950999df9a35e/workers/scripts/qwenpaw-console/subdomain \
  '{"enabled": true}'
```

`put-worker` metadata REPLACES bindings — include all of them every time.
Plain-text vars MUST be `plain_text` bindings (a top-level `vars` object
is silently dropped by the upload API).

## When to retire it

When Pages Functions recover, the Pages URLs are the front door again
(they carry the secrets and the full computer/vault/reset surfaces).
Keep this worker deployed as a spare front door until then; delete it
only once Pages has served the console normally for a full day.
