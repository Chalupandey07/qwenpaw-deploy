# AGENT-DESIGN.md — the best agent this system can be

This is the design answer to "make it the best agent", written against *this*
repo's real constraints: one paused VM, free quotas, one human, a real desktop
shared with an agent, cloud LLM only.

It is deliberately not a generic "agent architecture" essay. Every decision
below is one this deployment can actually implement, and most say which file
it lands in.

---

## 1. What makes an agent good here

Not "more autonomy". The failure modes in this repo's incident log are almost
all *the agent believing something that was not true*:

- reported an admin login worked when it did not;
- trusted `installed: true` while the binary was gone;
- trusted a minted token without decoding its payload;
- reported completion without a live check.

So the design principle is:

> **The agent's scarce resource is not tokens or turns. It is *trustworthy
> belief*.** Every mechanism below exists to make a true belief cheap and a
> false one expensive.

That gives five design pillars.

## 2. Pillar 1 — Ground truth before claims

**The rule:** a claim about system state must be produced by a check that can
fail, and the check must be named.

**In practice:**

| Claim | Must be produced by | Never by |
|---|---|---|
| "the desktop is live" | `__status` → `desktop:"up"` **and** the RFB probe | a screenshot alone |
| "Chromium is installed" | the binary exists (`test -x /usr/lib/chromium/chromium`) | a stale `installed: true` marker |
| "the deploy succeeded" | the provider's status **and** a live fetch | the deploy command's exit code |
| "the screen link works" | a WS upgrade returning 101 | a mint returning 200 |
| "memory is fixed" | `reme_doctor` reporting a cause is gone | notes appearing once |

**Implemented:** `verifyCapability` re-checks on connect; `preflight.py`
gates a browser round; the harnesses fail on the old code by construction
(each fix has a test that the *previous* commit fails).

**Next:** `--verify` claims from ripwire for code questions
(`features/memory/skills/ripwire/`), and the `report-completion-only-when-
confirmed` lesson already in the ledger design.

## 3. Pillar 2 — Cheap senses, expensive judgment

The desktop loop is observe → decide → act, and observation is the expensive
part (a 243–707 KB screenshot per step). Three changes make sensing cheap
without losing judgment:

1. **Screenshot diffing** (IMPROVEMENTS §1.2). Return "screen unchanged since
   your last action" — a few tokens — instead of an identical PNG. The model
   loses nothing: an unchanged screen is not new information.
2. **Accessibility tree before pixels** (§1.3). "Click the *Save* button" is
   cheaper and more robust via the a11y tree than via coordinates. Use pixels
   only when the tree is empty (canvas, game, image-only UI).
3. **One screenshot per batch** (§1.1). For flows with no visual branching,
   execute a list of steps and observe once at the end.

Together these attack the single biggest cost in the system, and they make
the agent *more* accurate — coordinates break when a layout shifts; a named
control does not.

## 4. Pillar 3 — Memory that is bounded and honest

**Implemented now:** `recall.py` (2,000-token hard cap, 3 results, credential
redaction, out-of-loop), `lessons.py` (candidate/accept ledger, ≤10 accepted,
secrets rejected), `reme_doctor.py` (names the five real gates).

**The design that completes it:**

- **Read whole at start, search never.** MEMORY.md is read in full at task
  start (it is small and curated); `recall.py` is for looking *backwards*
  into history, not for knowing who you are.
- **Lessons are earned, not generated.** A lesson must come from a failure
  that actually happened, carry the date and session, and state a *future
  action*. The ledger refuses entries without Evidence and rejects anything
  credential-shaped rather than scrubbing it — a lesson containing a token is
  a bug upstream.
- **The reflection step is capped.** ≤3 candidates pending at any time, ≤1–3
  proposed per checkpoint. An agent that proposes ten lessons per task is
  writing a diary, not learning.
- **ReMe stays scoped to distilled markdown.** Upstream deliberately delegates
  raw-history lookup to `recall_history`. Do not rebuild that index.

**What "self-learning" should mean here:** not fine-tuning, not an ever-growing
vector store. It means the same mistake does not happen twice, and the proof
is a ledger entry with a date and a future action attached.

## 5. Pillar 4 — Guardrails that are narrow, not blunt

The current state is a cautionary tale: a DriverCard rule set to `ask` made
*every* computer-use call a prompt, so the fix was `allow` — and now nothing
is guarded at all. Both ends are wrong.

**The design (IMPROVEMENTS §7.1):**

- Classify tool calls by *effect*, not by tool: `read` (free), `mutate`
  (allowed, logged), `destructive` (ask), `external` (ask: sends data out).
