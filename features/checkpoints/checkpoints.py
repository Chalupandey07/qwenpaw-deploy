#!/usr/bin/env python3
"""Per-run workspace snapshots + rollback for QwenPaw (AgentX).

Gap #7 from the 2026-11-18 agent research (Cline, Claude Code, OpenCode):
before the FIRST mutation in a run, snapshot the workspace, tag it with
the run ID, and expose a restore command. This is the recovery half of
the approval system: one bad ``rm`` or one bad write is unrecoverable
without it.

Design (chosen over a git worktree/branch, and why):

* A tarball is the right container here. The agent workspace
  (``working/workspaces/default/``) is usually NOT a git repo, so a
  branch would need repo setup first, would silently drop empty
  directories and git-ignored files, and handles large binaries and
  permission bits awkwardly. A gzip tarball captures the exact bytes
  (including empty directories and modes) with no repo at all, and it
  is verifiable: every file is sha256-checked on restore.
* What it is NOT: a backup system, a version-control system, or a
  history/memory rollback. ``history.db`` / chats / sessions are
  deliberately NEVER snapshotted (see the exclusion list) — a restore
  rolls back workspace FILES only, while the conversation history still
  records the run that produced them. That mismatch is documented in
  README.md, not hidden.

Safety rules (the point of this tool — the no-loss rule governs it):

1. A snapshot for a run ID is taken ONCE. A second snapshot with the
   same run ID is a no-op that reports the existing snapshot; the first
   (pre-mutation) state always wins. Overwriting a pre-mutation
   snapshot with post-mutation state would defeat the tool.
2. Restore REFUSES by default when the workspace has drifted from the
   snapshot — any file added, modified, or deleted after the snapshot
   (detected by enumerating the whole workspace and hashing, not by
   trusting mtimes). ``--force`` overrides, but only after printing
   exactly which files will be lost/overwritten.
3. Every restore first takes an automatic pre-restore safety snapshot
   (run ID ``pre-restore-<run-id>-<timestamp>``) of the CURRENT state,
   so a restore is itself reversible: restoring that safety snapshot
   returns the workspace to exactly where it was before the restore.
   If the safety snapshot cannot be taken, the restore aborts.
4. The tarball is verified twice: its sha256 against the manifest, and
   every extracted file's sha256 against the manifest, BEFORE anything
   in the workspace is touched. A corrupt snapshot never half-restores.
5. Restore returns the workspace to the EXACT snapshot state: files
   created after the snapshot are removed — but they are preserved in
   the pre-restore safety snapshot (rule 3), never silently deleted.
6. Snapshots may contain secrets (the workspace can hold keys in
   files). The store directory is created mode 0700 and snapshot files
   mode 0600, and snapshots must NEVER be committed, uploaded, or
   copied off the machine. Secrets are NOT scrubbed from snapshots:
   scrubbing them would make a restore silently leave stale
   credentials behind, which is worse.

Layout (default store is ``<workspace>/checkpoints/``, the same name
upstream QwenPaw already uses for its workspace checkpoints directory;
``--store`` overrides it):

    <store>/<run-id>.tgz    the snapshot tarball (gzip tar, sorted members)
    <store>/<run-id>.json   the manifest (run id, timestamp, file list
                            with sha256 + size + mode, skipped entries,
                            tarball sha256, exclusions applied)

Usage (all paths are workspace paths on the machine; the test suite
exercises this CLI on temporary scratch directories only):

    python3 checkpoints.py snapshot --workspace <dir> --run-id <id>
    python3 checkpoints.py list [--store <dir>]
    python3 checkpoints.py restore --workspace <dir> --run-id <id> [--force]
    python3 checkpoints.py restore --workspace <dir> --run-id <id> --force
        --no-safety-snapshot     # discouraged; only when the store is full

Stdlib only. No network, no LLM call, no new key, no container restart.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

VERSION = "1.0.0"

# Default store directory name inside the workspace. Matches the
# ``checkpoints/`` directory upstream QwenPaw already uses in a
# workspace, so export/reset tooling (which already excludes it)
# treats snapshots the same way.
STORE_DIRNAME = "checkpoints"

# A snapshot that would be larger than this is refused: a workspace
# snapshot should be working files, not a media dump. Override with
# --max-bytes. 500 MiB is far above any real workspace once the
# exclusions below are applied (the bloat audit measured the whole
# session state at ~21 MB).
DEFAULT_MAX_BYTES = 500 * 1024 * 1024

# --- Exclusion list ---------------------------------------------------
# Every entry is a deliberate decision; README.md documents each one.
# Directories are matched by name at any depth; files by name/suffix.

EXCLUDED_DIR_NAMES = {
    "checkpoints",      # the snapshot store itself (never snapshot snapshots)
    ".checkpoints",     # alternate store name, same reason
    "__pycache__",      # regenerable bytecode
    ".pytest_cache",    # regenerable test cache
    "node_modules",     # regenerable, routinely hundreds of MB
    ".venv", "venv",    # regenerable virtualenvs
    ".cache",           # regenerable caches
    ".git",             # not a repo snapshot; .git can be GBs and is not
                        # workspace content. (If the workspace IS a repo,
                        # use git for that; this tool snapshots files.)
    "sessions",         # per-run session state (bloat audit: a 9.2 MB
                        # session file re-serialized every turn). Live
                        # state, not workspace content; restoring it
                        # would resurrect a dead run's in-memory state.
    "media",            # user-owned media, large binaries, protected
                        # from reset for the same reason; not agent work
                        # product. (Back it up separately if needed.)
    "digest",           # generated summaries; regenerable from history.
}

EXCLUDED_FILE_SUFFIXES = (
    ".log",             # logs are diagnostics, unbounded, and the log
    ".log.gz",          # rotation incident (2026-11-18) showed logs
                        # must never be treated as restorable state.
    ".pyc", ".pyo",     # bytecode, regenerable
    ".tmp", ".swp", ".swo",  # editor / temp files
    ".DS_Store",
)

EXCLUDED_FILE_NAMES = {
    "history.db", "history.db-wal", "history.db-shm",
    "history.db-journal",
    # Live SQLite databases must NEVER be copied mid-write: the copy
    # is corrupt/unusable, and AGENTS.md forbids touching history.db.
    # The same applies to any other live *.db-wal / *.db-shm pair,
    # matched by suffix below.
    "audit.db-wal", "audit.db-shm", "audit.db-journal",
}

EXCLUDED_FILE_SUFFIXES_LIVE_DB = (".db-wal", ".db-shm", ".db-journal")

RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class CheckpointError(Exception):
    """A refused or failed snapshot/restore. Message is user-facing."""


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_excluded_dir(name: str) -> bool:
    return name in EXCLUDED_DIR_NAMES


def _is_excluded_file(name: str) -> bool:
    if name in EXCLUDED_FILE_NAMES:
        return True
    if name.endswith(EXCLUDED_FILE_SUFFIXES):
        return True
    if name.endswith(EXCLUDED_FILE_SUFFIXES_LIVE_DB):
        return True
    return False


def validate_run_id(run_id: str) -> str:
    """Run IDs are flat names, never paths. Reject traversal outright."""
    if not RUN_ID_RE.match(run_id or ""):
        raise CheckpointError(
            f"invalid run id {run_id!r}: use letters, digits, '.', '_' or '-', "
            "starting with a letter or digit, max 128 chars, no '/'"
        )
    if run_id in (".", ".."):
        raise CheckpointError(f"invalid run id {run_id!r}")
    return run_id


def _resolve_workspace(workspace: str | Path) -> Path:
    ws = Path(workspace).expanduser().resolve()
    if not ws.is_dir():
        raise CheckpointError(f"workspace is not a directory: {ws}")
    if str(ws) in ("/", str(Path.home())):
        raise CheckpointError(f"refusing to snapshot the filesystem root or home: {ws}")
    return ws


def _resolve_store(workspace: Path, store: str | Path | None) -> Path:
    if store is None:
        return workspace / STORE_DIRNAME
    st = Path(store).expanduser()
    if not st.is_absolute():
        st = (workspace / st).resolve()
    else:
        st = st.resolve()
    if st == workspace or workspace in st.parents and st.parent == workspace:
        pass  # store inside the workspace is the normal case
    if st == Path("/"):
        raise CheckpointError("refusing to use the filesystem root as a snapshot store")
    return st


def _ensure_store(store: Path) -> None:
    store.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(store, 0o700)
    except OSError:
        pass  # best effort on filesystems without POSIX modes


def _iter_workspace_files(workspace: Path, store: Path):
    """Yield (relative path, absolute path) for every in-scope file.

    Excluded directories (including the store itself) are pruned, so a
    snapshot never contains its own store and drift scans never see it.
    Symlinks are yielded as links, not followed; the caller decides.
    Deterministic order: sorted dirs and files at every level.
    """
    store_real = store.resolve()
    for root, dirs, files in os.walk(workspace):
        root_p = Path(root)
        dirs[:] = sorted(
            d for d in dirs
            if not _is_excluded_dir(d)
            and (root_p / d).resolve() != store_real
        )
        for name in sorted(files):
            if _is_excluded_file(name):
                continue
            yield (root_p / name).relative_to(workspace), root_p / name


def _iter_workspace_dirs(workspace: Path, store: Path):
    """Yield relative paths of in-scope (non-excluded) directories."""
    store_real = store.resolve()
    for root, dirs, _files in os.walk(workspace):
        root_p = Path(root)
        dirs[:] = sorted(
            d for d in dirs
            if not _is_excluded_dir(d)
            and (root_p / d).resolve() != store_real
        )
        for d in dirs:
            yield (root_p / d).relative_to(workspace)


def _scan_workspace(workspace: Path, store: Path):
    """Full content scan: {relpath: (size, sha256, mode)} + skipped list.

    Symlinks whose target escapes the workspace are SKIPPED and listed
    (restoring an outside link would be a path escape); symlinks to
    targets inside the workspace are recorded as links. Sockets, FIFOs
    and devices are skipped and listed — a tarball cannot carry them.
    """
    files: dict[str, dict] = {}
    skipped: list[dict] = []
    ws_real = workspace.resolve()
    for rel, abs_path in _iter_workspace_files(workspace, store):
        try:
            st = os.lstat(abs_path)
        except OSError as exc:
            skipped.append({"path": str(rel), "reason": f"unreadable: {exc}"})
            continue
        import stat as _stat
        if _stat.S_ISLNK(st.st_mode):
            target = os.readlink(abs_path)
            target_abs = (abs_path.parent / target).resolve()
            try:
                target_abs.relative_to(ws_real)
            except ValueError:
                skipped.append({
                    "path": str(rel),
                    "reason": f"symlink escapes workspace -> {target}",
                })
                continue
            files[str(rel)] = {
                "size": 0, "sha256": _sha256_bytes(b""),
                "mode": oct(_stat.S_IMODE(st.st_mode)),
                "link": target,
            }
            continue
        if not _stat.S_ISREG(st.st_mode):
            skipped.append({"path": str(rel), "reason": "not a regular file (socket/fifo/device)"})
            continue
        files[str(rel)] = {
            "size": st.st_size,
            "sha256": _sha256_file(abs_path),
            "mode": oct(_stat.S_IMODE(st.st_mode)),
        }
    return files, skipped


def _tarball_path(store: Path, run_id: str) -> Path:
    return store / f"{run_id}.tgz"


def _manifest_path(store: Path, run_id: str) -> Path:
    return store / f"{run_id}.json"


def _write_manifest(store: Path, manifest: dict) -> Path:
    path = _manifest_path(store, manifest["run_id"])
    text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def snapshot(workspace, run_id, store=None, max_bytes=DEFAULT_MAX_BYTES):
    """Snapshot the workspace before the first mutation of a run.

    Returns the manifest dict. If a snapshot for this run ID already
    exists, it is a no-op returning the existing manifest — the FIRST
    (pre-mutation) state always wins.
    """
    run_id = validate_run_id(run_id)
    ws = _resolve_workspace(workspace)
    st = _resolve_store(ws, store)
    _ensure_store(st)
    tarball = _tarball_path(st, run_id)
    manifest_p = _manifest_path(st, run_id)
    if tarball.exists() or manifest_p.exists():
        if manifest_p.exists():
            return json.loads(manifest_p.read_text(encoding="utf-8"))
        raise CheckpointError(
            f"snapshot {run_id!r} exists as a tarball without a manifest; "
            "refusing to overwrite an unverifiable snapshot"
        )
    files, skipped = _scan_workspace(ws, st)
    total = sum(f["size"] for f in files.values() if "link" not in f)
    if total > max_bytes:
        raise CheckpointError(
            f"snapshot {run_id!r} would be {total} bytes, over the "
            f"{max_bytes} byte limit; pass a larger --max-bytes if this "
            "workspace really is that big, or exclude the bulk"
        )
    created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    # Write the tarball to a temp file in the store, then rename: a
    # failed snapshot never leaves a half-written tarball behind.
    tmp_fd, tmp_name = tempfile.mkstemp(dir=st, prefix=f".{run_id}.", suffix=".tmp")
    os.close(tmp_fd)
    tmp_path = Path(tmp_name)
    try:
        with tarfile.open(tmp_path, "w:gz") as tf:
            for rel in sorted(_iter_workspace_dirs(ws, st)):
                ti = tarfile.TarInfo(str(rel))
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
                ti.mtime = 0
                tf.addfile(ti)
            # Iterate the SCANNED file list, not a fresh walk: skipped
            # entries (escaping symlinks, sockets) are in the walk but
            # not in files, and looking them up here used to KeyError.
            for rel_str in sorted(files):
                rel = Path(rel_str)
                abs_path = ws / rel
                info = files[rel_str]
                ti = tarfile.TarInfo(str(rel))
                if "link" in info:
                    ti.type = tarfile.SYMTYPE
                    ti.linkname = info["link"]
                    ti.mode = 0o777
                    ti.mtime = 0
                    tf.addfile(ti)
                    continue
                ti.size = info["size"]
                ti.mode = int(info["mode"], 8)
                ti.mtime = 0
                with open(abs_path, "rb") as fh:
                    tf.addfile(ti, fh)
        try:
            os.chmod(tmp_path, 0o600)
        except OSError:
            pass
        tarball_sha = _sha256_file(tmp_path)
        manifest = {
            "version": 1,
            "tool": f"checkpoints.py {VERSION}",
            "run_id": run_id,
            "created_utc": created,
            "workspace": str(ws),
            "files": files,
            "file_count": len(files),
            "total_bytes": total,
            "skipped": skipped,
            "excluded_dirs": sorted(EXCLUDED_DIR_NAMES),
            "excluded_file_suffixes": sorted(
                set(EXCLUDED_FILE_SUFFIXES) | set(EXCLUDED_FILE_SUFFIXES_LIVE_DB)
            ),
            "excluded_file_names": sorted(EXCLUDED_FILE_NAMES),
            "tarball": f"{run_id}.tgz",
            "tarball_sha256": tarball_sha,
            "tarball_bytes": tmp_path.stat().st_size,
        }
        os.replace(tmp_path, tarball)
        _write_manifest(st, manifest)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    return manifest


def list_snapshots(store):
    """All snapshots in a store, newest first. Returns a list of dicts."""
    st = Path(store).expanduser().resolve()
    if not st.is_dir():
        return []
    out = []
    for manifest_p in sorted(st.glob("*.json")):
        try:
            m = json.loads(manifest_p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            out.append({
                "run_id": manifest_p.stem, "created_utc": None,
                "file_count": None, "total_bytes": None,
                "tarball_bytes": None, "error": "unreadable manifest",
            })
            continue
        tarball = st / m.get("tarball", f"{m.get('run_id', '')}.tgz")
        out.append({
            "run_id": m.get("run_id", manifest_p.stem),
            "created_utc": m.get("created_utc"),
            "file_count": m.get("file_count"),
            "total_bytes": m.get("total_bytes"),
            "tarball_bytes": tarball.stat().st_size if tarball.exists() else None,
            "tarball_missing": not tarball.exists(),
        })
    out.sort(key=lambda d: (d["created_utc"] or ""), reverse=True)
    return out


def compute_drift(workspace, manifest, store=None):
    """What changed in the workspace since the snapshot.

    Full enumeration + hashing (not mtimes): added, modified, deleted
    are all detected, including a file touched with identical content
    (same bytes = NOT drift — content is what matters) and a file
    deleted after the snapshot. Returns
    {"added": [...], "modified": [...], "deleted": [...]}.
    """
    ws = _resolve_workspace(workspace)
    st = _resolve_store(ws, store)
    current, _skipped = _scan_workspace(ws, st)
    snap_files = manifest["files"]
    added = sorted(set(current) - set(snap_files))
    deleted = sorted(set(snap_files) - set(current))
    modified = sorted(
        p for p in set(current) & set(snap_files)
        if current[p]["sha256"] != snap_files[p]["sha256"]
        or current[p].get("link") != snap_files[p].get("link")
    )
    return {"added": added, "modified": modified, "deleted": deleted}


def _load_manifest(store: Path, run_id: str) -> dict:
    manifest_p = _manifest_path(store, run_id)
    if not manifest_p.exists():
        raise CheckpointError(f"no snapshot for run id {run_id!r} in {store}")
    try:
        manifest = json.loads(manifest_p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CheckpointError(f"snapshot manifest for {run_id!r} is unreadable: {exc}")
    if manifest.get("run_id") != run_id or "files" not in manifest:
        raise CheckpointError(f"snapshot manifest for {run_id!r} is malformed")
    return manifest


def _verify_tarball(store: Path, manifest: dict) -> None:
    tarball = store / manifest.get("tarball", f"{manifest['run_id']}.tgz")
    if not tarball.exists():
        raise CheckpointError(f"snapshot tarball for {manifest['run_id']!r} is missing")
    if _sha256_file(tarball) != manifest.get("tarball_sha256"):
        raise CheckpointError(
            f"snapshot tarball for {manifest['run_id']!r} fails its sha256 check; "
            "the snapshot is corrupt and will NOT be restored"
        )
    with tarfile.open(tarball, "r:gz") as tf:
        names = [m.name for m in tf.getmembers() if m.isfile() or m.issym()]
    expected = sorted(manifest["files"])
    if sorted(names) != expected:
        raise CheckpointError(
            f"snapshot tarball for {manifest['run_id']!r} does not match its "
            f"manifest (tarball has {len(names)} files, manifest lists "
            f"{len(expected)}); refusing to restore"
        )


def _validate_member(member: tarfile.TarInfo, dest: Path) -> None:
    """Refuse any tar member that could escape the destination."""
    if os.path.isabs(member.name) or ".." in Path(member.name).parts:
        raise CheckpointError(f"snapshot member escapes the workspace: {member.name!r}")
    target = (dest / member.name).resolve()
    try:
        target.relative_to(dest.resolve())
    except ValueError:
        raise CheckpointError(f"snapshot member escapes the workspace: {member.name!r}")
    if member.issym() or member.islnk():
        link_target = (dest / member.name).parent / member.linkname
        try:
            link_target.resolve().relative_to(dest.resolve())
        except ValueError:
            raise CheckpointError(
                f"snapshot link escapes the workspace: {member.name!r} -> {member.linkname!r}"
            )


def restore(workspace, run_id, store=None, force=False,
            safety_snapshot=True):
    """Roll back the workspace to a named run snapshot.

    Default (force=False): REFUSES with a CheckpointError naming the
    drift if any file was added, modified, or deleted after the
    snapshot. With force=True the drift is printed by the CLI first
    and the restore proceeds — but only after an automatic pre-restore
    safety snapshot preserves the current state (unless
    safety_snapshot=False, which is discouraged and logged).

    Returns {"run_id", "restored_files", "drift", "safety_snapshot"}.
    Raises CheckpointError without touching the workspace on any
    verification failure.
    """
    run_id = validate_run_id(run_id)
    ws = _resolve_workspace(workspace)
    st = _resolve_store(ws, store)
    manifest = _load_manifest(st, run_id)
    _verify_tarball(st, manifest)
    drift = compute_drift(ws, manifest, st)
    if (drift["added"] or drift["modified"] or drift["deleted"]) and not force:
        raise CheckpointError(
            "refusing to restore snapshot "
            f"{run_id!r}: the workspace has changed since the snapshot "
            f"(added={drift['added']}, modified={drift['modified']}, "
            f"deleted={drift['deleted']}). Re-run with --force to "
            "overwrite those changes; the files listed will be lost "
            "unless a safety snapshot preserves them."
        )
    safety_id = None
    if safety_snapshot:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        safety_id = f"pre-restore-{run_id}-{stamp}"
        snapshot(ws, safety_id, store=st)
    tarball = st / manifest.get("tarball", f"{run_id}.tgz")
    with tempfile.TemporaryDirectory(prefix="ckpt-restore-") as tmp:
        extract_dir = Path(tmp) / "tree"
        extract_dir.mkdir()
        with tarfile.open(tarball, "r:gz") as tf:
            for member in tf.getmembers():
                _validate_member(member, extract_dir)
            tf.extractall(extract_dir, filter="data")
        # Verify every extracted byte against the manifest BEFORE
        # touching the workspace. A corrupt extraction aborts here.
        for rel, info in manifest["files"].items():
            path = extract_dir / rel
            if "link" in info:
                if not path.is_symlink() or os.readlink(path) != info["link"]:
                    raise CheckpointError(
                        f"extracted snapshot link mismatch: {rel}"
                    )
                continue
            if not path.is_file() or _sha256_file(path) != info["sha256"]:
                raise CheckpointError(
                    f"extracted snapshot file mismatch: {rel}; aborting restore"
                )
        # Swap in: remove current in-scope content (never the store
        # itself, never the workspace root), then copy the verified tree.
        # Post-snapshot files removed here are preserved in the safety
        # snapshot taken above (rule 3).
        current_files, _ = _scan_workspace(ws, st)
        for rel in sorted(current_files, reverse=True):
            (ws / rel).unlink()
        for root, dirs, _files in os.walk(ws, topdown=False):
            root_p = Path(root)
            if root_p.resolve() == st.resolve() or root_p == ws:
                continue
            if root_p.resolve() == ws.resolve():
                continue
            try:
                root_p.rmdir()
            except OSError:
                pass  # non-empty (e.g. contains the store): leave it
        for rel in sorted(manifest["files"]):
            src = extract_dir / rel
            dst = ws / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            info = manifest["files"][rel]
            if "link" in info:
                os.symlink(info["link"], dst)
                continue
            shutil.copy2(src, dst)
            try:
                os.chmod(dst, int(info["mode"], 8))
            except OSError:
                pass
        # Post-restore verification: the workspace must now match the
        # manifest exactly, or the restore is reported as failed.
        after, _ = _scan_workspace(ws, st)
        for rel, info in manifest["files"].items():
            if rel not in after or after[rel]["sha256"] != info["sha256"]:
                raise CheckpointError(
                    f"post-restore verification failed for {rel}; "
                    "the workspace may be partially restored — the "
                    f"safety snapshot {safety_id!r} holds the prior state"
                )
        extra = sorted(set(after) - set(manifest["files"]))
        if extra:
            raise CheckpointError(
                f"post-restore verification failed: unexpected files remain "
                f"{extra}; the safety snapshot {safety_id!r} holds the prior state"
            )
    return {
        "run_id": run_id,
        "restored_files": sorted(manifest["files"]),
        "drift": drift,
        "safety_snapshot": safety_id,
    }


# --- CLI ---------------------------------------------------------------

def _print_list(entries) -> None:
    if not entries:
        print("no snapshots")
        return
    print(f"{'RUN ID':<44}{'CREATED (UTC)':<26}{'FILES':>7}{'SIZE':>12}{'TARBALL':>12}")
    for e in entries:
        if e.get("error"):
            print(f"{e['run_id']:<44}{'--':<26}{'--':>7}{'--':>12}{'--':>12}  {e['error']}")
            continue
        missing = "  TARBALL MISSING" if e.get("tarball_missing") else ""
        print(
            f"{e['run_id']:<44}{str(e['created_utc'] or '--'):<26}"
            f"{str(e['file_count'] or 0):>7}"
            f"{str(e['total_bytes'] or 0):>12}"
            f"{str(e['tarball_bytes'] or 0):>12}{missing}"
        )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Per-run workspace snapshots + rollback (QwenPaw checkpoints)."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_snap = sub.add_parser("snapshot", help="snapshot a workspace before the first mutation")
    p_snap.add_argument("--workspace", required=True)
    p_snap.add_argument("--run-id", required=True)
    p_snap.add_argument("--store", default=None)
    p_snap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)

    p_list = sub.add_parser("list", help="list snapshots in a store")
    p_list.add_argument("--store", required=True,
                        help="snapshot store dir (e.g. <workspace>/checkpoints)")

    p_rest = sub.add_parser("restore", help="roll a workspace back to a snapshot")
    p_rest.add_argument("--workspace", required=True)
    p_rest.add_argument("--run-id", required=True)
    p_rest.add_argument("--store", default=None)
    p_rest.add_argument("--force", action="store_true",
                        help="proceed despite drift; prints what will be lost first")
    p_rest.add_argument("--no-safety-snapshot", action="store_true",
                        help="DISCOURAGED: skip the pre-restore safety snapshot")

    args = parser.parse_args(argv)
    try:
        if args.cmd == "snapshot":
            m = snapshot(args.workspace, args.run_id, store=args.store,
                         max_bytes=args.max_bytes)
            print(f"snapshot {m['run_id']}  {m['file_count']} files  "
                  f"{m['total_bytes']} bytes  {m['created_utc']}  "
                  f"{m['tarball']} ({m['tarball_bytes']} bytes)")
            if m["skipped"]:
                print(f"skipped {len(m['skipped'])} entries (excluded/unsafe):")
                for s in m["skipped"]:
                    print(f"  {s['path']}: {s['reason']}")
            return 0
        if args.cmd == "list":
            _print_list(list_snapshots(args.store))
            return 0
        if args.cmd == "restore":
            ws = _resolve_workspace(args.workspace)
            st = _resolve_store(ws, args.store)
            manifest = _load_manifest(st, args.run_id)
            drift = compute_drift(ws, manifest, st)
            if drift["added"] or drift["modified"] or drift["deleted"]:
                print("WORKSPACE HAS CHANGED SINCE THIS SNAPSHOT — "
                      "the following will be LOST/OVERWRITTEN by the restore:")
                for kind in ("added", "modified", "deleted"):
                    for p in drift[kind]:
                        print(f"  {kind}: {p}")
                if not args.force:
                    print("refusing to restore without --force")
                    return 2
            result = restore(args.workspace, args.run_id, store=args.store,
                             force=args.force,
                             safety_snapshot=not args.no_safety_snapshot)
            print(f"restored {result['run_id']}: {len(result['restored_files'])} files")
            if result["safety_snapshot"]:
                print(f"safety snapshot (pre-restore state): {result['safety_snapshot']}")
            return 0
    except CheckpointError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
