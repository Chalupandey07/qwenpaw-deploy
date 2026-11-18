#!/usr/bin/env python3
"""Sandbox profile for generated code (gap #6, T139).

Code Mode today runs the agent's shell in the MAIN QwenPaw container,
which owns ``/app/working.secret/auth.json`` and can reach the vault
broker at the Docker bridge gateway (172.18.0.1:8896). Its only bounds
are RLIMIT/timeouts and a fixed job. This module is the profile for a
SEPARATE container that executes generated code instead:

* one mount only: the job's own workspace directory, at ``/workspace``
* network: an isolated bridge (``qwenpaw-sandbox-net``) whose only route
  out is the egress proxy, which enforces the T123 allowlist
* no docker.sock, no privileged, no added capabilities, no host PID/IPC,
  no host network, read-only rootfs, non-root user, no-new-privileges
* resource caps sized for the Free VM (4 vCPU / 8 GiB shared with the
  main container + the desktop) and a lifetime cap (120 s default,
  300 s hard max)
* no credential in the container: the vault mints a short-lived scoped
  token (see ``vault_tokens.py``) delivered on a tmpfs file, never an
  env var and never the broker token

This module builds the profile and VALIDATES it. Validation is the
point: ``validate_profile`` rejects any profile that mounts a secret
path, uses the host network, adds a capability, or drops a limit, and
it names the violation. The dispatcher (``dispatch.py``) refuses to
run a job whose profile does not validate clean.

Stdlib only. Loads standalone via importlib, so the machine-free
harness can exercise it without the qwenpaw package.

Sizing note (DeepSeek design review, 2026-11-18, deepseek-v4.1-flash-free):
DeepSeek proposed ``--memory=2g``. That was NOT adopted: the Free VM
has 8 GiB total and the main container + the desktop already use most
of it. 1 GiB memory / 1 CPU keeps the sandbox from starving the agent
that supervises it; a generated-code job that needs more than 1 GiB
is refused with a reason instead of OOMing the box. The 2 GiB figure
is recorded here so the choice is a decision, not an oversight.
"""

from __future__ import annotations

import os

__all__ = [
    "SANDBOX_IMAGE",
    "SANDBOX_NETWORK",
    "SANDBOX_USER",
    "WORKSPACE_MOUNT_TARGET",
    "WORKSPACE_ROOT",
    "TOKEN_DIR_ROOT",
    "MEMORY_LIMIT",
    "MEMORY_SWAP_LIMIT",
    "CPU_LIMIT",
    "PIDS_LIMIT",
    "JOB_DEADLINE_S",
    "JOB_DEADLINE_MAX_S",
    "STOP_TIMEOUT_S",
    "FORBIDDEN_MOUNT_PREFIXES",
    "FORBIDDEN_FLAGS",
    "build_profile",
    "validate_profile",
    "docker_run_argv",
    "compose_service",
]

# ---------------------------------------------------------------------------
# Constants: the profile. Change these only with a README note saying why.
# ---------------------------------------------------------------------------
SANDBOX_IMAGE = "qwenpaw-sandbox:2.3.0"
SANDBOX_NETWORK = "qwenpaw-sandbox-net"
SANDBOX_USER = "10001:10001"  # non-root uid:gid baked into the image
WORKSPACE_MOUNT_TARGET = "/workspace"

# Host path prefix a job workspace may live under. Anything outside
# this prefix is never mounted, even if the job asks for it.
WORKSPACE_ROOT = "/data/home/qwenpaw/working/workspaces"

# Host path prefix a per-job token directory may live under. The
# runner mints the scoped token and writes it to
# <TOKEN_DIR_ROOT>/<job_id>/token (dir 0700, file 0600) on the host's
# /run tmpfs, then bind-mounts that directory at /run/sandbox-token
# inside the container (see build_profile's `token_dir`). A token
# directory anywhere else is never mounted: the validator refuses it,
# so a job cannot smuggle an arbitrary host directory into the
# container through the token mount. When no token_dir is given, the
# profile keeps the empty tmpfs mount at /run/sandbox-token instead.
TOKEN_DIR_ROOT = "/run/sandbox-tokens"

