"""Settings Reset — the category-to-paths table (pure data, no I/O).

This is THE allowlist. Deletion is allowlist-only: a path that matches no
category row is never removed. There is no denylist anywhere.

Glob root W = working/workspaces/* (every agent workspace: default,
QwenPaw_QA_Agent_0.2, and any future one). RESET_ROOT is /data/home/qwenpaw
on the machine; the harness passes a tmpdir.

Each category returns a list of targets. A target is one of:
  ("delete", path)    — remove the file or directory tree.
  ("truncate", path)  — truncate the file in place (same inode), write "{}".
  ("db_clear", path)  — logical clear of a sqlite DB (DELETE FROM each table,
                        keep the inode, never unlink). See README §Chats.
  ("section", path, heading) — rewrite one markdown section in place
                        (heading … next heading), no file deletion.

Categories never overlap: Workspaces is shell-only and never implies
Memories/Skills/Chats/Sessions. Lessons is a section rewrite inside
MEMORY.md; if Memories is also selected, the MEMORY.md file delete wins and
the section rewrite is skipped (reported as superseded_by_memories).

Models is fail-closed: it never rewrites active_model.json and never deletes
the active provider's JSON. The caller passes active_provider_id (read from
working.secret/providers/active_model.json); custom provider JSONs for any
other provider are deletable. This respects the workspace MEMORY.md
preference "No Kilo default model" — Kilo is never the fallback.
"""

import glob
import os

# Category ids in UI order. The broker accepts ONLY these.
CATEGORY_IDS = [
    "memories",
    "skills",
    "lessons",
    "models",
    "logs",
    "sessions",
    "chats",
    "workspaces",
    "backups",
]

CATEGORIES = {
    "memories": {
        "label": "Memories",
        "warning": "Erases the agent's long-term memory files.",
    },
    "skills": {
        "label": "Skills",
        "warning": "Removes all workspace skills and the shared skill pool. Built-in skills are unaffected.",
    },
    "lessons": {
        "label": "Lessons",
        "warning": "Clears the 'Important decisions and lessons' section of MEMORY.md.",
    },
    "models": {
        "label": "Models",
        "warning": "Removes custom providers except the active one. The active model is never changed.",
    },
    "logs": {
        "label": "Logs",
        "warning": "Deletes the QwenPaw log. The reset audit trail is never deleted.",
    },
    "sessions": {
        "label": "Sessions",
        "warning": "Removes saved agent sessions and channel state.",
    },
    "chats": {
        "label": "Chats",
        "warning": "Deletes ALL conversation history. Irreversible.",
    },
    "workspaces": {
        "label": "Workspaces",
        "warning": "Removes workspace shell files (config, docs, screenshots). Does NOT touch memory, skills, chats or sessions.",
    },
    "backups": {
        "label": "Backups",
        "warning": "Removes your only rollback copies. Regenerable only by re-running the work.",
    },
}

LESSONS_HEADING = "## Important decisions and lessons"

# Files/dirs inside a workspace that belong to the Workspaces shell category.
_WORKSPACE_SHELL_FILES = [
    "agent.json", "AGENTS.md", "BOOTSTRAP.md", ".bootstrap_completed",
    "CONTACTS.md", "MAIL_TRIAGE.md", "PROFILE.md", "SOUL.md",
    "HEARTBEAT.md", "jobs.json",
]
_WORKSPACE_SHELL_DIRS = ["resource", "drivers", "digest", "checkpoints"]

# Memory subdirs (mem_metadata is only partly deletable — see below).
_MEM_METADATA_SUBDIRS = ["file_catalog", "file_graph", "file_store", "keyword_index"]


def workspace_dirs(root):
    """All agent workspaces, sorted. Missing dir -> []."""
    base = os.path.join(root, "working", "workspaces")
    if not os.path.isdir(base):
        return []
    return sorted(
        os.path.join(base, name)
        for name in os.listdir(base)
        if os.path.isdir(os.path.join(base, name))
    )


