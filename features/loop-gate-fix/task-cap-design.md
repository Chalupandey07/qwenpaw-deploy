# Per-task cap design review (T126) — brief for DeepSeek

Context: QwenPaw v2.3.0 (AgentScope). ToolCallBudgetGate in
src/qwenpaw/loop/gates/limits.py enforces a PER-TURN cap at execution time
(try_reserve_execution, called from ReactAgent._execute_tool_call before the
first await): 30 total / 20 execute_shell_command per turn (reply_id-scoped),
refused calls yield a DENIED tool result. The gate's check() runs after each
model response and its TERMINATE is deferred. Live test 2026-11-18 proved it:
turn 1 executed 20 shell calls, but on the follow-up "hello" the agent resumed
the same echo-1-to-200 task and did 21-40. The per-turn counter resets on the
new reply_id, so the task can creep across turns.

## Proposed design (to be implemented in limits.py only; patch + config + mode wiring)

1. Per-TASK cap = 2x the per-turn cap: 60 total / 40 shell, cumulative across
   turns of one task. Rationale: one full turn plus one genuine resume turn;
   echo 1-200 needs 10 turns at 20/turn and stops at 40. Config fields
   task_max_calls / task_per_tool default to None / {} meaning "2x per-turn".
2. Task state lives ON the agent object (same place as the per-turn exec
   counter _tool_call_budget_exec), as _ToolCallTaskBudget: task_id,
   instruction (truncated starting user message), total + by_tool (EXECUTED
   calls, accumulated in try_reserve_execution on every successful reserve),
   max_calls / per_tool, finalized flag + reason. It is NOT reset when
   reply_id changes.
3. Task identity: explicit ctx["task_id"] / agent.state.task_id if present,
   else derived from the latest user message in agent.state.context.
   - No active task -> start one from the latest user message.
   - Active unfinalized task + continuation-only message (empty, greeting,
     "continue"/"go on"/"yes"/"ok"/"thanks") -> same task.
   - Active unfinalized task + a different substantive message -> new task
     (old abandoned, no fresh budget for repeats of the same instruction).
   - Finalized task + ANY substantive message (even a repeat) -> new task
     with a fresh budget. Finalized + continuation -> same finalized task.
4. Enforcement: try_reserve_execution checks the task cap BEFORE the per-turn
   cap; a refusal names the task total, records a stop-audit entry and
   finalizes the task. A successful reserve that brings the task total to
   exactly the cap finalizes the task immediately. The gate's check() also
   terminates on a finalized task (resume) or on task.total >= cap (safety
   net). A per-turn gate TERMINATE does NOT finalize the task (the task may
   legitimately continue next turn within its task budget); only the task
   cap finalizes.
5. Structured stop audit: append-only list on the agent
   (_tool_call_stop_audit), one record per stop, deduped per
   (task_id, turn/reply_id, kind): {ts ISO UTC, kind, reason, task_id,
   instruction, turn_id, turn_total, turn_executed, task_total, finalized}.
   Kinds: "per-turn gate" (gate check, per-turn), "per-task cap" (gate or
   enforcer, task total), "fuse" (enforcer refusal on per-turn grounds),
   "task_finalized" (a resumed turn on a finalized task). Accessors
   get_stop_audit(agent) / get_task_state(agent) return copies. Audit is
   in-memory for the chat session lifetime (agent object lifetime); no disk
   persistence in this change.
6. Fail-open: all task logic is wrapped so any exception (or a missing task
   API on old code) falls through to the existing per-turn behaviour; the
   per-turn gate reasons stay byte-identical (existing tests assert exact
   strings). The unreadable-batch edge (sub-calls bypassing the funnel, ~50)
   is NOT charged to the task total; documented as a remaining gap.

## Questions

A. Is storing task state on the agent object (not agent.state) sound for
   cross-turn persistence in AgentScope/QwenPaw, given the per-turn exec
   counter already lives there and reply_id changes per turn? What would
   break if the agent object were recreated per turn, and is there a cheap
   signal in the code that tells which lifetime holds?
B. Does finalizing ONLY on the task cap (not on a per-turn TERMINATE) create
   a hole: turn 1 hits per-turn cap with 20 executed, turn 2 "hello" gets 20
   more (task 40), turn 3 "hello" is refused. Is cumulative 40 the right
   bound, or should the per-turn TERMINATE also finalize?
C. The continuation heuristic (greeting/continue/yes/ok = same task, anything
   else substantive = new task): is there a failure mode where the model or
   user can silently get a fresh budget for the SAME runaway task? What is
   the cheapest robust alternative that needs no new upstream plumbing?
D. Any race/ordering flaw: the gate check() runs after the model response but
   before execution; try_reserve_execution runs during execution. The gate
   finalizes on task.total >= cap at check time, the enforcer finalizes when
   a reserve reaches the cap. Can a turn execute past the task cap between a
   check and the reserves (concurrent batch)?
E. Is deduping audit records per (task_id, turn_id, kind) correct, or should
   every individual refusal be a record?

## Review outcome (DeepSeek, 2026-11-18, deepseek-v4.1-flash-free)

Call: seek.py chat --context task-cap-design.md, short prompt, --max-tokens
65536. Prompt 1,583 tokens, completion 6,670 tokens, quota remaining
399,843,566. Verdict: shape right, but the 2x cap was not a hard bound as
specified. Adopted: freeze limits at task creation; check order finalised
-> task shell -> task total -> per-turn, either task cap finalising the
whole task; instruction-repeat guard (capped task's fingerprint inherits
its spent total); audit magnitude fields (seq, refused, finalized_by_this_stop)
with dedupe per (task, turn, kind); charging unreadable-batch sub-calls to
the task from the result JSON (the review's "flaw that actually breaks 40").
Rejected with reasons: session-wide backstop counter (a whole chat
legitimately exceeds it over a day); mirroring task state onto agent.state
(two truths -- the agent object is the single source, as for the per-turn
counter). Confirmed no change: the reserve is one synchronous function with
no await between check and increment, so concurrent workers cannot overshoot.
Two warts documented in the README, not fixed: non-English continuations read
as new instructions; "ok now do X" reads as a continuation.