- A destructive verb list is short and explicit: `delete`, `rm`, `format`,
  `purchase`, `send`, `publish`.
- Everything else is allowed and *logged* — a log is a better guardrail than
  a prompt for actions you always want to permit.
- **Prompt injection is the real threat**, not the agent's own choices. Content
  the agent reads (a page, an email, a chat message) is untrusted input.
  Wrap it in an explicit envelope and flag imperative text addressed to the
  agent. `features/codemode`'s connector model is the right shape: every
  effect goes through a named connector, so "what can this content cause" has
  an answer.

## 6. Pillar 5 — Division of labour with the human

The most important architectural decision in this repo is not technical: the
coding agent writes and commits, Muse deploys and verifies, and neither
pretends to do the other's job.

That is a *design pattern*, and it should be made explicit in the agent's own
behaviour:

- **State what you did not verify.** Every commit message in this repo ends
  with "not deployed" or names the check that was run.
- **Stop at the boundary.** A missing key, a browser session, a container
  recreate: say what is needed and what is already waiting on it.
- **Never claim a browser result.** A protocol check is not a browser check.
- **Prefer a blocked task reported honestly to a fake pass.** This is stated
  in `AGENTS.md` §8 because it is the failure mode that costs the most time
  to discover.

## 7. The agent loop I would build (concrete)

```
on task:
  1. read AGENTS.md + MEMORY.md whole            (orientation, ~1k tokens)
  2. ripwire --handoff on the relevant subtree   (cheap map, ~350 tokens)
  3. recall.py for "have we tried this?"         (≤3 excerpts, ≤2k tokens)
  4. plan: name the check that will prove success
  5. act in the smallest verifiable increments
  6. after each increment: run the check, record the result
  7. on a failure: root-cause to a mechanism, then write a test that fails
  8. at a checkpoint: propose ≤3 lessons (never accept them)
  9. commit with what changed + what was verified + what was NOT
```

Step 4 is the one most agents skip, and it is the one that makes step 6
possible. "How will I know this worked?" asked *before* acting is the whole
difference between an agent that reports progress and one that reports truth.

## 7b. Two mechanisms added since this was written

**Consolidation, not generation** (`features/memory/consolidate.py`). The gap
was never "produce lessons" — it was "carry experience forward". A model asked
to extract lessons will produce plausible ones that no failure justifies.
Rules that match the *shapes* preceding a real lesson (corrections, hard
limits, root causes, measurements) plus a human accept step produce fewer and
better entries. Zero candidates on a quiet day is the correct answer, and the
tool says so.

**Decision models as narrow gates, not oracles** (`features/decisions/`).
Cheap, fast, and only for questions with a small answer space: approve/deny,
triage, route, wake. Three properties make them safe to use:

  1. no key = no call — never a fabricated answer;
  2. a low-confidence `allow` becomes `ask` — a gate that fails open on
     uncertainty is not a gate;
  3. calibrate before trusting a threshold — "calibrated" is the vendor's
     claim, and a Brier score above 0.25 means the model is worse than
     guessing.

The third is the one people skip. A decision model's output *looks* like
probability, which makes an uncalibrated threshold feel principled when it is
arbitrary.

## 8. What I would not build

- **A bigger autonomous loop.** The bottleneck is belief quality, not
  autonomy. More autonomous steps with the same belief quality means more
  confident wrong answers.
- **A vector database.** Upstream already has FTS5 over the real history. A
  second index is a second thing to be stale.
- **Fine-tuning.** No local models, and the volume of data here is far too
  small to beat a good prompt.
- **A generic multi-agent framework.** The group-chat DO already does
  turn-taking with strong consistency; a framework would add a dependency and
  remove the guarantee.
- **Code Mode inside QwenPaw's loop.** QwenPaw is Python, Code Mode is
  Workers-only. The pilot measures a separate Worker honestly rather than
  pretending to speed up QwenPaw.
- **A memory that writes itself.** Every durable write in this design is
  confirmed by a human. An agent that edits its own long-term memory
  unattended will accumulate confident nonsense.

## 9. How you would know it worked

Not "the agent did the task". These, in order:

1. The machine-free suite is green (425 checks) and every fix has a test the
   previous commit fails.
2. `preflight.py` says CLEAR before a browser round, and the round passes
   without a quota surprise.
3. The lessons ledger has entries with dates, evidence, and a future action —
   and no entry lacks one.
4. The agent says "not verified" without being asked.
5. A new agent can pick up the repo from `AGENTS.md` + `ARCHITECTURE.md` and
   make a correct change without reading 60 KB of handoff.

Point 5 is the real test, and it is why the docs in this pass matter as much
as the code.