# Resource caps (Free VM: 4 vCPU / 8 GiB, shared with main + desktop).
MEMORY_LIMIT = "1g"
MEMORY_SWAP_LIMIT = "1g"  # swap == memory: no swap, OOM-kill instead
CPU_LIMIT = "1.0"
PIDS_LIMIT = 128
JOB_DEADLINE_S = 120       # default lifetime cap per job
JOB_DEADLINE_MAX_S = 300   # hard max; dispatch refuses anything above
STOP_TIMEOUT_S = 5

# Mount sources that must NEVER appear in a sandbox profile. The first
# entry is the vault socket's network, not a path: the sandbox must
# never be given a route to the bridge gateway that owns the broker
# (172.18.0.1:8896) or the MCP proxy (:8898). That is enforced by the
# isolated network (no route to the gateway), and checked here as a
# belt-and-braces rule on extra_hosts / add-host entries.
FORBIDDEN_MOUNT_PREFIXES = (
    "/data/home/qwenpaw/working.secret",  # auth.json + provider keys
    "/data/home/qwenpaw/working.backups",  # backups hold history-adjacent data
    "/data/home/qwenpaw/working",          # the whole working tree, not just secrets
    "/data/home/qwenpaw",                  # the whole machine home
    "/var/run/docker.sock",                # docker.sock: escape to the host
    "/run/docker.sock",
    "/etc",                                # host config
    "/",
)

FORBIDDEN_FLAGS = (
    "--privileged",
    "--cap-add",
    "--device",
    "--pid=host",
    "--ipc=host",
    "--net=host",
    "--network=host",
    "--uts=host",
    "--cgroupns=host",
)

# Env var names that must never be set inside the sandbox. The broker
# token is the high-value credential: it can make the Worker dispense
# ANY vault value. The sandbox gets a short-lived scoped token on a
# tmpfs file instead (see vault_tokens.py); it never gets this.
FORBIDDEN_ENV_NAMES = (
    "VAULT_BROKER_TOKEN",
    "VAULT_MASTER_SECRET",
    "QWENPAW_AUTH_PASSWORD",
)


def _is_forbidden_mount(source: str, workspace_root: str = WORKSPACE_ROOT,
                        token_root: str = TOKEN_DIR_ROOT) -> str | None:
    """Return the forbidden prefix a mount source falls under, or None.

    The job's own workspace (under ``workspace_root``, default
    WORKSPACE_ROOT) is the ONE allowed exception to the
    ``/data/home/qwenpaw/working`` prefix: the workspace root is the
    mount the profile exists to provide. Every other path under the
    working tree — the tree itself, its secrets, its backups — stays
    forbidden. The per-job token directory (under ``token_root``,
    default TOKEN_DIR_ROOT) is the second allowed exception, for the
    same reason: it is the mount the token delivery exists to provide,
    and the validator pins its source to that root separately.
    """
    src = os.path.normpath(source)
    if src.startswith(workspace_root.rstrip("/") + "/"):
        return None
    if src.startswith(token_root.rstrip("/") + "/"):
        return None
    for prefix in FORBIDDEN_MOUNT_PREFIXES:
        if src == prefix or src.startswith(prefix.rstrip("/") + "/"):
            return prefix
    return None


