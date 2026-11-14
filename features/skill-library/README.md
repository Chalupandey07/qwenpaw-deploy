# Skill library (#13)

The shared skill pool plus the convention for saving a new skill.
Live library page: `https://qwenpaw-pages.pages.dev/skills/`
(source: `index.html` in this folder).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Static library page listing every skill in the pool with its purpose. Regenerate after adding a skill. |
| `README.md` | This convention (verified against the real QwenPaw v2.3.0 source and manifests on 2026-11-15). |

## Where skills live (verified)

There are two skill stores on the machine, both under
`/data/home/qwenpaw/working/`:

| Store | Path | Manifest | Scope |
| --- | --- | --- | --- |
| Shared pool | `working/skill_pool/<name>/SKILL.md` | `working/skill_pool/skill.json` | Every agent/workspace |
| Workspace | `working/workspaces/<id>/skills/<name>/SKILL.md` | `working/workspaces/<id>/skill.json` | One agent (e.g. `default`) |

A skill is a directory containing at least a `SKILL.md`. Optional
`references/` and `scripts/` subfolders hold supporting files, as in the
built-in `make-skill` skill. Extra read-only skill roots can be added via
the `skill_paths` setting in `config.json` (currently empty) — do not
edit `config.json` by hand.

## Skill file format (verified)

`SKILL.md` starts with YAML frontmatter, then Markdown. Example
(from the built-in `mailbox` skill):

```yaml
---
name: mailbox
description: "Use this skill whenever the user needs ANY mailbox/email operation ..."
metadata:
  builtin_skill_version: "1.3"
  qwenpaw:
    emoji: "📧"
    requires:
      mcp: ["qwenpawmail"]
---
```

For a custom skill use `version: "1.0"` in the frontmatter (top level)
instead of `builtin_skill_version`. Requirements live under
`metadata.qwenpaw.requires` with the keys `bins`, `env`, `mcp`
(all lists of strings). They land in the manifest as
`requirements: {require_bins, require_envs, require_mcps}`.
The version is read from frontmatter `version`, then
`metadata.version`, then `metadata.builtin_skill_version`.

## How a new skill gets registered (verified in source)

**Do not hand-edit `skill.json`.** QwenPaw owns both manifests. The
flow is (source: `agents/skill_system/store.py`,
`agents/skill_system/registry.py`, `cli/skills_cmd.py`):

1. Write the skill directory with its `SKILL.md` into the pool and/or
   the workspace skills directory.
2. Reconcile. Either run inside the container:
   - `qwenpaw skills list --pool` — reconciles the pool manifest
   - `qwenpaw skills list` — reconciles the `default` workspace manifest
   - or `POST /api/skills/pool/refresh` on the console API
   - or use the Console UI skill list (same reconcile path)
3. Reconcile scans the directories for folders containing `SKILL.md`
   and rebuilds each manifest entry from the real files. A new
   non-builtin skill is recorded with `source: "customized"`.
   Entries whose directory no longer exists are removed.
4. Verify: the skill appears in `qwenpaw skills list --pool` (or the
   workspace list) with source `customized`.

The pool manifest format (`skill_pool/skill.json`, verified live):

```json
{
  "schema_version": "skill-pool-manifest.v1",
  "version": 1794679964902,
  "skills": {
    "build-page": {
      "name": "build-page",
      "description": "...",
      "version_text": "1.0",
      "emoji": "🌐",
      "commit_text": "",
      "source": "customized",
      "protected": false,
      "requirements": {"require_bins": ["python3", "curl"], "require_envs": ["CLOUDFLARE_API_TOKEN"], "require_mcps": []},
      "updated_at": "2026-11-15T...Z",
      "external": false
    }
  },
  "builtin_skill_names": ["QA_source_index", "browser", "..."]
}
```

The workspace manifest (`<workspace>/skill.json`) uses schema
`workspace-skill-manifest.v1`; each entry additionally carries
`enabled` (bool), `channels` (e.g. `["all"]`), `preload` (bool),
`config` (object) and `installation_origin`. A workspace skill only
runs for that agent when `enabled` is true. Enable it in the Console
UI or with `qwenpaw skills enable <name>` inside the container.

## The `/make-skill` flow (the bot's own way to save a skill)

The built-in `make-skill` skill (v2.3) is the sanctioned in-chat path:
the user says "save this as a skill", the bot drafts a plan, the user
approves it, then the bot writes the package, validates it and
publishes it to `<workspace>/skills/`. A skill published this way is
a workspace skill; promote it to the shared pool by copying its
directory into `working/skill_pool/` and reconciling (above).

## Teach-by-showing: not available

Teach-by-showing — the bot learning a skill by watching the user do
something on screen (screen recording / live-computer demonstration) —
**is not available in this setup**. It depends on the live-computer
feature (the machine's computer-use/desktop capability), which is not
installed here; the cleanup on 2026-11-15 also removed the Chromium
and Node tooling that feature relied on. Do not promise it to the user.
The available ways to teach the bot are the ones above: `/make-skill`,
or writing a `SKILL.md` by hand.

## Regenerating the library page

`index.html` is a static snapshot, not live data. After adding or
removing a skill:

1. Re-dump the pool manifest (from the container):
   `docker exec qwenpaw python3 -c "import json; m=json.load(open('/app/working/skill_pool/skill.json')); ..."`
   (or read `skill.json` and take name/description/version/emoji/source
   per skill).
2. Rebuild the table in `index.html` and bump the generated date.
3. Redeploy the whole `qwenpaw-pages` site with
   `features/botpages/deploy-page.py` (the library page is served at
   `/skills/`).

## Current contents (2026-11-15)

15 built-in skills (browser, channel_message, chat_with_agent, cron,
docx, file_reader, guidance, mailbox, make-skill, make_plan,
multi_agent_collaboration, pdf, pptx, QA_source_index, xlsx) and
2 custom skills (build-page, github). The library page lists all 17.
