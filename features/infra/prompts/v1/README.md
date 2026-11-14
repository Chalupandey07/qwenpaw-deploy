# Prompts v1 — versioned system prompts

Snapshot date: 2026-11-15. Source: live workspace
`/data/home/qwenpaw/working/workspaces/default/` on machine
`m_agq5wqqo2fvypym7rjlpvngc2m` (read-only copy; the live files were not
modified). QwenPaw `agentscope/qwenpaw:v2.3.0`.

## What is versioned here

| File | Live source | Notes |
|------|-------------|-------|
| `SOUL.md` | `workspaces/default/SOUL.md` | 1,679 bytes at snapshot |
| `PROFILE.md` | `workspaces/default/PROFILE.md` | 726 bytes; Rohan Samanta / QwenPaw |
| `AGENTS.md` | `workspaces/default/AGENTS.md` | 1,870 bytes; includes heartbeat block |
| `HEARTBEAT.md` | `workspaces/default/HEARTBEAT.md` | 171 bytes |

The second workspace, `QwenPaw_QA_Agent_0.2` (`template_id: "qa"`), uses
the stock QwenPaw QA template; its SOUL.md begins identically to the
default template. It is not duplicated here — only the default agent's
prompts are versioned, because that is the agent the user talks to.

## Versioning rules

- These files are the **record**, not the live config. Editing a file here
  does nothing to the running agent.
- To change a prompt: edit the live file on the machine (via the console
  or an approved change), then copy the new live file here as `v2/` (new
  directory, never overwrite `v1/`), with a one-line note of what changed
  and why. Git history then shows every prompt version.
- Never copy `MEMORY.md`, chats, or `history.db` into this repo — prompts
  only. `MEMORY.md` holds user data and stays on the machine.

## How evals tie in

`../evals/run-evals.py` + `../evals/cases.json` run fixed prompts against
the live agent and record pass/fail per prompt version. When prompts move
to `v2/`, re-run the evals and keep the results file next to the new
version so a regression is visible.
