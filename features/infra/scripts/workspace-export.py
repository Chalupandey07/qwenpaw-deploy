#!/usr/bin/env python3
"""Export / import a QwenPaw workspace folder (identity + prompts + skills).

Identity-only: NEVER carries chats, sessions, memory stores or credentials.
Tested on a COPY of the live QA workspace, never the live workspace.

Usage:
  workspace-export.py export <workspace-dir> <out.tgz>
  workspace-export.py import <archive.tgz> <dest-workspace-dir> [--backup-dir DIR]
  workspace-export.py verify <archive.tgz>

Safety:
  - Export allowlist only; history.db*, sessions/, checkpoints/, state/,
    memory/, mem_*, media/, resource/, drivers/, digest/ are excluded.
  - Import verifies manifest sha256 for every file, rejects tar members
    that escape the destination, and refuses to overwrite an existing
    workspace unless --backup-dir is given (existing dir is moved aside,
    never deleted).
  - Never edits config.json and never touches working.secret.
"""
import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import time

TOP_FILES = {
    "agent.json", "SOUL.md", "PROFILE.md", "MEMORY.md", "AGENTS.md",
    "HEARTBEAT.md", "CONTACTS.md", "BOOTSTRAP.md", "MAIL_TRIAGE.md",
    "skill.json", "jobs.json",
}
TOP_DIRS = {"skills"}
EXCLUDE_DIRS = {
    "sessions", "checkpoints", "state", "memory", "mem_agent",
    "mem_session", "mem_metadata", "media", "resource", "drivers",
    "digest", "__pycache__",
}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(workspace):
    """Return {arcname: abspath} for the export allowlist."""
    if not os.path.isdir(workspace):
        raise SystemExit(f"not a directory: {workspace}")
    agent_json = os.path.join(workspace, "agent.json")
    soul = os.path.join(workspace, "SOUL.md")
    if not os.path.isfile(agent_json):
        raise SystemExit(f"refusing: no agent.json in {workspace} (not a workspace?)")
    if not os.path.isfile(soul):
        raise SystemExit(f"refusing: no SOUL.md in {workspace} (not a workspace?)")
    files = {}
    for name in sorted(os.listdir(workspace)):
        path = os.path.join(workspace, name)
        if os.path.isfile(path) and name in TOP_FILES:
            files[name] = path
        elif os.path.isdir(path) and name in TOP_DIRS:
            for root, dirs, filenames in os.walk(path):
                dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
                for fn in filenames:
                    if fn.endswith((".shm", ".wal")):
                        continue
                    full = os.path.join(root, fn)
                    arc = os.path.relpath(full, workspace)
                    files[arc] = full
    if not files:
        raise SystemExit("nothing to export (allowlist empty)")
    return files


def cmd_export(args):
    files = collect(args.workspace)
    with open(os.path.join(args.workspace, "agent.json"), encoding="utf-8") as f:
        agent = json.load(f)
    manifest = {
        "format": "qwenpaw-workspace-export/1",
        "agent_id": agent.get("id"),
        "agent_name": agent.get("name"),
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": {},
    }
    with tarfile.open(args.out, "w:gz") as tar:
        for arc in sorted(files):
            manifest["files"][arc] = sha256_file(files[arc])
            tar.add(files[arc], arcname=arc)
        data = json.dumps(manifest, indent=2).encode("utf-8")
        info = tarfile.TarInfo("manifest.json")
        info.size = len(data)
        info.mtime = int(time.time())
        tar.addfile(info, io.BytesIO(data))
    print(f"exported {len(files)} files (agent={manifest['agent_id']}) -> {args.out}")
    print("excluded by design: history.db*, sessions/, checkpoints/, state/, "
          "memory/, mem_*, media/, resource/, drivers/, digest/")
    return 0


def _safe_members(tar, dest):
    dest_abs = os.path.abspath(dest)
    for m in tar.getmembers():
        target = os.path.abspath(os.path.join(dest_abs, m.name))
        if os.path.commonpath([dest_abs, target]) != dest_abs:
            raise SystemExit(f"refusing: tar member escapes destination: {m.name}")
        yield m


def cmd_verify(args):
    with tarfile.open(args.archive, "r:gz") as tar:
        try:
            manifest = json.load(tar.extractfile("manifest.json"))
        except KeyError:
            raise SystemExit("no manifest.json in archive (not a workspace export?)")
        for arc, want in sorted(manifest["files"].items()):
            member = tar.getmember(arc)
            got = hashlib.sha256(tar.extractfile(member).read()).hexdigest()
            if got != want:
                raise SystemExit(f"HASH MISMATCH: {arc}")
    print(f"verify OK: {len(manifest['files'])} files, agent={manifest.get('agent_id')}")
    return 0


def cmd_import(args):
    with tarfile.open(args.archive, "r:gz") as tar:
        try:
            manifest = json.load(tar.extractfile("manifest.json"))
        except KeyError:
            raise SystemExit("no manifest.json in archive (not a workspace export?)")
        names = tar.getnames()
        if "agent.json" not in names or "SOUL.md" not in names:
            raise SystemExit("archive lacks agent.json/SOUL.md; refusing import")
        for arc, want in sorted(manifest["files"].items()):
            got = hashlib.sha256(tar.extractfile(arc).read()).hexdigest()
            if got != want:
                raise SystemExit(f"HASH MISMATCH, refusing import: {arc}")
    if os.path.exists(args.dest):
        if not args.backup_dir:
            raise SystemExit(
                f"destination exists: {args.dest}\n"
                "refusing to overwrite. Re-run with --backup-dir DIR to move "
                "the existing workspace aside first (it is never deleted)."
            )
        os.makedirs(args.backup_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        backup = os.path.join(
            args.backup_dir,
            os.path.basename(args.dest.rstrip("/")) + "." + stamp,
        )
        shutil.move(args.dest, backup)
        print(f"moved existing workspace aside -> {backup}")
    os.makedirs(args.dest, exist_ok=True)
    with tarfile.open(args.archive, "r:gz") as tar:
        for m in _safe_members(tar, args.dest):
            if m.name == "manifest.json":
                continue
            # filter="data" blocks absolute paths, .. members and device
            # files on Python >= 3.12 (defense in depth with _safe_members).
            tar.extract(m, path=args.dest, filter="data")
    print(f"imported agent={manifest.get('agent_id')} -> {args.dest}")
    print("NOTE: a new workspace is only picked up by QwenPaw at startup; "
          "registering it in config.json agents.profiles is a separate, "
          "approved step (see 11-fleet-manager.md).")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("workspace")
    e.add_argument("out")
    v = sub.add_parser("verify")
    v.add_argument("archive")
    i = sub.add_parser("import")
    i.add_argument("archive")
    i.add_argument("dest")
    i.add_argument("--backup-dir", default=None)
    args = p.parse_args()
    if args.cmd == "export":
        return cmd_export(args)
    if args.cmd == "verify":
        return cmd_verify(args)
    return cmd_import(args)


if __name__ == "__main__":
    sys.exit(main())
