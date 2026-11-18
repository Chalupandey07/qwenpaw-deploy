# Bloat win-win: source-change optimizations (upstream v2.3.0, derived image)

Win-win rule (user, non-negotiable): faster/smaller with **zero data
loss and zero capability loss**. History is never deleted or archived.
Every provider, channel, skill, and locale stays. If an optimization
would lose data or a capability, it is documented here as "leave
alone" and not done.

## What shipped: telemetry removal (the only source change)

Upstream QwenPaw phoned installation/runtime analytics home to an
Alibaba Cloud endpoint
(`https://qwenpawelemetry-sukzkbfzhc.ap-southeast-1.fcapp.run`,
Singapore Function Compute). The deployment was already opted out by
env var (`QWENPAW_TELEMETRY_DISABLED=true`), but the code and the
daily sender thread were still present. This patch removes them:

- `src/qwenpaw/utils/telemetry.py` — replaced with a stub. Keeps
  every public name the codebase imports (`TELEMETRY_MARKER_FILE`,
  `get_system_info`, `get_environment_info`,
  `has_telemetry_been_collected`, `is_telemetry_opted_out`,
  `telemetry_marker`, `mark_telemetry_collected`,
  `collect_and_upload_telemetry`, plus the private
  `_upload_telemetry_sync`) as no-ops: opted-out always True,
  collected always True, collect always False, info always `{}`,
  marker writes nothing. NO endpoint constant, NO network code, NO
  OS probes, NO disk writes.
- `src/qwenpaw/utils/daily_telemetry.py` — replaced with a stub.
  `start_daily_telemetry()` returns a `DailyTelemetry` whose
  `start()` creates NO thread and whose async `close()` / `record()`
  are no-ops; `record_agent_activity()` is an async no-op. NO thread,
  NO httpx, NO endpoint import.

Importers verified on the live container before patching (all keep
working unchanged): `app/_app.py` (line 36 `start_daily_telemetry`;
lines 270–279 telemetry import inside try/except; line 743
`start_daily_telemetry()`; line 748 `await daily_telemetry.close()`),
`runtime/runtime.py:25,149` and `harnesses/runtime.py:20,190`
(`await record_agent_activity()`), `cli/clean_cmd.py:10`
(`TELEMETRY_MARKER_FILE` only, used as a filename to preserve during
a clean), `cli/init_cmd.py:253–273` (four telemetry functions; the
whole block is skipped now because `is_telemetry_opted_out` is True).

What it preserves: nothing the user uses. Upstream loses install
analytics only. No provider, channel, skill, locale, model, or data
file is touched. `working.secret/auth.json` untouched.

## Measured before/after

Measured on the live machine 2026-11-18, image
`qwenpaw-agentx:2.3.0-gatefix3` (id `188c1eeebd9f`), before the switch:

