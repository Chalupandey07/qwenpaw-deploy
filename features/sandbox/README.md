# Real sandbox profile for generated code (gap #6, T139)

**Status: code complete, machine-free test T139 50/50, NOT verified
live.** The profile, the token API, the proxy, and the dispatcher
are built and tested here. NOTHING is deployed, no container has
ever run, and no job has ever been routed to a sandbox. Until the
deploy steps in §5 land and a live container run proves the
isolation, generated code still runs in the main container exactly
as before. This README says that instead of implying otherwise.

## Why this exists

Code Mode today has RLIMIT/timeouts/fixed-job only, and NO isolation
from the vault socket (172.18.0.1:8896). The agent's shell runs in
the main container, which owns `/app/working.secret/auth.json` and
can reach the vault broker. A generated script that reads a secret
or curls it out is one prompt injection away. The egress guard
(T123) is a check layer in the agent's own process — a hostile shell
can bypass it. This is the other half of that fix: the code runs
somewhere else, with no credential and no route to the things that
hold credentials.

## The trust boundary (read this before deploying)

The boundary is: **the sandbox container can reach exactly two
things by design — its own job workspace, and the egress proxy.
Everything else is refused, and a refusal is visible.**

Measured 2026-11-19: direct internet egress from the bridge is
OPEN (plain Docker bridge NAT — `api.github.com:443` reachable
from a throwaway container on the bridge). The proxy is the only
*intended* route out, not yet the only route. See "The internet,
directly" below and the follow-up in DONE vs REMAINING.

What the sandbox CAN reach:

| Reachable | How | Why it is safe enough |
|---|---|---|
| Its own job workspace (`/workspace`, read-write) | one bind mount, source under `/data/home/qwenpaw/working/workspaces/` | the job's own files; nothing else on the host is mounted |
| The egress proxy (`http://egress:8888` on the isolated bridge) | the only route out of the bridge | the proxy forwards only to hosts on the T123 allowlist |
| Its own tmpfs (`/tmp` 64m, `/run` 16m, `/dev/shm` 64m, `/run/sandbox-token` 1m, all `noexec,nosuid,nodev`) | tmpfs mounts | dies with the container; cannot hold an executable |
| The short-lived scoped token (file `/run/sandbox-token/token`, mode 0700) | tmpfs file, delivered per job | names only, 90 s default / 300 s max, single-use, exact item + host scope |

What the sandbox CANNOT reach (each enforced in code, tested in T139):

| Unreachable | Enforcement |
|---|---|
| `auth.json` / `working.secret` / provider keys | no mount outside the job workspace; the validator refuses `working.secret`, the whole `working` tree, and the machine home as mount sources |
| The vault broker (172.18.0.1:8896) and the MCP proxy (:8898) | two iptables rules deny sandbox-subnet → 172.18.0.1 (DOCKER-USER + INPUT), measured 2026-11-19: the DOCKER-USER rule alone does NOT block it — container→gateway is host-bound INPUT traffic, the broker stayed REACHABLE with only that rule; the INPUT rule is the enforcing one (both ports TimeoutError after it). Re-apply script: `/data/home/qwenpaw/sandbox/iptables-sandbox-gateway-deny.sh` (rules are lost on Docker restart/reboot). `extra_hosts` may not name the gateway; the proxy denies the gateway host too (T139 B9) |
| The host Docker daemon | no `docker.sock` mount (validator + argv render refuse it); no docker client in the image |
| The host network / host PID / host IPC / host devices | `--network` is the isolated bridge only; no `--privileged`, no `--cap-add` (caps dropped `ALL`), `no-new-privileges`, no `--pid=host` / `--ipc=host`, no `--device` |
| Any vault value, ever | the container holds no broker token and no key; the only credential-shaped thing it ever sees is a scoped token that carries NAMES, and the broker injects the value into the child env only |
| The internet, directly | **NOT enforced — measured 2026-11-19: a plain bridge NATs direct egress (`api.github.com:443` and `8.8.8.8:53` reachable from a container on the bridge). The proxy is the only *intended* route, not the only route. Follow-up, not yet applied (needs parent approval): pin the proxy to a fixed IP on the bridge and add an egress-default-deny DOCKER-USER rule for the rest of the subnet (RETURN for the proxy IP, DROP for the rest) — a blanket subnet DROP would also block the proxy's own outbound, so the pin comes first.** |
| China endpoints | the proxy uses the T123 guard, which denies China hosts BEFORE the allowlist — even if one were added to it |
| Any other job's workspace | one bind mount per container, per job; the container is `--rm` |