def build_profile(job: dict) -> dict:
    """Build the sandbox profile for one job.

    ``job`` keys: ``job_id`` (str), ``workspace`` (host path of the
    job's own workspace dir, under WORKSPACE_ROOT), ``deadline_s``
    (optional, default JOB_DEADLINE_S), ``token_file`` (optional host
    path of the tmpfs token file; default ``/run/sandbox-token/token``),
    ``token_dir`` (optional host path of the per-job token directory,
    under TOKEN_DIR_ROOT; when given, the /run/sandbox-token mount is
    a bind of that directory instead of an empty tmpfs — that is how
    the minted token file reaches the container, since a tmpfs mount
    cannot be pre-filled. The directory lives on the host's /run
    tmpfs and the runner removes it when the job ends).

    Returns a plain dict describing the container: image, user,
    network, mounts, env (empty by design), resource limits, security
    options, deadline. The dict is what ``validate_profile`` checks
    and what ``docker_run_argv`` / ``compose_service`` render. It is
    deliberately NOT a docker command yet: rendering is separate from
    the decision, so the test can inspect the decision without a
    Docker daemon.
    """
    job_id = str(job.get("job_id") or "").strip()
    workspace = str(job.get("workspace") or "").strip()
    try:
        deadline = int(job.get("deadline_s", JOB_DEADLINE_S))
    except (TypeError, ValueError):
        deadline = JOB_DEADLINE_S
    token_file = str(
        job.get("token_file") or "/run/sandbox-token/token"
    ).strip()
    token_dir = str(job.get("token_dir") or "").strip()
    token_mounts = (
        [{
            "type": "bind",
            "source": token_dir,
            "target": "/run/sandbox-token",
            "read_only": False,
        }]
        if token_dir
        else [{
            "type": "tmpfs",
            "source": "tmpfs",
            "target": "/run/sandbox-token",
            "read_only": False,
            "tmpfs_size": "1m",
            "tmpfs_mode": "0700",
        }]
    )
    return {
        "job_id": job_id,
        "image": SANDBOX_IMAGE,
        "user": SANDBOX_USER,
        "network": SANDBOX_NETWORK,
        "hostname": f"sandbox-{job_id}" if job_id else "sandbox",
        "mounts": [
            {
                "type": "bind",
                "source": workspace,
                "target": WORKSPACE_MOUNT_TARGET,
                "read_only": False,
            },
        ] + token_mounts,
        "token_file": token_file,
        "env": {},  # empty by design: no credential ever rides in env
        "extra_hosts": [],  # empty by design: no route to the gateway
        "read_only_rootfs": True,
        "tmpfs": {
            "/tmp": "64m,noexec,nosuid,nodev",
            "/run": "16m,noexec,nosuid,nodev",
            "/dev/shm": "64m,noexec,nosuid,nodev",
        },
        "cap_drop": ["ALL"],
        "cap_add": [],
        "privileged": False,
        "security_opt": ["no-new-privileges"],
        "pid_mode": "",
        "ipc_mode": "",
        "devices": [],
        "memory": MEMORY_LIMIT,
        "memory_swap": MEMORY_SWAP_LIMIT,
        "cpus": CPU_LIMIT,
        "pids_limit": PIDS_LIMIT,
        "ulimits": {"nofile": "1024:1024", "nproc": "256", "core": "0"},
        "deadline_s": deadline,
        "stop_timeout_s": STOP_TIMEOUT_S,
        "log_max_size": "10m",
        "log_max_file": "2",
    }


