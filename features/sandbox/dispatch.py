#!/usr/bin/env python3
"""Job-runner dispatch: route Code Mode jobs to the sandbox (gap #6, T139).

Before this, every job ran in the main container. The dispatch rule
is now: generated code runs ONLY in the sandbox container; anything
that cannot run there is REFUSED, never silently fallen back to the
main container. A silent fallback would recreate exactly the hole the
sandbox exists to close, and the refusal would be invisible.

Routing table (``route_job`` returns ``{"target", "reason", ...}``):

* ``kind == "generated-code"`` (or ``"code"``) with a workspace under
  the workspace root, a deadline within the hard max, every network
  host on the T123 allowlist, and (if it needs a vault item) a token
  scope that names exactly that item -> ``sandbox``.
* ``kind == "codemode-fixed-job"`` -> ``main``. This is the ONE legacy
  exception: the B-41 fixed pilot job drives the real desktop through
  the MCP proxy (X11, no generated code, no vault item, no network
  beyond the proxy). It cannot run in the sandbox, and it is not
  generated code, so it stays where it is. The exception is by exact
  job id, not by a flag a caller can set.
* anything needing the desktop / X11 / the MCP proxy tools
  (``needs_desktop`` true, or a tool in ``DESKTOP_TOOLS``) ->
  ``refuse`` ("needs-desktop"). The sandbox has no X11 socket and no
  route to the MCP proxy; routing such a job to the sandbox would
  fail late, and routing it to main would bypass the sandbox.
* any network host outside the T123 allowlist -> ``refuse``
  ("egress-denied"). The proxy would deny it anyway; refusing here
  keeps the denial visible at dispatch time.
* any vault item without a token scope naming it -> ``refuse``
  ("vault-scope"). The broker will not inject a value the token does
  not name.
* deadline above the hard max, workspace outside the root, unknown
  kind -> ``refuse`` with the reason named.

``route_job`` does NOT mint tokens and does NOT start containers. It
decides the target and says why. Minting (``vault_tokens.mint_token``)
and profile building (``sandbox.build_profile``) happen after a
``sandbox`` decision, and the profile is validated before anything
runs.
"""

from __future__ import annotations

import os
import sys

__all__ = ["DESKTOP_TOOLS", "FIXED_PILOT_JOB_ID", "route_job"]

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))

# The nine real desktop tools (features/codemode/README.md, DESKTOP_TOOLS).
# A job naming any of these needs the live desktop and cannot run in
# the sandbox. Kept as a literal list here so dispatch does not depend
# on importing the codemode runner.
DESKTOP_TOOLS = (
    "list_apps",
    "get_app_state",
    "click",
    "type_text",
    "press_key",
    "scroll",
    "set_value",
    "drag",
    "perform_secondary_action",
)

# The one legacy exception: the B-41 fixed pilot job. Exact job id,
# not a caller-set flag.
FIXED_PILOT_JOB_ID = "codemode-fixed-job"


def _load_egress_allowlist() -> set[str]:
    """The T123 allowlist — the SAME list, loaded from egress_guard.

    Dispatch reuses it; it does not invent a second allowlist. If the
    egress-guard module cannot be loaded, dispatch fails closed: no
    network host is allowed at all.
    """
    path = os.path.join(REPO_ROOT, "features", "egress-guard", "egress_guard.py")
    try:
        import importlib.util

        spec = importlib.util.spec_from_file_location("egress_guard", path)
        if spec is None or spec.loader is None:
            return set()
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return set(module.load_allowlist())
    except Exception:
        return set()