Residual holes that CANNOT be closed on this VM (DeepSeek design
review, 2026-11-18, deepseek-v4.1-flash-free — honest list, no
hand-waving):

1. **Shared kernel.** A container/runc/kernel escape reaches the
   host. There is no gVisor/KVM on the Free tier. The sandbox raises
   the bar from "read a file" to "exploit the kernel"; it does not
   remove the kernel from the trust boundary.
2. **The gateway is two iptables rules away.** `172.18.0.1` is
   reachable from ANY bridge unless the rules in §5 deny it —
   measured 2026-11-19: the DOCKER-USER rule alone does NOT block
   it (container→gateway is host-bound INPUT traffic); the INPUT
   rule is the enforcing one. Both rules are lost on Docker
   restart/reboot (no iptables-persistent on the box); re-apply with
   `/data/home/qwenpaw/sandbox/iptables-sandbox-gateway-deny.sh`.
   If either rule is missing, the token gate is bypassed entirely.
   A missing rule is the single most dangerous misconfiguration in
   this feature.
3. **TLS through the proxy is opaque.** CONNECT is allowed only to
   allowlisted hosts, but the proxy cannot see the path or body
   inside TLS. An allowlisted host that turns hostile can still
   receive whatever the sandbox sends it. The allowlist is the
   control; there is no content inspection.