def validate_profile(profile: dict, workspace_root: str = WORKSPACE_ROOT,
                     token_root: str = TOKEN_DIR_ROOT) -> list[str]:
    """Validate a sandbox profile. Returns a list of violations (empty = ok).

    Every rule names what is wrong so a refusal can say why. A profile
    with ANY violation must not be run; ``dispatch.py`` enforces that.
    ``workspace_root`` is the host prefix the workspace bind must live
    under and ``token_root`` the host prefix the token-dir bind must
    live under (defaults the machine paths; the runner's selftest
    passes temp roots so the profile is testable without the machine).
    """
    violations: list[str] = []
    job_id = profile.get("job_id") or "<unknown>"

    if not job_id or job_id == "<unknown>":
        violations.append("job_id: missing")
    if profile.get("image") != SANDBOX_IMAGE:
        violations.append(f"image: must be {SANDBOX_IMAGE}")
    if profile.get("user") in (None, "", "0", "0:0", "root"):
        violations.append("user: must be non-root (10001:10001)")

    # Network: exactly the isolated bridge, nothing else.
    network = profile.get("network")
    if network != SANDBOX_NETWORK:
        violations.append(f"network: must be {SANDBOX_NETWORK}, got {network!r}")
    for host in profile.get("extra_hosts") or []:
        if "172.18.0.1" in str(host) or "gateway" in str(host).lower():
            violations.append(f"extra_hosts: route to the bridge gateway forbidden: {host!r}")

    # Mounts: exactly one workspace bind, plus at most one token bind
    # (a per-job token directory under TOKEN_DIR_ROOT, mounted at
    # /run/sandbox-token) OR the empty token tmpfs — never both, never
    # anything else. The token bind is the ONE exception to "one bind
    # mount": it carries only the minted token file, and its source is
    # pinned to the token root, so it cannot smuggle in another host
    # directory.
    mounts = profile.get("mounts") or []
    binds = [m for m in mounts if m.get("type") == "bind"]
    ws_binds = [m for m in binds if m.get("target") == WORKSPACE_MOUNT_TARGET]
    token_binds = [m for m in binds if m.get("target") == "/run/sandbox-token"]
    other_binds = [m for m in binds
                   if m.get("target") not in (WORKSPACE_MOUNT_TARGET, "/run/sandbox-token")]
    if len(ws_binds) != 1:
        violations.append(
            f"mounts: exactly one workspace bind mount required, got {len(ws_binds)}")
    if len(token_binds) > 1:
        violations.append(
            f"mounts: at most one token bind mount allowed, got {len(token_binds)}")
    if other_binds:
        violations.append(
            f"mounts: unexpected bind mount target(s): "
            f"{[m.get('target') for m in other_binds]!r}")
    for m in ws_binds:
        source = str(m.get("source") or "")
        if not source.startswith(workspace_root.rstrip("/") + "/"):
            violations.append(
                f"mount source: must be under {workspace_root}, got {source!r}"
            )
        forbidden = _is_forbidden_mount(source, workspace_root, token_root)
        if forbidden is not None:
            violations.append(f"mount source: forbidden prefix {forbidden}: {source!r}")
    for m in token_binds:
        source = str(m.get("source") or "")
        if not source.startswith(token_root.rstrip("/") + "/"):
            violations.append(
                f"mount source: token dir must be under {token_root}, got {source!r}"
            )
        forbidden = _is_forbidden_mount(source, workspace_root, token_root)
        if forbidden is not None:
            violations.append(f"mount source: forbidden prefix {forbidden}: {source!r}")
    token_tmpfs = [m for m in mounts
                   if m.get("type") == "tmpfs" and m.get("target") == "/run/sandbox-token"]
    if token_binds and token_tmpfs:
        violations.append(
            "mounts: token bind and token tmpfs are mutually exclusive")
    if not token_binds and not token_tmpfs:
        violations.append("mounts: missing token mount at /run/sandbox-token")
    for m in mounts:
        src = str(m.get("source") or "")
        if "docker.sock" in src:
            violations.append(f"mount source: docker.sock forbidden: {src!r}")
        if str(m.get("target") or "") in ("/app/working.secret", "/app/working"):
            violations.append(f"mount target: host working tree forbidden: {m.get('target')!r}")

    # Privilege: nothing that escapes the container.
    if profile.get("privileged"):
        violations.append("privileged: must be false")
    if profile.get("cap_add"):
        violations.append(f"cap_add: must be empty, got {profile.get('cap_add')!r}")
    if "ALL" not in (profile.get("cap_drop") or []):
        violations.append("cap_drop: must include ALL")
    if "no-new-privileges" not in (profile.get("security_opt") or []):
        violations.append("security_opt: must include no-new-privileges")
    if profile.get("pid_mode") in ("host",):
        violations.append("pid_mode: host forbidden")
    if profile.get("ipc_mode") in ("host",):
        violations.append("ipc_mode: host forbidden")
    if profile.get("devices"):
        violations.append(f"devices: must be empty, got {profile.get('devices')!r}")
    if not profile.get("read_only_rootfs"):
        violations.append("read_only_rootfs: must be true")

    # Resources: caps must be present and within the Free-VM budget.
    if profile.get("memory") != MEMORY_LIMIT:
        violations.append(f"memory: must be {MEMORY_LIMIT}, got {profile.get('memory')!r}")
    if profile.get("memory_swap") != MEMORY_SWAP_LIMIT:
        violations.append(
            f"memory_swap: must be {MEMORY_SWAP_LIMIT}, got {profile.get('memory_swap')!r}"
        )
    if profile.get("cpus") != CPU_LIMIT:
        violations.append(f"cpus: must be {CPU_LIMIT}, got {profile.get('cpus')!r}")
    if profile.get("pids_limit") != PIDS_LIMIT:
        violations.append(f"pids_limit: must be {PIDS_LIMIT}, got {profile.get('pids_limit')!r}")

    # Lifetime: a deadline must exist and be within the hard max.
    deadline = profile.get("deadline_s")
    if not isinstance(deadline, int) or deadline <= 0:
        violations.append(f"deadline_s: must be a positive int, got {deadline!r}")
    elif deadline > JOB_DEADLINE_MAX_S:
        violations.append(
            f"deadline_s: {deadline} exceeds hard max {JOB_DEADLINE_MAX_S}"
        )
    if profile.get("stop_timeout_s") != STOP_TIMEOUT_S:
        violations.append(
            f"stop_timeout_s: must be {STOP_TIMEOUT_S}, got {profile.get('stop_timeout_s')!r}"
        )

    # Env: no credential-named variable, ever.
    for name in (profile.get("env") or {}):
        if name in FORBIDDEN_ENV_NAMES:
            violations.append(f"env: forbidden variable {name}")
        if "TOKEN" in name.upper() and name != "SANDBOX_JOB_TOKEN_FILE":
            violations.append(f"env: credential-shaped variable {name} (use the tmpfs token file)")

    # Token file: must live on the tmpfs mount, never in the workspace.
    token_file = str(profile.get("token_file") or "")
    if token_file and not token_file.startswith("/run/sandbox-token/"):
        violations.append(
            f"token_file: must be under /run/sandbox-token/, got {token_file!r}"
        )
    return violations