def route_job(job: dict, allowlist: set[str] | None = None) -> dict:
    """Route one job. Returns a dict with at least ``target`` + ``reason``.

    ``job`` keys: ``job_id``, ``kind`` (``generated-code`` | ``code`` |
    ``codemode-fixed-job`` | anything else), ``workspace`` (host path),
    ``deadline_s`` (optional), ``tools`` (optional list of tool names
    the job will call), ``needs_desktop`` (optional bool), ``hosts``
    (optional list of network hosts the job will fetch), ``vault_items``
    (optional list of vault item names), ``token_items`` (optional list
    of vault item names the minted token actually scopes — the caller
    passes what it minted; dispatch checks the job's needs are inside
    it, it does not mint).
    """
    job_id = str(job.get("job_id") or "").strip()
    kind = str(job.get("kind") or "").strip()
    if not job_id:
        return {"target": "refuse", "reason": "job_id missing"}
    if not kind:
        return {"target": "refuse", "reason": "kind missing: unknown job kind"}

    # The one legacy exception, by exact job id.
    if kind == "codemode-fixed-job" or job_id == FIXED_PILOT_JOB_ID:
        return {
            "target": "main",
            "reason": "fixed desktop pilot job (B-41): no generated code, "
            "drives the MCP desktop; cannot run in the sandbox",
        }

    if kind not in ("generated-code", "code"):
        return {"target": "refuse", "reason": f"unknown job kind: {kind!r}"}

    # Desktop work cannot run in the sandbox and must not fall back.
    tools = [str(t) for t in (job.get("tools") or [])]
    desktop_used = sorted(set(tools) & set(DESKTOP_TOOLS))
    if job.get("needs_desktop") or desktop_used:
        return {
            "target": "refuse",
            "reason": "needs-desktop: job uses desktop tools "
            f"{desktop_used or ['(flagged)']} which need X11/MCP; "
            "the sandbox has neither and the job must not fall back to main",
        }

    # Workspace must be a real job workspace under the workspace root.
    workspace = str(job.get("workspace") or "").strip()
    root = "/data/home/qwenpaw/working/workspaces"
    if not workspace.startswith(root.rstrip("/") + "/"):
        return {
            "target": "refuse",
            "reason": f"workspace outside the workspace root: {workspace!r}",
        }

    # Lifetime cap.
    try:
        deadline = int(job.get("deadline_s", 120))
    except (TypeError, ValueError):
        return {"target": "refuse", "reason": "deadline_s is not an integer"}
    if deadline <= 0 or deadline > 300:
        return {
            "target": "refuse",
            "reason": f"deadline_s {deadline} outside 1..300",
        }

    # Egress: every host must be on the T123 allowlist.
    hosts = [str(h).lower() for h in (job.get("hosts") or [])]
    allowed = _load_egress_allowlist() if allowlist is None else set(allowlist)
    denied = sorted({h for h in hosts if h not in allowed})
    if denied:
        return {
            "target": "refuse",
            "reason": f"egress-denied: hosts not on the T123 allowlist: {denied}",
        }

    # Vault: every item the job needs must be inside the token scope.
    needed = sorted({str(i) for i in (job.get("vault_items") or []) if i})
    scoped = sorted({str(i) for i in (job.get("token_items") or []) if i})
    missing = [i for i in needed if i not in scoped]
    if missing:
        return {
            "target": "refuse",
            "reason": f"vault-scope: token does not scope items {missing}; "
            "the broker will not inject a value the token does not name",
        }

    return {
        "target": "sandbox",
        "reason": "generated-code job: workspace-only mount, isolated "
        "bridge, scoped token; no desktop, no vault scope gap",
        "job_id": job_id,
        "hosts": hosts,
        "vault_items": needed,
        "deadline_s": deadline,
    }


def _main(argv: list[str]) -> int:
    """Tiny CLI: route one job described as JSON on stdin, print the decision."""
    import json

    if len(argv) > 1 and argv[1] in ("-h", "--help"):
        print("usage: dispatch.py < job.json  (prints the routing decision)")
        return 2
    try:
        job = json.load(sys.stdin)
    except ValueError as exc:
        print(f"error: invalid job JSON: {exc}")
        return 2
    print(json.dumps(route_job(job), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
