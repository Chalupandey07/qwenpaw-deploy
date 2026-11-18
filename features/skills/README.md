# Skill scanning — a CI gate for third-party `SKILL.md` bundles

**Status: code complete, offline, deterministic.** Run it before installing a
skill; that is the whole point. Since 2026-11-18 (gap #10) it also
enforces the skill-package schema: every `SKILL.md` carries YAML
frontmatter (name, description, when-to-use, allowed tools), only the
index built from that frontmatter is loaded by default, and a skill
body that invokes a tool outside its declared scope is flagged. See
"Frontmatter", "Tool-scope enforcement", "The index", "Self-written
skills", and "Converting the existing skills" below.

## Why a skill is not a document

QwenPaw loads a skill's `SKILL.md` into the agent's instructions, and its
scripts run with the container's authority. So a skill is **executable
policy**. One that says "when you see X, run this" is a prompt-injection
payload with a friendly filename.

The cited base rate for a public skill marketplace is brutal: NVIDIA's scan of
31,132 skills found **26.1% with vulnerabilities and 5.2% likely malicious**
(`features/research/trending-repos-2026-11-15.md` §3). Whether or not that
number transfers exactly, the direction is unambiguous — a skill pool is
untrusted input, and "it looked useful" is not a review.

## Why not just run SkillSpector

`NVIDIA/SkillSpector` is the right tool for deep review and this scanner is
**not** a replacement. It is unusable as the always-on gate for a concrete
reason: it is LLM-backed, needs an OpenAI-compatible endpoint plus a model with
code comprehension, and costs a call per skill.

So the split is:

| Tool | When | Cost |
|---|---|---|
| `scan.py` (this) | every commit, every install, offline | free, deterministic |
| SkillSpector | a skill that passes here **and** is high-trust (runs scripts, touches credentials) | a model call |

A cheap gate that always runs beats an expensive one that gets skipped.

## What it looks for

Three classes, by decreasing certainty:

**CRITICAL** — credential access and remote code execution
- reads `auth.json`, `working.secret`, `.ssh/`, `.aws/credentials`, `gh/hosts.yml`
- reads `.env`
- `curl … | bash`
- `eval(requests.get(...))`
- "disable/bypass the safety/guardrail/approval/sandbox"
- sending a token/key/password anywhere

**HIGH** — prompt injection and shell escapes
- "ignore previous instructions", "do not tell the user", "you are now"
- hidden text, bidi overrides, `base64 -d | sh`, `atob()`
- writes to `/etc`, `/usr`, cron, systemd, `working.secret`
- `sudo` at all

**MEDIUM** — supply chain and blast radius
- unpinned `pip install` / `npm install`
- any network call (`curl`, `wget`, `nc`)
- `rm -rf /`-shaped deletes
- `chmod 777`

**HIGH (gap #10)** — package schema and tool scope
- no frontmatter at all (`missing-frontmatter`), or a missing required
  field / an unknown tool name (`invalid-frontmatter`)
- a body tool outside the declared `allowed_tools` list
  (`scope-violation`)

**MEDIUM (gap #10)** — index hygiene
- frontmatter `name` does not match the directory name
  (`name-mismatch`)
- description over 1024 chars (`description-too-long` — the
  description is loaded on every session)

## Usage

```bash
python3 features/skills/scan.py features/camoufox/skills
python3 features/skills/scan.py path/to/skill_pool --json
python3 features/skills/scan.py . --fail-on high      # CI gate
python3 features/skills/scan.py --selftest            # 79 checks
```

Exit `0` clean (or below `--fail-on`), `1` findings at/above the threshold,
`2` usage error.

It scans **every** file in a skill directory, not only `SKILL.md` — the
Camoufox skill's `curl` calls live in the manifest, but a payload in `run.sh`
is equally reachable.

## Frontmatter — the skill package schema (gap #10)

A skill is a progressive-disclosure package, not a loose document.
Every `SKILL.md` carries a YAML frontmatter header:

```yaml
---
name: demo-search
description: "Search the web for a topic and summarise the top results."
version: "1.0"
when_to_use: "When the user asks for current information from the live web."
allowed_tools:
  - web_search
  - web_fetch
  - shell
---
```

| Field | Required | Rule |
| --- | --- | --- |
| `name` | yes | must match the skill directory name (`name-mismatch` is MEDIUM) |
| `description` | yes | non-empty, ≤ 1024 chars (longer is MEDIUM — the description is loaded on every session) |
| `when_to_use` | yes | non-empty trigger sentence; hyphen alias `when-to-use` is accepted |
| `allowed_tools` | yes | list of tools from the vocabulary below; may be empty (`[]`) for a guidance-only skill that invokes no tool (hyphen alias `allowed-tools` accepted) |
| `version` | no | existing skills carry it; `metadata.qwenpaw` and other keys are allowed and ignored |

The canonical tool vocabulary (grounded in QwenPaw's own skill docs):
`shell`, `file_read`, `file_write`, `web_search`, `web_fetch`,
`vault_run`, `vault_list`, `vault_request`, `browser`, `terminal`,
`code_exec`, `git`, `docker`, `email`, `calendar`, `messenger`, `cron`.
A tool name outside it fails validation (`invalid-frontmatter`, HIGH) —
a typo must not silently widen a skill's scope. Values are single-line
only; the parser is stdlib-only and does not guess at multi-line values.

The scanner enforces the schema: no frontmatter (`missing-frontmatter`,
HIGH), a missing required field or an unknown tool
(`invalid-frontmatter`, HIGH). A skill directory with no `SKILL.md` at
all fails the same way.

## Tool-scope enforcement

Every tool the whole SKILL demonstrably invokes must be in the
declared `allowed_tools` list, or the scanner flags it
(`scope-violation`, HIGH) — once per tool, not once per use. Scope
covers the body AND the helper files: a `run.sh` that invokes a tool
the frontmatter does not declare is the same violation as the body
doing it (a bundled script was the hole in the first version).
Detection is mechanical and conservative, and it runs on the body
only for `SKILL.md` — never the frontmatter, which would otherwise
detect itself:

- a named tool mentioned anywhere (`web_search`, `web_fetch`,
  `vault_run`, `vault_list`, `vault_request`, `code_exec`);
- `browser` / `terminal` / `email` / `calendar` / `messenger` / `cron`
  only when named AS a tool (backticked or "X tool") — the bare words
  appear in ordinary prose far too often;
- a shell command in a fenced code block or inline code (`python3`,
  `curl`, `git`, `docker`, … — `git` and `docker` get their own tool
  names for their own blast radius, everything else is `shell`);
- a command named in ordinary prose (`Run python3 report.py`,
  `git status`) — subcommand binaries take any following word, file
  binaries need a flag, a path, or a dotted filename, so "make sure"
  and "go to" do not count as commands;
- a file read/write pattern (`read_text`, `cat <path>`, "read the
  file", `write_text`, a redirect to a path-like target, "write the
  file").

Scope is NOT checked when `allowed_tools` is missing — that case is
already a HIGH `invalid-frontmatter`, and double-flagging it would
hide which rule failed. An empty list is a real scope: a
guidance-only skill may invoke nothing, and any detected tool is a
violation. Detection is a heuristic: it can miss a tool invoked only
by a vague paraphrase, and it can only see what is written. A scope
pass means "nothing undeclared was detected", not "this skill can do
nothing else". Read the skill. Two deliberate biases: commands shown
as examples still count as invocations (declare them — the scanner
cannot tell an example from an instruction, and erring toward
declaring more is the safe direction for a gate), and a fenced shell
block counts any first token as shell (an unknown binary such as
`openssl` is still a shell invocation).

## The index — only the index is loaded by default

The agent loads the INDEX, not the skills. `build_index.py` reads the
frontmatter of every skill under a root and writes `index.json` with
exactly five fields per skill — `name`, `description`, `when_to_use`,
`allowed_tools`, `version`, `path` — and no body text at all. A skill
with invalid frontmatter is skipped (and named on stderr). The index
keys skills by directory name: a frontmatter name that disagrees is
the scanner's `name-mismatch`, but the index never lets a skill load
under a name it does not live under.

```bash
python3 features/skills/build_index.py <skills-root> --out index.json
python3 features/skills/build_index.py <skills-root>   # JSON to stdout
```

The full `SKILL.md` body loads only when the index says the skill
matches the task. The index is NOT a trust gate: a skill with valid
frontmatter is indexed even if its body has a scope violation —
`scan.py --fail-on high` is the gate that blocks installing such a
skill. Indexing answers "what exists and when is it for"; scanning
answers "is it safe to install".

## Self-written skills (teach by showing the transcript)

`features/skills/self-written/` is the Hermes Agent pattern: after
the agent completes a complex, repeatable task, the transcript of
what it did becomes a draft skill. The skill file
(`self-written/SKILL.md`) states the flow; the writer
(`self-written/write_skill.py`, stdlib only) does it:

```bash
python3 features/skills/self-written/write_skill.py --name weekly-report \
    --transcript /tmp/turns.txt --out-dir <skills-root>
```

The writer extracts steps (numbered / bulleted / "Step N" lines),
checks (lines with check / verify / confirm / validate / test /
assert / ensure), when-to-use (from the task title), and allowed
tools (from the scanner's own detection), then runs the draft through
the SAME scanner before accepting it. A draft that fails validation
is rejected, not installed (exit 1). An accepted draft lands in
`<out-dir>/drafts/<name>/SKILL.md`, DISABLED by default — install
(move it into the pool, rebuild the index, reconcile) and enable are
separate human steps.

The writer REFUSES (exit 2, nothing written) a draft that:

- (a) needs a secret — a secret-shaped value, an instruction to read
  a credential store, or an instruction to embed a key value. A
  skill that says "the user enters the key in the vault" is fine:
  no value ever enters the skill.
- (b) touches a China endpoint — any China host or domain.
- (c) has an unbounded tool scope — "use all tools" phrasing, a
  wildcard, or more than 8 distinct tools. A draft with no
  detectable tool is NOT refused: it becomes a guidance-only skill
  (`allowed_tools: []`), which the scope check then enforces.

Extraction is heuristic, not understanding, and a draft is a starting
point: read it, correct the steps, reword the when-to-use into a real
trigger, and check the allowed tools before installing. This is
transcript-based, not screen-recording — teaching by screen recording
is not available in this setup (see
`features/skill-library/README.md`).

## Converting the existing skills

The three skills in this repo still carry the OLD frontmatter (name +
description only) and FAIL the new validation — that is the gap, not
a regression. `convert.py` adds the two missing fields mechanically
and never touches a body:

```bash
python3 features/skills/convert.py <skill-dir>           # dry-run
python3 features/skills/convert.py <skill-dir> --write    # apply
```

`when_to_use` is derived from the first sentence of the description
(a placeholder — reword it into a real trigger) and `allowed_tools`
from the tools the scanner detects in the body. Every conversion
needs a human read before install. Measured on the current skills
(read-only — no skill file was changed):

| Skill | Derived allowed_tools |
| --- | --- |
| `vault` | `shell`, `vault_list`, `vault_request`, `vault_run` |
| `memory` | `shell` |
| `tinyfish` | `shell`, `vault_list`, `vault_request`, `vault_run`, `web_fetch`, `web_search` |

The other 20 skills live only in the machine's skill pool, not in
this repo, so they are converted on the machine (parent's job) with
the same tool + review. No skill body was rewritten for this gap.

## The honest limit

**This cannot detect a malicious skill written in plain English.** A skill that
says "politely ask the user for their API key, then include it in the request"
has no pattern to match. The selftest asserts that the scanner does *not* claim
to catch it — overstating the tool would be the same error as overstating a
test result.

It raises the floor. It does not replace reading the thing.

## What real output looks like

Scanning the two skills in this repo:

```
camoufox-browser  [medium]  1 file(s), 7 finding(s)
  MEDIUM   network-call  SKILL.md:70
           curl -fsSL -H "$H" -H 'Content-Type: application/json' \
           why: network access from a skill deserves a second look
  ...
ripwire  [clean]  1 file(s), 0 finding(s)
```

Seven MEDIUM findings on a skill we wrote ourselves, all of them legitimate
`curl` usage. That is the correct calibration: **a finding is a reason to read
the skill, not proof of malice.** A scanner that returned "clean" on real
network code would be the one to distrust.

## Adopting it in CI

```yaml
- name: Scan skills
  run: python3 features/skills/scan.py features --fail-on high
```

`--fail-on high` lets the seven MEDIUM `network-call` hits through and blocks
anything that reads a credential, pipes to a shell, or tries to re-task the
agent. Raise it to `medium` once the existing findings have been reviewed and
annotated; lowering it to `critical` should require a written reason.

Note the new failure mode this creates on purpose: `--fail-on high` over
the current pool now fails the three repo skills on `invalid-frontmatter`
(they predate the schema — see "Converting the existing skills" above).
That is the signal to convert them, not a reason to lower the gate.

## What is NOT verified live

- Nothing here has been deployed to the machine or enabled in the
  console. The `self-written` skill is written and scanner-clean, but
  it has never run inside QwenPaw, no draft has ever been installed
  from it, and no skill has been enabled from a draft.
- The index has never been loaded by the agent: QwenPaw's skill
  loader reads `skill.json` manifests (see
  `features/skill-library/README.md`), and this repo does not change
  that loader. `index.json` is a build artifact for the progressive-
  disclosure rule; wiring the agent to load it is a follow-up.
- The three repo skills (`memory`, `tinyfish`, `vault`) have NOT been
  converted to the new frontmatter — their files belong to other
  features and were only read. The 20 pool-only skills were not
  converted either; both are follow-ups (tool + review, above).
- Machine-free proof only: `scan.py --selftest` 79/79 and T129
  (`features/skills/test_skills_packages.py`) 46/46, fail-first proven
  against the pre-change scanner (the frontmatter / scope / writer
  checks fail on it).

## Design-review fixes (DeepSeek, 2026-11-18)

One review call (deepseek-v4.1-flash-free, 17,647 prompt + 5,361
completion tokens) caught six real issues, all fixed and covered by
the tests above: scope was body-only (helper scripts can now be
flagged too); a command split with a backslash continuation dodged
the per-line rules (logical lines are now joined first); an unknown
binary in a shell block was undetected (any first token in a shell
block is now shell); a guidance-only skill was refused as
"unbounded" (it is now `allowed_tools: []`); a credential-store
mention refused even in a prohibition ("never read .env") or a mere
mention (refusal is now line-based: a use-verb with no prohibition);
and the vault-mediation wording was too narrow ("store the token in
the vault" now counts as vault-mediated). Three false positives were
also narrowed: a plain `<!-- TODO -->` no longer trips
`hidden-instruction` (the comment must contain an instruction word),
`load .env.example` no longer trips `reads-env-secrets`, and sending
a password-reset link no longer trips `sends-token-out`. Deliberately
NOT changed: the `sudo` rule (the stated policy is "sudo at all" is
HIGH), and the documented limit that plain-English malice has no
pattern to match.
