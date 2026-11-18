# -*- coding: utf-8 -*-
"""Built-in resource limit gates for custom loop modes."""
from __future__ import annotations

import json
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .base import StopAction, StopHandlerResult
from .loop_gate import LoopGate


def _bypass() -> StopHandlerResult:
    """Return a gate bypass result."""
    return StopHandlerResult(action=StopAction.BYPASS)


# --- Workflow / batch-runner counting -------------------------------------
# The "Run workflow" tool (run_tool_batch) executes up to 50 sub-calls
# internally. Those sub-calls never appear as top-level tool-call blocks,
# so a gate that only counts top-level calls is blind to them: the model
# can run the batch runner 4 times and execute 200 shell calls while the
# gate sees only 4 top-level calls. The gate therefore expands a batch
# call into its sub-calls (from the call arguments, before it executes)
# and, as a fallback, counts a completed batch from its result JSON.
# Control-flow steps are not real tool calls and are excluded.
_BATCH_TOOL_NAME = "run_tool_batch"
_BATCH_CONTROL_TOOLS = frozenset({"set_var", "goto", "run_tool_batch"})
# Batch files are tiny (50 steps is a few KB). Refuse to read anything
# larger so a pathological file_path cannot stall the loop.
_MAX_BATCH_FILE_BYTES = 1_048_576


