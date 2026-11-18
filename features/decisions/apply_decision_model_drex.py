#!/usr/bin/env python3
"""Apply the Drex decision_model slot to BOTH QwenPaw agents (machine script).

Run by the parent ON THE MACHINE, after the NACE key exists. This script
is DRY-RUN by default: it prints exactly what it would change and changes
nothing. Pass --apply to write.

What it writes, per agent (default + QA):
    "decision_model": {"provider_id": "nace", "model": "drex-max-v1.1"}
in working/workspaces/default/agent.json and
   working/workspaces/QwenPaw_QA_Agent_0.2/agent.json.
It NEVER touches approval_level (another builder owns the SMART patch),
never touches any other key, and backs each file up first
(<agent.json>.bak-<timestamp>).

Endpoint: QwenPaw's ModelSlotConfig {provider_id, model} has NO endpoint
field, so the endpoint does not go in agent.json. The script ensures
NACE_BASE_URL=https://console.nace.ai exists in the machine .env (appended
only if absent; an existing value is left alone -- the operator's choice
wins). The key is NEVER written by this script.

Fail-closed key gate (--apply only): the script refuses with exit 2 and
"blocked on NACE key", changing nothing, unless the NACE key is present
in the process environment (NACE_API_KEY) or as a non-empty line in the
.env file -- or the operator passes --key-in-settings to confirm the key
is already in QwenPaw's encrypted env store. --dry-run skips the gate
(it changes nothing) but still reports the key status.

CAVEAT (not verified): provider_id "nace" must resolve in QwenPaw's
provider registry for the slot to do anything. The fork (gogibeta/rakazo
PR #8) added Drex as a decision provider in the fork codebase; whether
the deployed image carries a "nace" registration is NOT verified. After
applying, the parent must confirm the provider resolves on the machine
before flipping approval_level to JEV (see features/decisions/README.md).

Usage (on the machine, as the qwenpaw user):
    python3 apply_decision_model_drex.py            # dry-run, changes nothing
    python3 apply_decision_model_drex.py --apply    # writes both agent.json
    # if the key lives in QwenPaw Settings / encrypted store, not .env:
    python3 apply_decision_model_drex.py --apply --key-in-settings

Exit codes: 0 done (or dry-run clean); 1 error (bad JSON, missing file);
2 blocked on NACE key.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_BASE_URL = "https://console.nace.ai"
DEFAULT_AGENT = "/data/home/qwenpaw/working/workspaces/default/agent.json"
QA_AGENT = "/data/home/qwenpaw/working/workspaces/QwenPaw_QA_Agent_0.2/agent.json"
DEFAULT_ENV_FILE = "/data/home/qwenpaw/.env"


def load_fragment() -> dict:
    frag = json.loads((HERE / "decision_model_drex.json").read_text(encoding="utf-8"))
    return frag["agent_json"]["decision_model"]


def key_present(env_file: Path) -> bool:
    import os
    if os.environ.get("NACE_API_KEY", "").strip():
        return True
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*NACE_API_KEY\s*=\s*(.+?)\s*$", line)
            if m and m.group(1).strip().strip("\"'"):
                return True
    return False


def ensure_base_url(env_file: Path, dry_run: bool) -> str:
    """Make sure NACE_BASE_URL is in .env. Returns what happened."""
    if env_file.is_file():
        text = env_file.read_text(encoding="utf-8")
        if re.search(r"(?m)^\s*NACE_BASE_URL\s*=", text):
            return "NACE_BASE_URL already present in .env (left alone)"
    else:
        text = ""
    line = f"NACE_BASE_URL={DEFAULT_BASE_URL}\n"
    if dry_run:
        return f"would append {line.strip()!r} to {env_file}"
    env_file.write_text(text + ("" if text.endswith("\n") or not text else "\n") + line,
                        encoding="utf-8")
    return f"appended NACE_BASE_URL={DEFAULT_BASE_URL} to {env_file}"


def apply_one(path: Path, slot: dict, dry_run: bool) -> str:
    if not path.is_file():
        raise FileNotFoundError(f"agent file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    before_level = data.get("approval_level")
    before_slot = data.get("decision_model")
    if dry_run:
        return (f"{path}: would set decision_model {before_slot!r} -> {slot!r} "
                f"(approval_level stays {before_level!r})")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    backup = path.with_name(path.name + f".bak-{stamp}")
    backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    data["decision_model"] = slot
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    after = json.loads(path.read_text(encoding="utf-8"))
    if after.get("decision_model") != slot:
        raise RuntimeError(f"verify failed after write: {path}")
    if after.get("approval_level") != before_level:
        raise RuntimeError(f"approval_level changed unexpectedly: {path}")
    return (f"{path}: decision_model set to {slot!r} "
            f"(approval_level unchanged at {before_level!r}); backup {backup.name}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--default-agent", default=DEFAULT_AGENT)
    ap.add_argument("--qa-agent", default=QA_AGENT)
    ap.add_argument("--env-file", default=DEFAULT_ENV_FILE)
    ap.add_argument("--apply", action="store_true",
                    help="actually write (default is dry-run)")
    ap.add_argument("--key-in-settings", action="store_true",
                    help="confirm the NACE key is already in QwenPaw's "
                         "encrypted env store (skips the .env key gate)")
    args = ap.parse_args(argv)

    slot = load_fragment()
    env_file = Path(args.env_file)
    has_key = key_present(env_file) or args.key_in_settings

    if args.apply and not has_key:
        print("blocked on NACE key: no NACE_API_KEY in the environment or "
              f"in {env_file}, and --key-in-settings was not passed. "
              "Nothing was changed. The key is supplied by Rohan; this "
              "script never writes a key.", file=sys.stderr)
        return 2

    print(f"key status: {'present' if has_key else 'NOT FOUND (dry-run only)'}")
    print(f"slot to apply: {slot!r}")
    try:
        for agent_path in (Path(args.default_agent), Path(args.qa_agent)):
            print(apply_one(agent_path, slot, dry_run=not args.apply))
        print(ensure_base_url(env_file, dry_run=not args.apply))
    except (FileNotFoundError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not args.apply:
        print("dry-run: nothing was changed. Re-run with --apply to write.")
    else:
        print("applied. NEXT (parent): confirm the 'nace' provider resolves "
              "on the machine and run the live test "
              "(features/decisions/test_drex_live.py) -- see README.md. "
              "Do NOT flip approval_level to JEV until the provider resolves.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
