#!/usr/bin/env python3
"""Fleet manager for QwenPaw agents on InstaBox Free (read + dry-run only).

Reads the LIVE config (read-only) and every workspace agent.json:
  fleet.py list                  list all agents + status
  fleet.py show <agent-id>       full detail for one agent
  fleet.py enable --dry-run <agent-id>
  fleet.py schedule --dry-run <agent-id> [--every 6h]

NEVER writes config.json. `enable` and `schedule` are DRY-RUN ONLY: they
print the exact JSON change that would be made and stop. Applying a change
needs coordinator approval, a config edit, and (unverified) a container
restart, because the multi-agent manager preloads agents at startup.

Verified config keys (read live 2026-11-15, QwenPaw v2.3.0):
  config.json["agents"]["active_agent"]            e.g. "default"
  config.json["agents"]["agent_order"]             e.g. ["default"]
  config.json["agents"]["profiles"][id]            {"id","workspace_dir",
                                                    "enabled","pinned"}
  config.json["agents"]["defaults"]["heartbeat"]   {"enabled","every",
                                                    "target","timeoutSeconds"}
  workspaces/<id>/agent.json                      {"id","name","description",
                                                    "workspace_dir","backend",
                                                    "backend_settings",
                                                    "channels":{...enabled},
                                                    "template_id"?}
  working.secret/providers/active_model.json       global active model
                                                   (xingchiapi/gpt-6-astra
                                                   at last live check)

Usage: run on the machine (needs read access to root-owned config.json,
so use sudo):  sudo python3 fleet.py list
Root: --root /data/home/qwenpaw (default). Never point --root at a path
you do not own.
"""
import argparse
import json
import os
import sys

DEFAULT_ROOT = "/data/home/qwenpaw"


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read_fleet(root):
    working = os.path.join(root, "working")
    config = load_json(os.path.join(working, "config.json"))
    agents_cfg = config.get("agents", {})
    profiles = agents_cfg.get("profiles", {})
    active_model = None
    am_path = os.path.join(root, "working.secret", "providers", "active_model.json")
    if os.path.isfile(am_path):
        try:
            active_model = load_json(am_path)
        except Exception as exc:  # noqa: BLE001 - report, don't crash
            active_model = {"_error": str(exc)}
    fleet = []
    ws_dir = os.path.join(working, "workspaces")
    for agent_id in sorted(profiles):
        prof = profiles[agent_id] or {}
        entry = {
            "id": agent_id,
            "enabled": prof.get("enabled"),
            "pinned": prof.get("pinned"),
            "workspace_dir": prof.get("workspace_dir"),
            "active": agents_cfg.get("active_agent") == agent_id,
            "in_order": agent_id in (agents_cfg.get("agent_order") or []),
        }
        local_ws = os.path.join(ws_dir, agent_id, "agent.json")
        if os.path.isfile(local_ws):
            try:
                aj = load_json(local_ws)
                entry["name"] = aj.get("name")
                entry["description"] = aj.get("description")
                entry["backend"] = aj.get("backend")
                entry["template_id"] = aj.get("template_id")
                chans = aj.get("channels") or {}
                entry["channels_enabled"] = sorted(
                    k for k, v in chans.items()
                    if isinstance(v, dict) and v.get("enabled")
                )
            except Exception as exc:  # noqa: BLE001
                entry["agent_json_error"] = str(exc)
        else:
            entry["agent_json_error"] = "agent.json not found under workspaces/"
        fleet.append(entry)
    return {
        "active_agent": agents_cfg.get("active_agent"),
        "agent_order": agents_cfg.get("agent_order"),
        "heartbeat_defaults": (agents_cfg.get("defaults") or {}).get("heartbeat"),
        "active_model": active_model,
        "agents": fleet,
    }


def cmd_list(args):
    data = read_fleet(args.root)
    print(f"active agent : {data['active_agent']}")
    print(f"agent order  : {data['agent_order']}")
    print(f"active model : {json.dumps(data['active_model'])}")
    print(f"heartbeat    : {json.dumps(data['heartbeat_defaults'])}")
    print()
    print(f"{'ID':<28} {'EN':<6} {'ACTIVE':<7} {'NAME':<14} CHANNELS-ON")
    for a in data["agents"]:
        print(
            f"{a['id']:<28} {str(a['enabled']):<6} {str(a['active']):<7} "
            f"{str(a.get('name')):<14} {','.join(a.get('channels_enabled', [])) or '-'}"
        )
        if a.get("agent_json_error"):
            print(f"  !! {a['agent_json_error']}")
    return 0


def cmd_show(args):
    data = read_fleet(args.root)
    for a in data["agents"]:
        if a["id"] == args.agent_id:
            print(json.dumps(a, indent=2))
            return 0
    print(f"no agent {args.agent_id!r} in config.json agents.profiles", file=sys.stderr)
    print("known ids:", [a["id"] for a in data["agents"]], file=sys.stderr)
    return 1


def cmd_enable(args):
    data = read_fleet(args.root)
    match = [a for a in data["agents"] if a["id"] == args.agent_id]
    if not match:
        print(f"no agent {args.agent_id!r}", file=sys.stderr)
        return 1
    a = match[0]
    print("DRY-RUN ONLY — nothing was written.")
    print(f"agent {a['id']!r} is currently enabled={a['enabled']}.")
    print("The change that WOULD be made to working/config.json:")
    print(json.dumps(
        {"agents": {"profiles": {a["id"]: {"enabled": True}}}},
        indent=2,
    ))
    print("Then: restart the container so the multi-agent manager preloads")
    print("it (restart requirement is UNVERIFIED — preload happens at startup,")
    print("per the log line 'Agent startup complete: 2/2 agents started').")
    print("Applying needs coordinator approval. This script never writes config.json.")
    return 0


def cmd_schedule(args):
    data = read_fleet(args.root)
    match = [a for a in data["agents"] if a["id"] == args.agent_id]
    if not match:
        print(f"no agent {args.agent_id!r}", file=sys.stderr)
        return 1
    print("DRY-RUN ONLY — nothing was written.")
    print(f"current heartbeat defaults: {json.dumps(data['heartbeat_defaults'])}")
    print("Heartbeat is GLOBAL in this QwenPaw version (agents.defaults.heartbeat),")
    print("not per-agent. The change that WOULD be made to working/config.json:")
    print(json.dumps(
        {"agents": {"defaults": {"heartbeat": {
            "enabled": True, "every": args.every, "target": args.agent_id,
            "timeoutSeconds": 300}}}},
        indent=2,
    ))
    print("Caveat: per-agent heartbeat targeting is NOT verified in v2.3.0 —")
    print("'target' defaults to 'main'. Verify in the console after applying.")
    print("Applying needs coordinator approval. This script never writes config.json.")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", default=DEFAULT_ROOT)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    s = sub.add_parser("show")
    s.add_argument("agent_id")
    e = sub.add_parser("enable")
    e.add_argument("--dry-run", action="store_true", required=True,
                   help="required: enable is dry-run only")
    e.add_argument("agent_id")
    sc = sub.add_parser("schedule")
    sc.add_argument("--dry-run", action="store_true", required=True,
                    help="required: schedule is dry-run only")
    sc.add_argument("agent_id")
    sc.add_argument("--every", default="6h")
    args = p.parse_args()
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd == "show":
        return cmd_show(args)
    if args.cmd == "enable":
        return cmd_enable(args)
    return cmd_schedule(args)


if __name__ == "__main__":
    sys.exit(main())