| Measurement | Before | After |
|---|---|---|
| `python3 -X importtime -c "import qwenpaw"` (total) | 2.27–2.36 s this run (audit: 3.1 s) | same (telemetry is not on the import hot path; the win is policy + no thread, not seconds) |
| Telemetry endpoint hostname hits in running code (`grep -r qwenpawelemetry` in the image's qwenpaw package) | 1 (telemetry.py) | 0 — verified in the built image before switching |
| Daily telemetry thread at runtime | 1 daemon thread (`qwenpaw-daily-telemetry`) started at app startup | 0 — `start()` is a no-op |
| Console | 200 | 200 after the switch (verified) |
| Container | healthy | healthy after the switch (verified) |

Honest note: this change is a policy/privacy win (a forbidden
China endpoint is gone from the code, not just held off by an env
var) plus one fewer background thread. It does not measurably change
import time or console load time, and this README does not claim it
does.

## Test (machine-free, fail-first proven)

`test_bloat_winwin.py` — 26 checks (static: no endpoint hostname,
no `TELEMETRY_ENDPOINT`, no httpx, no `.post(`/`.stream(`, no sender
thread, no subprocess/uuid probes; behaviour: stub return values,
no marker file written, no thread spawned, async no-ops awaitable).

```bash
# Fail-first: pristine upstream files must FAIL
python3 test_bloat_winwin.py --telemetry src/pristine/telemetry.py \
    --daily src/pristine/daily_telemetry.py   # 1/13 pass (exit 1)
# Patched files must PASS
python3 test_bloat_winwin.py                  # 26/26 pass (exit 0)
```

The pristine run reaches only 13 checks because the pristine
modules cannot even load standalone (relative imports of
`..__version__` / `..constant` / `httpx`) — recorded as failures.
For the parent: test file `features/bloat-winwin/test_bloat_winwin.py`,
26 checks, to register as T118. `run-tests.py` / `TESTS.md` were NOT
modified here (they carry unpushed T115/T116/T117 registrations).

The patch was verified to apply cleanly to the pristine files and
reproduce `src/patched/*` byte-for-byte (local `patch -p1` check).

## Build the derived image (on the InstaBox machine)

Base is the live gatefix3 image — the loop-gate fix survives
untouched (the patch touches only the two telemetry files). No
registry credentials exist, so build on the machine:

```bash
cd /data/home/qwenpaw/bloat-winwin   # feature dir synced to the machine
docker build -t qwenpaw-agentx:2.3.0-bloatwinwin1 .
docker images qwenpaw-agentx:2.3.0-bloatwinwin1   # record the digest
```

The Dockerfile fails the build if the patch does not apply cleanly
to either copy (`/app/src` and site-packages — same dual-copy rule
as the loop-gate fix; Python imports from
`/app/venv/lib/python3.11/site-packages/qwenpaw/`).

## Verify the image (before switching the live container)

```bash
# No endpoint hostname anywhere in the running code
docker run --rm qwenpaw-agentx:2.3.0-bloatwinwin1 \
  grep -r qwenpawelemetry /app/venv/lib/python3.11/site-packages/qwenpaw/ || echo "0 hits"
# The patched modules import; the gate enforcer is still present
docker run --rm qwenpaw-agentx:2.3.0-bloatwinwin1 python3 -c "
from qwenpaw.utils.telemetry import is_telemetry_opted_out, collect_and_upload_telemetry
from qwenpaw.utils.daily_telemetry import start_daily_telemetry
from qwenpaw.loop.gates.limits import install_execution_budget, try_reserve_execution
from pathlib import Path
assert is_telemetry_opted_out(Path('/tmp')) is True
assert collect_and_upload_telemetry(Path('/tmp')) is False
svc = start_daily_telemetry(); svc.start()
import threading
assert not any(t.name == 'qwenpaw-daily-telemetry' for t in threading.enumerate())
class S: reply_id = 'r1'
class A: state = S()
a = A()
install_execution_budget(a, 'r1', 30, {'execute_shell_command': 20})
ok = sum(1 for _ in range(200)
         if try_reserve_execution(a, {'type': 'tool_call',
             'name': 'execute_shell_command', 'input': {}}) is None)
assert ok == 20, ok
print('telemetry stub OK, gate enforcer OK (20/200)')
"
# Smoke-start on a scratch port and confirm the console serves
docker run -d --name bloat-smoke -p 18098:8088 qwenpaw-agentx:2.3.0-bloatwinwin1
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18098/
docker rm -f bloat-smoke
```

Do NOT switch the live container to an image that has not passed
these checks.

## Deploy (snapshot first)

Snapshots are at the 5-snapshot Free limit: delete the oldest
SUPERSEDED snapshot first per Rohan's standing delegation
(`qwenpaw-before-gatefix`, `sn_agq63ceg44aou3umtzwtoxoyny`).
NEVER delete `qwenpaw-phase0-verified`
(`sn_agq53pcvh6nfxjbyc4pfuk3vua`).

```bash
# 1. Snapshot the machine (record the new snapshot id).
# 2. Edit /data/home/qwenpaw/docker-compose.yml: change ONLY the image
#    line to qwenpaw-agentx:2.3.0-bloatwinwin1. Keep every mount, env
#    var, and port.
# 3. Restart and confirm the console comes back:
docker compose -f /data/home/qwenpaw/docker-compose.yml up -d
curl -s -o /dev/null -w '%{http_code}\n' \
  https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/
curl -s https://qwenpawx.pages.dev/api/auth/status
```

## Deploy record (2026-11-18, live)

- Image built on the machine: `qwenpaw-agentx:2.3.0-bloatwinwin1`,
  id `fcf76b7324e9`, manifest
  `sha256:fcf76b7324e9526f7a96c3814d3ecab143443475fa1e70731d8b251fa4c33904`.
  Patch sha256 on the machine matches the repo file
  (`646282b1bba9e9ee37cafd32ce1add16c535d72cf5c24fe911eec2f9c2a25754`).
- Pre-deploy snapshot: `qwenpaw-before-bloatwinwin1`,
  `sn_agq63rppqkphhnl3fppu6w4jne` (created 2026-11-18 08:28:54 UTC
  via `POST /v1/machines/{id}/snapshots`; still `pending` at deploy
  time — confirm it reaches `ready`). Deleted first, per standing
  delegation: `qwenpaw-before-gatefix`
  (`sn_agq63ceg44aou3umtzwtoxoyny`, superseded).
  `qwenpaw-phase0-verified` untouched. Snapshot create path learned:
  `POST /v1/machines/{id}/snapshots` with `{"name": ...}` (202);
  DELETE needs an `Idempotency-Key` header too (400 without it) and
  returns an empty body on success.
- Live container switched 2026-11-18 ~08:34 UTC: `docker-compose.yml`
  image line only, `up -d`; container healthy, console local 200,
  public console 200, Pages root 200, `/api/auth/status` 200
  (`{"enabled":true,"has_users":true}`). New log has zero
  `telemetry` mentions and no traceback. Gatefix3 image retained
  for one-line rollback. Note: docker images are now 5 of 5 — the
  next derived image will need an old image deleted first.

## Rollback

If the console does not come back:

```bash
# Revert docker-compose.yml to gatefix3:
#   image: qwenpaw-agentx:2.3.0-gatefix3
docker compose -f /data/home/qwenpaw/docker-compose.yml up -d
```

If the container will not start at all, restore the pre-deploy
InstaBox snapshot (id recorded at deploy time).

## What was assessed and LEFT ALONE (with the measured reason)

### Lazy local-model stack — left alone, no measurable win

- `app/_app.py:34` imports `LocalModelManager`; `:312–314`
  constructs it at startup via `asyncio.to_thread`; `:443` stores it
  in `app.state`; `:633` passes it to
  `provider_manager.start_local_model_resume()`; `:774` shuts it down.
  The resume path itself gates on configuration first
  (`providers/provider_manager.py:1218–1221`: returns early when
  `qwenpaw-local` has no `extra_models`, before touching the manager),
  so construction is waste here — but measured construction is
  **0.0 s** in-container (`LocalModelManager.get_instance()` in a
  fresh process). The module import is also ~free once `import
  qwenpaw` has run: `import qwenpaw.local_models.manager` measured
  2.139 s, but that is the `qwenpaw` package `__init__` chain
  (backup/agents/providers), paid regardless of the local-model
  import; the manager module itself adds microseconds (importtime
  self time 11 µs). And the import cannot be avoided at the app
  level anyway: `app/routers/__init__.py:9` imports the local-models
  router at package import, and that router does
  `from ...local_models import ...`. Moving the `_app.py` import
  inside a function would save nothing measurable and add diff
  noise, so nothing was changed. The local-model capability stays
  fully intact.

### Lazy provider SDK imports — left alone, blocker is structural

- `providers/provider_catalog.py` imports ~20 provider modules at
  module top (each importing its SDK: `openai`, `anthropic`, …) AND
  instantiates all 36 providers as live module-level objects
  (`PROVIDER_MODELSCOPE = ModelScopeProvider(...)`, …).
- `providers/provider_manager.py:35,45` imports the catalog;
  `_register_builtin_providers` (`:180–193`) iterates ALL 36 objects
  and calls `configuration_snapshot()` + deep-copies models into
  `builtin_providers`; `_apply_default_annotations` (`:1196–1204`)
  and `list_provider_info` (`:204–213`) iterate all values too.
- So a lazy catalog would need lazy provider proxies that support
  `configuration_snapshot()` / `get_info()` without importing their
  SDK — and startup registration would force-construct all 36
  proxies anyway. The saving would require lazy *registration*,
  which changes provider discovery/list semantics. That is a
  multi-file refactor with real regression risk to the active model
  path (mosicn/nex-n2.6), not a contained patch. All 36 providers
  stay listed and usable, exactly as before.
- Note for a future attempt: `import qwenpaw` is 2.3–3.1 s, but the
  single biggest import chain in this run was
  `qwenpaw.backup._utils.safe_swap` (2.21 s cumulative), not the
  provider SDKs — any future startup work should re-measure with
  `python3 -X importtime` before assuming providers are the cost.

### Lazy channels / voice — already lazy, nothing to do

- `app/channels/__init__.py` already lazy-loads `ChannelManager`
  via PEP 562 `__getattr__` (comment: "avoid pulling
  feishu/lark_oapi on CLI"); `app/channels/registry.py`
  `_BUILTIN_SPECS` lists only `console` and loads adapters via
  `importlib` on demand. No change needed; all 19 channel
  registrations are untouched.
- Voice/Whisper import sites were not traced in this window; no
  voice change was made and none is claimed.

### Session-state hash-pointer store — NOT implemented, no read-back path

- The problem is real (largest session state file 9.2 MB,
  re-serialized every turn; save path identified as
  `agents/react_agent.py` `_reply` `:1669` /
  `_defer_context_save` / `_flush_context_save` `:1662` and
  `app/chats/session.py` `save_session_state` `:278`), and the
  DeepSeek design (small manifest + append-only content store keyed
  by content hash + a read-result-by-hash tool) is sound — but there
  is NO read-back tool today, and building one (new agent tool,
  context-builder reference teaching, store + migration for the
  existing multi-MB sessions, byte-for-byte round-trip proof) is a
  separate multi-hour design, not a safe patch in this window.
  Trimming tool results without that retrieval path would lose data
  the agent can currently quote back, which the win-win rule
  forbids. Left alone; no session file, history row, or context
  content was changed.

### First-load JS code splitting — follow-up, not attempted

- The console ships only *built* assets in the image
  (`/app/src/qwenpaw/console/` holds `index.html` + `assets/`;
  `index.html` references a single module script
  `index-DZrIuh3B.js`, vendor chunks are loaded from it). No
  frontend source, no `package.json`, no `vite.config.*` exists
  anywhere under `/app/src` in the image, so a rebuild (dynamic
  `import()` for charts-vendor, splitting ui-vendor) cannot be done
  in-image. It needs the upstream console source + a vite build
  outside the container, then the rebuilt assets layered in. The
  approach is documented here as the follow-up; no half-measure
  (e.g. deleting or hand-editing built chunks) was attempted.

### Prompt-prefix caching — already live, nothing added

- Provider-side prefix caching is already working (parent verified
  live 2026-11-18 13:42:55: `cache_read_tokens 15488`,
  `cache_hit_rate 86%`, `session_cache_hit_rate 72.9%`). No
  client-side caching layer was added. NOT re-verified from a fresh
  log line in this session: the log has since been rotated (current
  `/data/home/qwenpaw/working/qwenpaw.log` is 18 KB, rotated
  ~13:49 IST) and contains no `cache_hit_rate` line yet, so the
  fresh-line check is still open for the parent's next live check.

## Leave-alone list (from the brief, all honoured)

- The 16 `-zh` skill variants (zero runtime cost; removal is pure
  capability loss).
- No trimming of tool results without a hash-backed read-back path.
- SQLite synchronous durability untouched; no `history.db` rows
  deleted or archived; no provider, channel, skill, or locale
  removed; `working.secret/auth.json` untouched; active model
  (mosicn/nex-n2.6) unchanged; Kilo kept.