4. **DNS is not pinned.** The host is checked before resolution; a
   rebinding answer after the check is not caught. DNS exfiltration
   needs no HTTP at all — measured 2026-11-19: `8.8.8.8:53` is
   directly reachable from the bridge (plain NAT), so a job can
   resolve anything without the proxy. The bridge DNS must be the
   proxy host itself (no upstream resolver reachable from the
   sandbox) — a compose/deploy setting, NOT verified until a live
   run proves it. The proposed egress-default-deny rule (see "The
   internet, directly" above) would close the direct-DNS path too.
5. **Token replay inside the TTL.** The consumed-`jti` store is
   in-memory and dies with the broker; a leaked token stays live
   until its `exp` (at most 300 s). Real revocation is key rotation
   or a broker restart. The TTL is short because of this, not in
   spite of it.
6. **Side channels.** Cache/timing, memory pressure, CPU
   contention, `/proc`/cgroup host-info leakage. Unfixable on this VM.
7. **Symlink escape in the workspace.** A job workspace containing
   a symlink to `/app/working.secret` would be followed by the bind
   mount. The profile validator checks the mount SOURCE, not the
   workspace contents. Closed in the runner: `resolve_job_workspace`
   (`realpath`, refuse if the resolved path escapes the workspace
   root) — wired 2026-11-19 and machine-free tested (T94 218/218);
   a live symlink probe (a symlinked workspace presented to
   `POST /api/run`) has NOT been run.
8. **Supply chain.** The sandbox and proxy images are trust anchors:
   a compromised base image owns every job. Pin the digest at deploy
   time; do not rebuild from `latest` silently.

## What is where

```
features/sandbox/
  sandbox.py             the profile: build + validate + render (docker run / compose)
  vault_tokens.py        the broker token API: mint / verify (HMAC, short-lived, scoped)
  dispatch.py            job-runner dispatch: sandbox / refuse / (one legacy main)
  egress_proxy.py        the egress proxy: allowlist gate for the sandbox bridge
  proxy-allowlist.txt    GENERATED snapshot of the T123 allowlist (do not edit by hand)
  test_sandbox.py        machine-free test T139 (50 checks, fail-first)
  profile/Dockerfile     the sandbox image (python:3.12-slim, uid 10001, no tools)
  profile/docker-compose.sandbox.yml   sandbox + proxy on the isolated bridge
  README.md              this file
```

## 1. The profile (sandbox.py)

`build_profile(job)` returns a plain dict (image, user, network,
mounts, limits, deadline). `validate_profile(profile)` returns the
list of violations (empty = ok); `docker_run_argv` and
`compose_service` REFUSE to render a profile that does not validate
clean — a leaky profile must never become a command line by accident.

Numbers (Free VM: 4 vCPU / 8 GiB, shared with the main container +
the desktop):

| Cap | Value | Why |
|---|---|---|
| memory / swap | 1g / 1g | swap == memory: no swap, OOM-kill instead. DeepSeek proposed 2g; NOT adopted — the main container + desktop already use most of 8 GiB. A job needing more is refused, not given the box's RAM. |
| cpus | 1.0 | leaves ~3 cores for main + desktop |
| pids | 128 | a fork bomb dies at 128 processes |
| tmpfs | /tmp 64m, /run 16m, /dev/shm 64m | all `noexec,nosuid,nodev` |
| ulimits | nofile 1024, nproc 256, core 0 | no core dumps (they can hold secrets) |
| deadline | 120 s default, 300 s hard max | dispatch refuses anything above 300 |
| stop timeout | 5 s | a job that ignores SIGTERM is killed, not waited on |
| logs | json-file, 10m x 2 | a chatty job cannot fill the disk |
| user | 10001:10001 | non-root, baked into the image |

## 2. The token API (vault_tokens.py)

Format: `v1.<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`.
Key: 32 random bytes, hex, from `SANDBOX_BROKER_KEY` (never logged,
never committed, never sent to the sandbox). `kid` (first 8 hex of
SHA-256(key)) selects the key for rotation; two keys may be active.

Payload: `v`, `kid`, `jti` (16 random bytes), `sub` (job id),
`aud` (`sandbox-inject`), `items` (exact vault item names), `hosts`
(exact FQDNs), `ops` (`["inject-env"]` only), `iat`, `nbf`, `exp`,
`single_use` (true). TTL: 90 s default, 300 s absolute max; 5 s
clock-skew tolerance. Scope is exact-match, no wildcards, no prefix:
a token for `api.github.com` does not open `evil.github.com`, and a
token for `github-api` does not open `github-api-2`.

`verify_token` refuses: bad format, unknown key id, bad signature,
wrong audience, wrong ops, expired, not yet valid, wrong job, item
or host outside the scope, and a `jti` already consumed (replay).
`TokenStore` holds consumed ids in memory and sweeps them after
expiry; it dies with the broker (see residual hole 5 above).

The broker endpoint this token is FOR (`POST /sandbox/inject`) does
not exist yet: it is the broker-side half of this design (see
REMAINING). What exists here is the mint/verify half plus the CLI
(`vault_tokens.py mint <job> <items> <hosts> [ttl]` /
`verify <token> [item] [host]`, key from env only).

## 3. The egress proxy (egress_proxy.py + proxy-allowlist.txt)

A stdlib-only forward proxy (GET/POST forwarded, CONNECT tunnelled
only to allowlisted hosts, every other method refused, 30 s timeout,
1 MB cap). The allowlist is the T123 one and ONLY that:
`proxy-allowlist.txt` is a GENERATED snapshot of
`egress_guard.DEFAULT_ALLOWLIST` + `allowlist.txt`, and T139 asserts
exact equality, so drift fails the test instead of silently opening
(or closing) a host. Regenerate with:

```bash
python3 - <<'EOF'
import importlib.util
spec = importlib.util.spec_from_file_location("egress_guard", "features/egress-guard/egress_guard.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
hosts = sorted(m.load_allowlist())
with open("features/sandbox/proxy-allowlist.txt", "w") as fh:
    for h in hosts:
        fh.write(h + "\n")
EOF
```

(Keep the header comment in the file when regenerating.) When
`egress_guard.py` is available the proxy delegates to its
`check_request` — same code, same rules, including the China deny
and the private-IP deny. When it is not available (proxy container
without the mount), the proxy falls back to the snapshot file + a
mirror of the same China/private checks; the test covers the repo
path, and the fallback is documented in the module, not hidden.

## 4. Dispatch (dispatch.py)

`route_job(job)` returns `{"target", "reason", ...}`. The rule is:
generated code runs ONLY in the sandbox; anything that cannot run
there is REFUSED, never silently fallen back to main. A silent
fallback would recreate exactly the hole the sandbox exists to
close.

* `generated-code` / `code` + workspace under the root + deadline
  1..300 + every host on the T123 allowlist + every vault item
  inside the token scope → `sandbox`.
* `codemode-fixed-job` → `main`. The ONE legacy exception: the B-41
  fixed pilot job drives the real desktop through the MCP proxy
  (X11, no generated code, no vault item, no network beyond the
  proxy). It cannot run in the sandbox and it is not generated code.
  The exception is by exact job id, not by a caller-set flag.
* Desktop tools (`list_apps`, `get_app_state`, `click`, `type_text`,
  `press_key`, `scroll`, `set_value`, `drag`,
  `perform_secondary_action`) or `needs_desktop` → `refuse`
  ("needs-desktop"). The sandbox has no X11 socket and no route to
  the MCP proxy.
* Non-allowlisted host → `refuse` ("egress-denied"). Vault item
  outside the token scope → `refuse` ("vault-scope"). Deadline over
  300, workspace outside the root, unknown kind → `refuse` with the
  reason named.

## 5. Deploy (machine side, done 2026-11-19 except the image)

Deployed 2026-11-19 (T139 deploy pass). The deploy order was:

1. ~~Build the image on the machine~~ — NOT built. The machine is
   at the 5-image cap and a T132 build is in flight; the parent
   builds it: `docker build -t qwenpaw-sandbox:2.3.0 -f features/sandbox/profile/Dockerfile features/sandbox/profile/`
   from `/data/home/qwenpaw/sandbox/profile/` (delete an old image
   first; pin the digest; record it).
2. Provision `SANDBOX_BROKER_KEY` (32 random bytes, hex) into
   `/data/home/qwenpaw/.env` (mode 600) for the broker. Never print
   it, never commit it. This is the ONE new secret this feature adds.
   Done 2026-11-19: generated on the machine, 1 line, 64 hex chars,
   verified by count/length only.
3. Create the bridge + the gateway rules FIRST, before any sandbox
   runs: `docker network create --subnet 172.19.0.0/16 --gateway
   172.19.0.1 qwenpaw-sandbox-net`, then TWO iptables rules denying
   `qwenpaw-sandbox-net` → `172.18.0.1` (broker :8896, MCP :8898):
   DOCKER-USER `-s 172.19.0.0/16 -d 172.18.0.1 -j DROP` AND INPUT
   `-s 172.19.0.0/16 -d 172.18.0.1 -j DROP`. Measured: the
   DOCKER-USER rule alone does NOT block the gateway (broker stayed
   REACHABLE); with the INPUT rule both ports are unreachable
   (TimeoutError), while the main container still reaches the
   broker. Re-apply after reboot/Docker restart:
   `sudo /data/home/qwenpaw/sandbox/iptables-sandbox-gateway-deny.sh`.
4. Resolve symlinks in the job workspace before mounting
   (`realpath`; refuse the job if the resolved path escapes the
   workspace root). Done in the runner (`resolve_job_workspace`),
   machine-free tested; a live symlink probe has not been run.
5. Sync `features/sandbox/egress_proxy.py`,
   `features/egress-guard/egress_guard.py`, and `proxy-allowlist.txt`
   to the machine; start the proxy from
   `profile/docker-compose.sandbox.yml`. Done 2026-11-19: files
   synced to `/data/home/qwenpaw/sandbox/` (+ `profile/`) and
   `/data/home/qwenpaw/egress-guard/`; the proxy runs as container
   `qwenpaw-sandbox-egress` on the bridge (172.19.0.2, started with
   the existing `agentscope/qwenpaw:v2.3.0` image via the
   compose-equivalent `docker run` — no image build — because the
   sandbox image does not exist yet). Live: allowlisted host via
   the proxy → 200; non-allowlisted → 403 `not_allowlisted`; China
   host → 403 `china_host`; private IP → 403 `private_ip`; CONNECT
   to an allowlisted host opens the tunnel, to a non-allowlisted
   host fails 403.
6. Implement the broker-side `POST /sandbox/inject` endpoint: verify
   the token (`vault_tokens.verify_token`, single-use store), fetch
   the named value from the Worker (`/vault/export`), inject it into
   the child env, scrub the output — the same pattern as the
   broker's existing `/run`, but token-gated instead of broker-token
   gated. Done 2026-11-19: endpoint live on the broker (service
   restarted); bad/missing token refused (401/400), GET → 405, and
   a valid token is verified live (502 `upstream_error` from the
   down Worker, not 401) and consumed (replay → 401 "token already
   used"). The value-in-env + scrub half is NOT yet proven live:
   the Worker is down with Cloudflare error 1027 until the daily
   limit resets 00:00 UTC (05:30 IST 2026-11-19). Re-run after the
   reset: `python3 /data/home/qwenpaw/vault/t139-proof-inject.py`
   (reads the key from `.env`, prints only statuses).
7. Wire dispatch into the job runner: Code Mode jobs call
   `route_job`; a `sandbox` decision builds the profile, validates
   it, mints the token, writes it to the tmpfs file, and runs
   `docker run` from `docker_run_argv`. A `refuse` decision surfaces
   the reason to the user. Done 2026-11-19: runner + modules synced
   to `/data/home/qwenpaw/codemode/`, service restarted, selftest
   218/218 in the machine layout, `/health` reports
   `"sandbox": "available"`; live over the socket: a desktop-tool
   job → 200 refused with the reason surfaced, a sandbox-branch job
   → 200 refused at the missing-script check with
   `route.target == "sandbox"`, no token → 401.
8. Live proof (done as far as possible WITHOUT the sandbox image):
   gateway-unreachable probe ✓ (step 3), proxy allow/deny from
   inside a bridge container ✓ (step 5), workspace write-back ✓
   (a throwaway container writes `probe.txt` into the job workspace
   and it lands on the host — as root; as uid 10001 it FAILS on a
   root-owned job dir, see REMAINING). Still to run, with the real
   image: a container on the bridge tries to
   `cat /app/working.secret/auth.json` (must fail: no such mount),
   and a real runner job end-to-end (token mint → container run →
   file written into `/workspace` → token dir removed). Record the
   run; until then this feature is code + partial live proof, not
   full protection.

## 6. The test (T139)

```bash
python3 features/sandbox/test_sandbox.py            # 50 checks
python3 features/sandbox/test_sandbox.py --impl none  # fail-first: 7 passed, 43 failed
```

Fail-first: `--impl none` runs the same assertions against the
pre-sandbox behaviour (main-container mounts, host network,
unsigned never-expiring tokens, allow-everything proxy,
route-everything-to-main) and fails 43/50. With the real code it
passes 50/50. The test covers: (a) profile mounts/network/limits/
lifetime/env/token-file + the validator naming each hole in a
hand-built leaky profile + rendering refusing it; (b) the proxy
allowlist equalling T123 exactly + deny/allow over real HTTP on
localhost (deny paths only — no upstream fetch); (c) token
mint/verify, expiry, wrong scope, tamper, wrong key, TTL cap,
single-use replay; (d) dispatch routing + every refusal + the one
legacy exception. All fixtures are FAKE, built by concatenation so
no literal secret-shaped string or China endpoint host appears in
the test file.

## DONE vs REMAINING (honest)

DONE in this pass (code + machine-free test, committed):

* Sandbox profile builder + validator + `docker run` / compose
  rendering (workspace-only mount, isolated bridge, caps, lifetime).
* Vault-broker token API: mint/verify, exact scope, expiry,
  single-use `jti`, fail-closed key loading, CLI.
* Egress proxy enforcing the T123 allowlist (no new allowlist) +
  the generated snapshot file with an exact-equality test.
* Dispatcher routing generated-code jobs to the sandbox and
  refusing everything that cannot run there (never falling back).
* Dockerfile + compose file for the sandbox + proxy.
* T139, 50/50, fail-first proven (7 passed / 43 failed on the stub).

DONE on the machine 2026-11-19 (T139 deploy pass, live evidence in
§5; commits in the deploy-pass push):

* Broker `POST /sandbox/inject` deployed + restarted: refusals
  live (401/400/405), valid-token verification + single-use
  consumption live (502 upstream, replay 401). The value-in-env +
  scrub half awaits the Cloudflare 1027 reset (05:30 IST).
* Bridge `qwenpaw-sandbox-net` (172.19.0.0/16) + BOTH gateway rules
  (DOCKER-USER + INPUT) live; gateway unreachable from the bridge,
  main container unaffected; re-apply script on the machine.
* Runner wiring live: `/health` sandbox available, refuse +
  sandbox-branch routing proven over the socket, selftest 218/218
  in the machine layout.
* Egress proxy live on the bridge (172.19.0.2): allow → 200, deny →
  403 (`not_allowlisted` / `china_host` / `private_ip`), CONNECT
  allow/deny as designed.
* Workspace write-back live: a container writes into the job
  workspace and it lands on the host.

REMAINING (not done, not faked):

* **The sandbox image itself** (`qwenpaw-sandbox:2.3.0`) — NOT
  built. 5-image cap, a T132 build is in flight; the parent builds
  it (`docker build -t qwenpaw-sandbox:2.3.0 -f
  features/sandbox/profile/Dockerfile features/sandbox/profile/`
  from `/data/home/qwenpaw/sandbox/profile/`, delete an old image
  first, pin the digest). Until then no real sandbox container has
  run: the `auth.json` no-mount probe and the end-to-end runner job
  (token mint → container run → file in `/workspace` → token dir
  removed) remain.
* **Broker inject value-in-env + scrub live proof** — blocked by
  the Cloudflare 1027 outage until 05:30 IST 2026-11-19. Re-run
  `python3 /data/home/qwenpaw/vault/t139-proof-inject.py` after the
  reset (expects: child env names include the item var, no broker
  token / sandbox key in env, `printenv` → `[redacted]`).
* **Direct internet egress from the bridge is OPEN (measured).**
  The proxy is the intended route, not the only route. Follow-up
  (needs parent approval, NOT applied): pin the proxy to a fixed IP
  on the bridge and add an egress-default-deny DOCKER-USER rule for
  the rest of the subnet. A blanket subnet DROP would also block the
  proxy's own outbound, so the pin comes first.
* **Workspace ownership for uid 10001.** A real sandbox job runs as
  uid 10001, but job workspaces are root-owned 0755 (created by the
  agent), so a job cannot write its own workspace — measured:
  write-back as 10001 fails `Permission denied` on a root-owned
  dir, succeeds after `chown 10001:10001`. The runner must chown or
  chmod the job workspace before the run (design decision, not yet
  made — recursive chown of a user workspace tree is a bigger
  change than a one-line fix).
* **Live symlink probe** — the runner resolves symlinks
  (`realpath`, refuse on escape) and it is machine-free tested, but
  a symlinked workspace has not been presented to `POST /api/run`.
* **Bridge DNS setting** (residual hole 4) — direct DNS
  (`8.8.8.8:53`) is reachable from the bridge; the egress-default-
  deny follow-up would close it.
* **No gVisor / seccomp profile / AppArmor profile.** The profile
  drops ALL caps and sets `no-new-privileges`; a seccomp default
  profile is a follow-up hardening step, not in this pass.
* **The 1 GiB memory cap is a sizing choice, not a measurement.**
  If real jobs OOM at 1 GiB, the fix is a per-job memory request
  with a hard ceiling — not a silent raise of the default.

## Deliberately not done

* No new allowlist. The proxy reuses T123's; the snapshot file is
  generated from it and tested for exact equality.
* No `docker.sock`, no DinD, no privileged mode, no host network —
  not as options, not as flags. There is no supported way to ask
  for them.
* No token with a TTL above 300 s, no wildcard scope, no
  prefix-match scope. A job that needs a broader scope gets a
  refusal and a reason, not a broader token.
* No second vault, no key storage in the sandbox image, no secret
  in env vars. The sandbox image contains no credential of any kind.
* DeepSeek's 2 GiB memory suggestion was NOT adopted (see §1):
  the Free VM cannot afford it alongside the main container +
  desktop.
* The fixed codemode pilot job stays on main (exact job id). It is
  not generated code and it needs the desktop; moving it to the
  sandbox would break it, not secure it.
