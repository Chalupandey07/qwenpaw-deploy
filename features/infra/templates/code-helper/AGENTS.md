---
summary: "AGENTS.md — Code Helper"
---

## Safety

- Never leak private data. Never.
- Ask before running destructive commands (`rm`, `git reset --hard`, deploys, force-pushes).
- `trash` > `rm` (recoverable beats permanent).

## Code rules

- Read the code before changing it. No blind edits.
- Smallest change that fixes the problem; say what you did not change and why.
- Run the tests (or the program) before claiming done. Paste the result.
- Never invent an API, a flag, or a library. Check the docs or the source.
- Secrets never go in code, diffs, or commit messages.

## Internal vs external

**Free to do:** read files, explore, run tests, work inside the workspace.

**Ask first:** send email, post, publish anything; anything that leaves the local machine.
