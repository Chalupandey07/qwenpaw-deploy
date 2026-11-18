---
name: self-written
description: "Draft a reusable skill from a task the agent just completed, by feeding the task transcript to the skill writer. The draft is validated by the same scanner as any hand-written skill before it is accepted, and it stays disabled until a human reviews and enables it."
version: "1.0"
when_to_use: "After the agent completes a complex, repeatable task and the user (or the agent) wants to keep how it was done as a reusable skill."
allowed_tools:
  - shell
  - file_read
  - file_write
---

# Self-written skills — teach by showing the transcript

After a complex task, the way it was done is worth keeping. This
skill turns a demonstrated task into a reusable skill package — the
Hermes Agent pattern: the agent writes a reusable skill after
completing a complex task, instead of every skill being hand-written
by a developer.

This is transcript-based, not screen-recording. The agent works from
the written record of what it did (steps taken, checks run). Teaching
by screen recording is not available in this setup (see
features/skill-library/README.md).

## When to draft a skill

Draft one when all three are true:

- The task is done and its result was verified.
- The task will recur in recognisably the same shape.
- The steps are specific enough to repeat (named files, exact
  commands, checks that prove each step).

Do NOT draft a skill for a one-off task, a task that only worked
because of a detail that will not recur, or a task whose steps you
cannot state plainly.

## The flow

1. Save the transcript of the completed task to a file — the turns
   as they happened, steps and checks included. Read the file first
   and remove anything that does not belong in a reusable skill.
2. Run the writer from the repo root:

```bash
python3 features/skills/self-written/write_skill.py --name <skill-name> --transcript /tmp/turns.txt --out-dir <skills-root>
```

The writer extracts steps, checks, when-to-use, and allowed tools
from the transcript and renders a SKILL.md draft.
3. The writer runs the draft through the scanner
   (`features/skills/scan.py`): frontmatter validation, tool-scope
   enforcement, and the security rules. A draft that fails is
   rejected, not installed — read the reason, fix the transcript
   or the task, and try again.
4. An accepted draft lands in `<skills-root>/drafts/<name>/`. Read
   it. Correct the steps, reword the when-to-use into a real trigger,
   and check the allowed tools list against what the skill really
   needs. A draft is a starting point, not a finished skill.
5. Install it by moving the directory into the skill pool, rebuild
   the index (`features/skills/build_index.py`), and reconcile the
   pool manifest. The skill is DISABLED by default until it is
   enabled — enabling is a separate human step.

## The three refusals

The writer refuses to draft a skill — exit code 2, nothing written —
when the transcript shows the skill would:

- need a secret: it holds a secret-shaped value, reads a credential
  store, or embeds a key value. Keys are entered by the user in the
  vault and used through it; a skill never holds or reads one. A
  skill that says "the user enters the key in the vault" is fine.
- touch a China endpoint: any China host or domain in the
  transcript. English only, no China endpoints or data.
- have an unbounded tool scope: "use all tools" phrasing, a
  wildcard, more than 8 distinct tools, or no detectable tool at
  all. A scope that cannot be bounded is not a scope.

A refusal is the writer doing its job. Do not reword the transcript
to dodge a refusal — that is the same failure with nicer phrasing.
If the task genuinely needs a secret or a wide scope, it is not a
skill; keep it as a runbook the agent follows with the user present.

## When to ask first

Ask the user before drafting a skill for a task they did not ask to
keep, before installing any draft, and before enabling any skill.
Drafting is cheap and reversible; installing and enabling change
what the agent can do, so those two steps are always the user's call.
If any step of the completed task is unclear in the transcript, ask
instead of guessing what it was.

## What this skill does NOT do

- It does not record the screen or watch the user work.
- It does not install, enable, or deploy anything by itself.
- It does not understand the task — extraction is mechanical
  (numbered and bulleted lines become steps, lines with check words
  become checks). A draft that reads wrong is wrong; fix it by hand.