@dataclass
class _TokenBudgetState:
    """Per-turn accumulated model usage."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    last_iteration: int = -1


class TokenBudgetGate(LoopGate):
    """Stop a loop when configured token limits are reached."""

    def __init__(
        self,
        *,
        max_total_tokens: int | None = None,
        max_prompt_tokens: int | None = None,
        max_completion_tokens: int | None = None,
    ) -> None:
        super().__init__()
        self._max_total = max_total_tokens
        self._max_prompt = max_prompt_tokens
        self._max_completion = max_completion_tokens

    @property
    def name(self) -> str:
        return "token-budget"

    @property
    def priority(self) -> int:
        return 20

    def reset_turn(self) -> None:
        """Reset the cached snapshot without resetting recorded usage."""
        self.activate(_TokenBudgetState())

    async def check(self, ctx: Any) -> StopHandlerResult:
        """Record the latest model usage and enforce every limit."""
        state = self._state()
        if state is None:
            state = _TokenBudgetState()
            self.activate(state)

        iteration = int(ctx.get("iteration", 0))
        if state.last_iteration != iteration:
            usage = self._current_usage()
            # Usage accumulates for the entire user turn, including rubric
            # continuations, and is cleared by the channel at turn boundaries.
            state.prompt_tokens = int(usage.get("prompt_tokens", 0))
            state.completion_tokens = int(
                usage.get("completion_tokens", 0),
            )
            state.last_iteration = iteration

        total = state.prompt_tokens + state.completion_tokens
        exceeded = (
            self._reached(total, self._max_total)
            or self._reached(state.prompt_tokens, self._max_prompt)
            or self._reached(
                state.completion_tokens,
                self._max_completion,
            )
        )
        if not exceeded:
            return _bypass()
        return StopHandlerResult(
            action=StopAction.TERMINATE,
            reason=f"Token budget reached ({total} tokens used)",
        )

    @staticmethod
    def _reached(value: int, limit: int | None) -> bool:
        return limit is not None and value >= limit

    @staticmethod
    def _current_usage() -> dict[str, Any]:
        """Read usage recorded for the current session."""
        from ...app.agent_context import get_current_session_id
        from ...token_usage.model_wrapper import TokenRecordingModelWrapper

        session_id = get_current_session_id()
        if not session_id:
            return {}
        # pylint: disable=protected-access
        return TokenRecordingModelWrapper._usage_by_session.get(
            session_id,
            {},
        )


@dataclass
class _TimeoutState:
    """Monotonic start time for one turn."""

    started_at: float = field(default_factory=time.monotonic)


class TimeoutGate(LoopGate):
    """Stop at a loop boundary after a monotonic timeout."""

    def __init__(self, max_seconds: float) -> None:
        super().__init__()
        self._max_seconds = max_seconds

    @property
    def name(self) -> str:
        return "timeout"

    @property
    def priority(self) -> int:
        return 30

    def reset_turn(self) -> None:
        """Reset elapsed time for a new user turn."""
        self.activate(_TimeoutState())

    async def check(self, ctx: Any) -> StopHandlerResult:  # noqa: ARG002
        """Terminate after the configured elapsed duration."""
        state = self._state()
        if state is None:
            state = _TimeoutState()
            self.activate(state)
        elapsed = time.monotonic() - state.started_at
        if elapsed < self._max_seconds:
            return _bypass()
        return StopHandlerResult(
            action=StopAction.TERMINATE,
            reason=f"Loop time limit reached ({self._max_seconds:g}s)",
        )


@dataclass
class _ToolCallBudgetState:
    """Tool call counts observed during one turn."""

    total: int = 0
    by_tool: Counter[str] = field(default_factory=Counter)
    last_iteration: int = -1


# --- Execution-time enforcement -----------------------------------------
# The gate checks AFTER a model response and a TERMINATE on a tool-call
# iteration is DEFERRED (runner.apply_stop_result sets
# agent._gate_pending_stop; the batch still executes; the stop applies
# at the next _reasoning via check_pending_gates). When the model emits
# all 200 calls in a SINGLE response, the gate counts 200 and fires,
# but every call still executes before the stop can apply. The gate
# alone cannot stop a single-response burst -- it only stops
# multi-response runaways, where it can fire between responses.
#
# The enforcer below is checked BEFORE each tool call executes, from
# ReactAgent._execute_tool_call -- the single funnel for both the
# sequential and the concurrent paths. The gate installs the enforcement
# state from its check() (which runs after every model response and
# before the acting phase); the reserve is a plain synchronous counter
# increment, so concurrent workers reserve in call order on the
# single-threaded event loop (each worker runs up to its first await
# before the next starts). A call past the budget is refused without
# executing, as a DENIED tool result the model can read.
#
# A run_tool_batch call is expanded into the sub-calls it will execute
# (the same expansion the gate uses) and reserves all of them; when
# the batch would exceed the budget the WHOLE batch is refused, so the
# batch path is bounded at execution time too. When a batch cannot be
# expanded (unreadable file) only the batch call itself is reserved,
# and the gate's result-JSON fallback bounds that case to one batch.
_EXEC_ATTR = "_tool_call_budget_exec"


@dataclass
class _ToolCallBudgetExec:
    """Per-turn execution counter (reserved slots, not context counts)."""

    reply_id: str = ""
    total: int = 0
    by_tool: Counter[str] = field(default_factory=Counter)
    max_calls: int | None = None
    per_tool: dict[str, int] = field(default_factory=dict)


def install_execution_budget(
    agent: Any,
    reply_id: str | None,
    max_calls: int | None,
    per_tool: dict[str, int] | None,
) -> Any:
    """Install (or refresh) the per-turn execution counter on the agent.

    Counters reset only when the reply_id changes (a new turn). Within
    a turn they accumulate across rounds, so a multi-round runaway is
    bounded by the same budget as a single-response burst. The limits
    are refreshed on every call so a config change takes effect without
    a restart. No-op when the agent or reply_id is missing.
    """
    if agent is None or reply_id is None:
        return None
    current = getattr(agent, _EXEC_ATTR, None)
    if current is None or getattr(current, "reply_id", None) != reply_id:
        current = _ToolCallBudgetExec(
            reply_id=reply_id,
            max_calls=max_calls,
            per_tool=dict(per_tool or {}),
        )
        setattr(agent, _EXEC_ATTR, current)
    else:
        current.max_calls = max_calls
        current.per_tool = dict(per_tool or {})
    return current


def _exec_state(agent: Any, reply_id: str | None) -> Any:
    """The installed execution counter for this turn, or None."""
    if agent is None or reply_id is None:
        return None
    current = getattr(agent, _EXEC_ATTR, None)
    if current is None:
        return None
    if getattr(current, "reply_id", None) != reply_id:
        return None
    return current


def try_reserve_execution(agent: Any, tool_call: Any) -> str | None:
    """Reserve budget for one tool call before it executes, or refuse it.

    Returns None when the call may execute (the slot is reserved), or
    a refusal reason string when the total cap or a per-tool cap would
    be exceeded. The reserve is synchronous, so concurrent workers
    reserve in call order. Fail-open: when no enforcement state is
    installed for this turn (gate inactive, reply_id missing) the call
    is allowed, so a missing enforcer can never break normal execution.
    A call with no name is allowed (nothing to count).
    """
    name = ToolCallBudgetGate._block_name(tool_call)
    if not name:
        return None
    state = getattr(agent, "state", None)
    reply_id = getattr(state, "reply_id", None)
    exec_state = _exec_state(agent, reply_id)
    if exec_state is None:
        return None
    # Names to reserve: the call itself, plus its sub-calls when it is
    # a batch call (expanded from its arguments, as the gate does).
    names = [name]
    if name == _BATCH_TOOL_NAME:
        sub = ToolCallBudgetGate._expand_batch_call(tool_call)
        if sub is not None:
            names.extend(sub)
    # Would this exceed the total cap? The gate fires at total >=
    # max_calls, so a call is allowed while total + len(names) is at
    # most max_calls (exactly max_calls calls execute).
    if (
        exec_state.max_calls is not None
        and exec_state.total + len(names) > exec_state.max_calls
    ):
        return (
            "Tool call budget reached: this turn already used "
            f"{exec_state.total} tool calls (limit "
            f"{exec_state.max_calls}); this call was not executed."
        )
    # Would this exceed a per-tool cap? Same boundary as the gate:
    # exactly `limit` calls of that tool execute.
    counts = Counter(names)
    for tool_name, n in counts.items():
        limit = exec_state.per_tool.get(tool_name)
        if (
            limit is not None
            and exec_state.by_tool[tool_name] + n > limit
        ):
            return (
                f"Tool '{tool_name}' call budget reached: this turn "
                f"already used {exec_state.by_tool[tool_name]} "
                f"'{tool_name}' calls (limit {limit}); this call was "
                "not executed."
            )
    exec_state.total += len(names)
    exec_state.by_tool.update(names)
    return None


class ToolCallBudgetGate(LoopGate):
    """Limit total and per-tool calls in one agent turn."""

    def __init__(
        self,
        *,
        max_calls: int | None = None,
        per_tool: dict[str, int] | None = None,
    ) -> None:
        super().__init__()
        self._max_calls = max_calls
        self._per_tool = per_tool or {}

    @property
    def name(self) -> str:
        return "tool-call-budget"

    @property
    def priority(self) -> int:
        return 40

    def reset_turn(self) -> None:
        """Reset tool call counters for a new turn."""
        self.activate(_ToolCallBudgetState())

    async def check(self, ctx: Any) -> StopHandlerResult:
        """Recompute this turn's tool-call total and enforce limits.

        The total is recomputed from the context on every check, scoped
        to the current reply (``agent.state.reply_id``). The parent
        accumulates all of a turn's tool-call blocks into the assistant
        message(s) carrying the current ``reply_id``; adding the latest
        message's (cumulative) names to the running total once per round
        inflated the count (50, then 150, then 300, ...) and fired with
        a wrong total. Recomputing from the reply-scoped blocks counts
        every call exactly once and does not depend on the iteration
        counter, so a stale ``last_iteration`` cannot skip a count.
        When ``reply_id`` is unavailable, fall back to the previous
        incremental counting.

        Workflow batches are expanded, not just counted as one call:
        a ``run_tool_batch`` call is replaced by the sub-call tool
        names it will execute (read from its arguments -- inline
        ``actions`` or the JSON batch ``file_path``), and a completed
        batch whose steps could not be expanded from its call is
        counted from its result JSON instead. A batch is never counted
        twice: a result is skipped when its call was already expanded.
        """
        state = self._state()
        if state is None:
            state = _ToolCallBudgetState()
            self.activate(state)
        agent = ctx.get("agent")
        reply_id = getattr(getattr(agent, "state", None), "reply_id", None)
        if reply_id is not None:
            # Install the execution-time enforcer for this turn. The
            # check runs after every model response and before the
            # acting phase, so the counter is in place before any call
            # of the round executes. Counters reset only on a new
            # reply_id (install_execution_budget handles that).
            install_execution_budget(
                agent, reply_id, self._max_calls, self._per_tool,
            )
            names = self._turn_tool_names(agent, reply_id)
            state.total = len(names)
            state.by_tool = Counter(names)
        else:
            iteration = int(ctx.get("iteration", 0))
            if iteration != state.last_iteration:
                names = self._latest_tool_names(agent)
                state.total += len(names)
                state.by_tool.update(names)
                state.last_iteration = iteration

        if self._max_calls is not None and state.total >= self._max_calls:
            return StopHandlerResult(
                action=StopAction.TERMINATE,
                reason=f"Tool call budget reached ({state.total} calls)",
            )
        for name, limit in self._per_tool.items():
            if state.by_tool[name] >= limit:
                return StopHandlerResult(
                    action=StopAction.TERMINATE,
                    reason=f"Tool '{name}' call budget reached ({limit})",
                )
        return _bypass()

    @staticmethod
    def _turn_tool_names(agent: Any, reply_id: str) -> list[str]:
        """Tool names issued in the current turn (messages with reply_id).

        All of this turn's tool-call blocks live in messages carrying
        the current ``reply_id`` -- one message if the parent merges a
        turn's blocks, one per round otherwise. Counting every block in
        every such message gives the true turn total.

        A ``run_tool_batch`` call is expanded into the sub-calls it
        will execute (from its arguments), and a completed batch whose
        call could not be expanded is counted from its result JSON.
        The parent appends tool results (``tool_result`` blocks) to the
        same reply-scoped messages, so both passes read the same
        messages. A batch is counted once: a result whose call id was
        already expanded is skipped.
        """
        context = getattr(getattr(agent, "state", None), "context", [])
        names: list[str] = []
        expanded_ids: set[str] = set()
        # Pass 1: tool-call blocks. Expand batch calls into sub-calls.
        for message in context:
            if getattr(message, "id", None) != reply_id:
                continue
            for block in ToolCallBudgetGate._blocks_of(message):
                if ToolCallBudgetGate._block_type(block) not in (
                    "tool_call",
                    "tool_use",
                ):
                    continue
                name = ToolCallBudgetGate._block_name(block)
                if not name:
                    continue
                # The batch call itself is a tool call (count it), plus
                # the sub-calls it will execute.
                names.append(name)
                if name == _BATCH_TOOL_NAME:
                    sub = ToolCallBudgetGate._expand_batch_call(block)
                    if sub is not None:
                        names.extend(sub)
                        call_id = ToolCallBudgetGate._block_id(block)
                        if call_id:
                            expanded_ids.add(call_id)
        # Pass 2: tool-result blocks. Count completed batches whose
        # call was NOT already expanded in pass 1.
        for message in context:
            if getattr(message, "id", None) != reply_id:
                continue
            for block in ToolCallBudgetGate._blocks_of(message):
                if ToolCallBudgetGate._block_type(block) != "tool_result":
                    continue
                if ToolCallBudgetGate._block_name(block) != _BATCH_TOOL_NAME:
                    continue
                if ToolCallBudgetGate._block_id(block) in expanded_ids:
                    continue
                sub = ToolCallBudgetGate._parse_batch_result(block)
                if sub is not None:
                    names.extend(sub)
        return names

    @staticmethod
    def _blocks_of(message: Any) -> list[Any]:
        """Content blocks of one message (empty when not a list)."""
        content = getattr(message, "content", None)
        if not isinstance(content, list):
            return []
        return content

    @staticmethod
    def _block_type(block: Any) -> str:
        """The type of a content block (dict or object)."""
        value = (
            block.get("type")
            if isinstance(block, dict)
            else getattr(block, "type", None)
        )
        return str(value or "")

    @staticmethod
    def _block_name(block: Any) -> str:
        """The tool name of a tool-call / tool-result block."""
        value = (
            block.get("name", "")
            if isinstance(block, dict)
            else getattr(block, "name", "")
        )
        return str(value or "")

    @staticmethod
    def _block_id(block: Any) -> str:
        """The id linking a tool result to its tool call."""
        value = (
            block.get("id", "")
            if isinstance(block, dict)
            else getattr(block, "id", "")
        )
        return str(value or "")

    @staticmethod
    def _block_input(block: Any) -> Any:
        """The arguments of a tool-call block (usually a dict)."""
        if isinstance(block, dict):
            return block.get("input")
        return getattr(block, "input", None)

    @staticmethod
    def _expand_batch_call(block: Any) -> list[str] | None:
        """Sub-call tool names a batch call will execute, or None.

        Reads the steps from the call arguments: inline ``actions``
        (a list, or a JSON string) or a JSON batch ``file_path``
        (absolute; either a list of steps or an object with an
        ``actions`` key). Control-flow steps (``set_var``, ``goto``,
        recursive ``run_tool_batch``) are not real tool calls and are
        excluded. Returns None when the steps cannot be determined
        (unreadable file, invalid JSON, unexpected shape) so the
        caller falls back to counting the completed batch result.
        """
        args = ToolCallBudgetGate._block_input(block)
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (json.JSONDecodeError, TypeError):
                return None
        if not isinstance(args, dict):
            return None
        steps: Any = None
        if "actions" in args and args.get("actions") is not None:
            steps = args.get("actions")
            if isinstance(steps, str):
                try:
                    steps = json.loads(steps)
                except (json.JSONDecodeError, TypeError):
                    return None
        elif args.get("file_path"):
            steps = ToolCallBudgetGate._load_batch_steps(
                args.get("file_path"),
            )
            if steps is None:
                return None
        else:
            return None
        if not isinstance(steps, list):
            return None
        return ToolCallBudgetGate._step_tool_names(steps)

    @staticmethod
    def _load_batch_steps(file_path: Any) -> list[Any] | None:
        """Steps from a JSON batch file, or None when unreadable.

        Only ``.json`` files are read, and only up to the size guard.
        The file is the same one the batch runner itself reads, so
        reading it here adds no new access. Any failure returns None
        (the caller falls back to the completed batch result).
        """
        if not isinstance(file_path, str):
            return None
        path_text = file_path.strip()
        if not path_text or not path_text.lower().endswith(".json"):
            return None
        try:
            path = Path(path_text).expanduser()
            if not path.is_file():
                return None
            if path.stat().st_size > _MAX_BATCH_FILE_BYTES:
                return None
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            return None
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("actions"), list):
            return data["actions"]
        return None

    @staticmethod
    def _step_tool_names(steps: list[Any]) -> list[str]:
        """Tool names of real (non-control-flow) batch steps."""
        names: list[str] = []
        for step in steps:
            if not isinstance(step, dict):
                continue
            tool_name = str(
                step.get("tool_name") or step.get("tool") or "",
            ).strip()
            if not tool_name or tool_name in _BATCH_CONTROL_TOOLS:
                continue
            names.append(tool_name)
        return names

    @staticmethod
    def _parse_batch_result(block: Any) -> list[str] | None:
        """Sub-call tool names from a completed batch result, or None.

        The result is a JSON summary (``{"ok": ..., "total": ...,
        "completed": ..., "results": [{"tool_name": ..., ...}]}``).
        With ``results`` present, each entry's ``tool_name`` is used
        (entries without one still count as an executed step, under
        the batch tool's name, so the total stays accurate). With
        ``last_only`` there is no ``results`` list, so ``total`` is
        used as the sub-call count without per-tool attribution.
        Returns None when the output is not a batch summary.
        """
        output = (
            block.get("output")
            if isinstance(block, dict)
            else getattr(block, "output", None)
        )
        text = ToolCallBudgetGate._result_text(output)
        if not text:
            return None
        try:
            payload = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(payload, dict):
            return None
        results = payload.get("results")
        if isinstance(results, list):
            names: list[str] = []
            for entry in results:
                if not isinstance(entry, dict):
                    names.append(_BATCH_TOOL_NAME)
                    continue
                tool_name = str(
                    entry.get("tool_name") or "",
                ).strip()
                names.append(tool_name or _BATCH_TOOL_NAME)
            return names
        total = payload.get("total")
        if isinstance(total, int) and total > 0:
            return [_BATCH_TOOL_NAME] * total
        return None

    @staticmethod
    def _result_text(output: Any) -> str:
        """The JSON text of a tool result (string or block list)."""
        if isinstance(output, str):
            return output
        if isinstance(output, list):
            for item in output:
                if ToolCallBudgetGate._block_type(item) != "text":
                    continue
                text = (
                    item.get("text", "")
                    if isinstance(item, dict)
                    else getattr(item, "text", "")
                )
                if isinstance(text, str) and text.strip():
                    return text
        return ""

    @staticmethod
    def _tool_names_in(message: Any) -> list[str]:
        """Tool names from the tool_call/tool_use blocks of one message."""
        names: list[str] = []
        for block in ToolCallBudgetGate._blocks_of(message):
            if ToolCallBudgetGate._block_type(block) not in (
                "tool_call",
                "tool_use",
            ):
                continue
            name = ToolCallBudgetGate._block_name(block)
            if name:
                names.append(name)
        return names

    @staticmethod
    def _latest_tool_names(agent: Any) -> list[str]:
        """Extract tool names from the latest context message with calls."""
        context = getattr(getattr(agent, "state", None), "context", [])
        for message in reversed(context):
            names = ToolCallBudgetGate._tool_names_in(message)
            if names:
                return names
        return []


__all__ = [
    "TimeoutGate",
    "TokenBudgetGate",
    "ToolCallBudgetGate",
    "install_execution_budget",
    "try_reserve_execution",
]
