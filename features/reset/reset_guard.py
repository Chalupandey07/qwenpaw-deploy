"""Settings Reset — allowlist / never-delete guard (pure functions, no I/O
beyond the filesystem checks themselves).

Three layers, no denylist anywhere:
  1. The route accepts a category enum only; zero client path input.
  2. This module: every target is realpath-resolved and must be under the
     reset root, free of symlinks at any component, not a mount point, and
     not equal to nor under any PROTECTED entry. Anything outside the
     literal category list is undeletable by construction.
  3. Kernel: the systemd unit sets ProtectSystem=strict + ReadWritePaths
     to the allowlist roots only.

A violation aborts the WHOLE run (fail-closed), never just the one path.
"""

import os

# Paths relative to RESET_ROOT that are never deletable, even if a category
# somehow listed them. A trailing "/" means "this directory and everything
# under it". Checked before every category.
PROTECTED = [
    "working.secret/auth.json",
    "working.secret/vault-broker.token",
    "working.secret/reset-broker.token",
    "working.secret/chatgpt/",
    "working.secret/providers/builtin/kilo.json",
    "working.secret/providers/active_model.json",
    "working/governance/audit.db",
    "working/logs/reset.log",
    "vault/",
    "sleepwake/",
    "codemode/",
    "computer/",
    "reset/",
    "terminal-server.py",
    "docker-compose.yml",
]

# Any path component with one of these names is protected, anywhere.
PROTECTED_NAMES = {".git", "shadow.git", "media"}

# A file whose basename starts with this is protected, anywhere (.env, .env.bak).
PROTECTED_BASENAME_PREFIX = ".env"

# Any file with this suffix at the reset-root level is protected.
PROTECTED_ROOT_SUFFIX = ".service"


def _relpath(root, path):
    """Path relative to root, or None if it escapes the root."""
    root_real = os.path.realpath(root)
    path_real = os.path.realpath(path)
    if path_real == root_real:
        return ""
    if path_real.startswith(root_real + os.sep):
        return path_real[len(root_real) + 1:]
    return None


def is_protected(root, path):
    """True if the path is never deletable. Pure path logic (no I/O except
    realpath, which does not touch the target)."""
    rel = _relpath(root, path)
    if rel is None:
        return True  # escapes the root: protected by definition
    if rel == "":
        return True  # the root itself
    parts = rel.split(os.sep)
    # Protected names anywhere in the path.
    if any(p in PROTECTED_NAMES for p in parts):
        return True
    # .env* files anywhere.
    if any(p.startswith(PROTECTED_BASENAME_PREFIX) for p in parts):
        return True
    # *.service at the root level.
    if len(parts) == 1 and parts[0].endswith(PROTECTED_ROOT_SUFFIX):
        return True
    # Literal protected entries (file or dir prefix).
    for entry in PROTECTED:
        if entry.endswith("/"):
            if rel == entry[:-1] or rel.startswith(entry):
                return True
        elif rel == entry:
            return True
    return False


def _has_symlink_component(root, path):
    """True if any component of path (from root down, including the target
    itself) is a symlink. Uses lstat, so a symlink is seen, not followed."""
    root_real = os.path.realpath(root)
    path_abs = os.path.abspath(path)
    # Walk from the root down to the target.
    rel = os.path.relpath(path_abs, root_real)
    if rel.startswith(".."):
        return True  # outside the root: treat as a violation
    cur = root_real
    for part in rel.split(os.sep):
        if part in ("", "."):
            continue
        cur = os.path.join(cur, part)
        try:
            if os.path.islink(cur):
                return True
        except OSError:
            return True  # cannot stat: fail closed
    return False


def check_target(root, target):
    """Validate one target. Returns (ok, reason). reason is "" when ok.

    target is a tuple from reset_categories: ("delete"|"truncate"|"db_clear",
    path) or ("section", path, heading). Only the path is checked here.
    """
    kind = target[0]
    path = target[1]
    if kind not in ("delete", "truncate", "db_clear", "section"):
        return False, "unknown_target_kind: %s" % kind
    # The path must exist (the categories module already filters, but a
    # race between preview and execute must fail closed, not delete blindly).
    if not os.path.lexists(path):
        return False, "not_found: %s" % path
    if os.path.ismount(path):
        return False, "mount_point: %s" % path
    if _has_symlink_component(root, path):
        return False, "symlink_component: %s" % path
    if _relpath(root, path) is None:
        return False, "outside_root: %s" % path
    if is_protected(root, path):
        return False, "protected: %s" % path
    return True, ""


def validate_targets(root, targets):
    """Validate every target. Raises ValueError naming the first violation.
    Call this before ANY deletion; a violation aborts the whole run."""
    for t in targets:
        ok, reason = check_target(root, t)
        if not ok:
            raise ValueError("path_not_allowed: %s" % reason)