def _existing(targets):
    """Only targets whose path exists (preview/report counts real files,
    not wishes). Targets are tuples; the path is element [1]."""
    return [t for t in targets if os.path.lexists(t[1])]


def targets_for(root, category_id, active_provider_id=None):
    """Targets for one category. Raises ValueError on unknown category."""
    if category_id not in CATEGORIES:
        raise ValueError("unknown_category: %s" % category_id)
    ws = workspace_dirs(root)
    working = os.path.join(root, "working")
    secret = os.path.join(root, "working.secret")
    targets = []

    if category_id == "memories":
        for w in ws:
            targets += [
                ("delete", os.path.join(w, "MEMORY.md")),
                ("delete", os.path.join(w, "memory")),
                ("delete", os.path.join(w, "mem_session")),
                ("delete", os.path.join(w, "mem_agent")),
            ]
            for sub in _MEM_METADATA_SUBDIRS:
                targets.append(("delete", os.path.join(w, "mem_metadata", sub)))

    elif category_id == "skills":
        for w in ws:
            targets += [
                ("delete", os.path.join(w, "skill.json")),
                ("delete", os.path.join(w, "skills")),
            ]
        targets.append(("delete", os.path.join(working, "skill_pool")))

    elif category_id == "lessons":
        for w in ws:
            targets.append(("section", os.path.join(w, "MEMORY.md"), LESSONS_HEADING))

    elif category_id == "models":
        custom = os.path.join(secret, "providers", "custom")
        if os.path.isdir(custom):
            for name in sorted(os.listdir(custom)):
                if not name.endswith(".json"):
                    continue
                provider_id = name[:-5]
                if provider_id == active_provider_id:
                    continue  # never delete the active provider
                targets.append(("delete", os.path.join(custom, name)))

    elif category_id == "logs":
        targets.append(("delete", os.path.join(working, "qwenpaw.log")))
        for p in sorted(glob.glob(os.path.join(working, "qwenpaw.log.*"))):
            targets.append(("delete", p))

    elif category_id == "sessions":
        for w in ws:
            targets.append(("delete", os.path.join(w, "sessions")))
        targets.append(("delete", os.path.join(working, "channel_state")))

    elif category_id == "chats":
        for w in ws:
            targets += [
                ("db_clear", os.path.join(w, "history.db")),
                ("truncate", os.path.join(w, "chats.json")),
            ]

    elif category_id == "workspaces":
        for w in ws:
            for name in _WORKSPACE_SHELL_FILES:
                targets.append(("delete", os.path.join(w, name)))
            for name in _WORKSPACE_SHELL_DIRS:
                targets.append(("delete", os.path.join(w, name)))
            for p in sorted(glob.glob(os.path.join(w, "*.png"))):
                targets.append(("delete", p))
        targets += [
            ("delete", os.path.join(working, "jobs.json")),
            ("delete", os.path.join(working, "HEARTBEAT.md")),
            ("delete", os.path.join(working, "profile", "avatars.sqlite3")),
        ]

    elif category_id == "backups":
        targets.append(("delete", os.path.join(root, "working.backups")))

    return _existing(targets)


def all_targets(root, category_ids, active_provider_id=None):
    """Targets for several categories, deduplicated, in category order.

    Lessons is dropped (superseded) when Memories is also selected, because
    the MEMORY.md file delete wins over the section rewrite.
    """
    seen = set()
    out = []
    cats = list(category_ids)
    if "memories" in cats and "lessons" in cats:
        cats = [c for c in cats if c != "lessons"]
    for cid in cats:
        for t in targets_for(root, cid, active_provider_id):
            key = (t[0], t[1])
            if key in seen:
                continue
            seen.add(key)
            out.append((cid, t))
    return out


def lessons_superseded(category_ids):
    """True when Lessons was requested but Memories covers it."""
    return "memories" in category_ids and "lessons" in category_ids