def docker_run_argv(profile: dict, workspace_root: str = WORKSPACE_ROOT,
                    token_root: str = TOKEN_DIR_ROOT) -> list[str]:
    """Render a validated profile as a ``docker run`` argv list.

    Raises ValueError if the profile does not validate clean. Rendering
    is refused for an invalid profile: a leaky profile must never
    become a command line by accident.
    """
    violations = validate_profile(profile, workspace_root, token_root)
    if violations:
        raise ValueError("invalid sandbox profile: " + "; ".join(violations))
    argv: list[str] = [
        "docker", "run", "--rm",
        "--name", f"qwenpaw-sandbox-{profile['job_id']}",
        "--user", profile["user"],
        "--network", profile["network"],
        "--hostname", profile["hostname"],
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--memory", profile["memory"],
        "--memory-swap", profile["memory_swap"],
        "--cpus", profile["cpus"],
        "--pids-limit", str(profile["pids_limit"]),
        "--stop-timeout", str(profile["stop_timeout_s"]),
        "--log-driver", "json-file",
        "--log-opt", f"max-size={profile['log_max_size']}",
        "--log-opt", f"max-file={profile['log_max_file']}",
    ]
    for mount in profile["mounts"]:
        if mount["type"] == "bind":
            argv += ["--mount", f"type=bind,source={mount['source']},target={mount['target']}"]
        elif mount["type"] == "tmpfs":
            argv += [
                "--mount",
                f"type=tmpfs,target={mount['target']},tmpfs-size={mount.get('tmpfs_size', '1m')}",
            ]
    for path, opts in sorted(profile.get("tmpfs", {}).items()):
        argv += ["--tmpfs", f"{path}:{opts}"]
    for name, value in sorted(profile.get("ulimits", {}).items()):
        argv += ["--ulimit", f"{name}={value}"]
    argv += [profile["image"]]
    return argv


def compose_service(profile: dict, workspace_root: str = WORKSPACE_ROOT,
                    token_root: str = TOKEN_DIR_ROOT) -> dict:
    """Render a validated profile as a docker-compose service dict.

    Raises ValueError if the profile does not validate clean. The
    compose file in profile/ is the deployed form of this output.
    """
    violations = validate_profile(profile, workspace_root, token_root)
    if violations:
        raise ValueError("invalid sandbox profile: " + "; ".join(violations))
    tmpfs_entries = [f"{p}:{o}" for p, o in sorted(profile.get("tmpfs", {}).items())]
    for m in profile["mounts"]:
        if m["type"] == "tmpfs":
            tmpfs_entries.append(
                f"{m['target']}:rw,noexec,nosuid,nodev,"
                f"size={m.get('tmpfs_size', '1m')},mode={m.get('tmpfs_mode', '0700')}"
            )
    return {
        "image": profile["image"],
        "container_name": f"qwenpaw-sandbox-{profile['job_id']}",
        "user": profile["user"],
        "networks": [profile["network"]],
        "hostname": profile["hostname"],
        "read_only": True,
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges"],
        "pids_limit": profile["pids_limit"],
        "mem_limit": profile["memory"],
        "memswap_limit": profile["memory_swap"],
        "cpus": float(profile["cpus"]),
        "stop_grace_period": f"{profile['stop_timeout_s']}s",
        "volumes": [
            f"{m['source']}:{m['target']}"
            for m in profile["mounts"]
            if m["type"] == "bind"
        ],
        "tmpfs": sorted(tmpfs_entries),
        "logging": {
            "driver": "json-file",
            "options": {
                "max-size": profile["log_max_size"],
                "max-file": str(profile["log_max_file"]),
            },
        },
    }
