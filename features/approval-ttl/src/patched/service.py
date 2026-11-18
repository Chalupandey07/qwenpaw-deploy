# -*- coding: utf-8 -*-
"""Approval service for sensitive tool execution.

The ``ApprovalService`` is the single central store for pending and completed
approval records. Decisions can arrive from chat control commands, the
authenticated Console API, or ACP permission prompts; identity policy is
enforced here so every resolution surface shares the same boundary.
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ...constant import TOOL_GUARD_APPROVAL_TIMEOUT_SECONDS
from ...security.tool_guard.approval import ApprovalDecision, ApprovalScope
from .models import ApprovalRequestSummary
from ...plugins._events import approval_changed as _sdk_approval_changed

if TYPE_CHECKING:
    from ...security.tool_guard.models import ToolGuardResult

logger = logging.getLogger(__name__)

_GC_MAX_AGE_SECONDS = 3600.0
_GC_MAX_COMPLETED = 500
_GC_PENDING_MAX_AGE_SECONDS = 1800.0
_GC_MAX_PENDING = 200


# ------------------------------------------------------------------
# Approval TTL (gap #18, T132)
# ------------------------------------------------------------------
# The TTL store + module live on the working mount
# (/app/working/approval-ttl/), synced from the repo — never baked
# into the image, so the store survives container recreates. The
# module is loaded lazily; if it is absent (not synced yet) TTL is
# inert and approvals behave exactly as before. A TTL failure must
# never break approval creation or resolution: every helper below
# fails open to the pre-TTL behaviour and logs loudly.
_TTL_MODULE_PATH = "/app/working/approval-ttl/ttl.py"
_TTL_STORE_PATH = "/app/working/approval-ttl/pending.json"
_ttl_module = None


def _load_ttl_module():
    """Load the approval-TTL module from the working mount, or None.

    Cached on success; a missing file is retried on the next call so
    a module synced after startup is picked up without a restart.
    A file that fails to import is also retried (it may be mid-sync).
    """
    global _ttl_module
    if _ttl_module is not None:
        return _ttl_module
    if not Path(_TTL_MODULE_PATH).is_file():
        return None
    try:
        spec = importlib.util.spec_from_file_location(
            "approval_ttl", _TTL_MODULE_PATH)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _ttl_module = module
    except Exception:  # noqa: BLE001 — TTL must never break approvals
        logger.warning("approval TTL module failed to load from %s",
                       _TTL_MODULE_PATH, exc_info=True)
        _ttl_module = None
    return _ttl_module


def _ttl_store():
    """A CardStore for the TTL file, or None when TTL is inert."""
    module = _load_ttl_module()
    if module is None:
        return None
    return module.CardStore(_TTL_STORE_PATH)


def ttl_issue(request_id, tool, session_id):
    """Stamp a TTL expiry for a newly created approval (best-effort).

    Called from create_pending / create_pending_summary. Returns the
    stored item, or None when TTL is inert or the issue failed (the
    card then carries no expiry and stays answerable, as before).
    """
    store = _ttl_store()
    if store is None:
        return None
    try:
        return _load_ttl_module().issue(
            store, "approval", request_id, tool, session_id=session_id)
    except Exception:  # noqa: BLE001 — TTL must never break creation
        logger.warning("approval TTL issue failed for %s",
                       request_id[:8], exc_info=True)
        return None


def ttl_answer(request_id, approve):
    """Answer a TTL item. Returns (outcome, denial).

    outcome is one of:
    - "ok": the answer was recorded (approved/denied).
    - "expired": the card waited out its TTL; `denial` is the denial
      dict (reason "timed out"). The caller must NOT apply the
      approval and should resolve the waiting call as denied.
    - "unknown": the request is not in the TTL store (created before
      the wiring, or issue() failed) — legacy, proceed as before.
    - "answered": the store already holds a terminal decision; the
      in-memory request reports already-resolved through the normal
      path, so the caller proceeds.
    A corrupt store or a lock timeout is logged and treated as
    "unknown" (proceed as before) so a TTL fault can never block
    approvals outright.
    """
    store = _ttl_store()
    if store is None:
        return "unknown", None
    module = _load_ttl_module()
    try:
        module.answer(store, request_id, approve)
        return "ok", None
    except module.ExpiredError:
        item = store.find(store.load(), request_id)
        if item is None:
            return "expired", {
                "request_id": request_id, "kind": "approval",
                "status": "denied", "reason": "timed out",
                "expired": True, "do_not_retry": True,
                "card": "This approval expired"}
        return "expired", module.denial_for(item)
    except module.UnknownRequestError:
        return "unknown", None
    except module.AlreadyAnsweredError:
        return "answered", None
    except Exception:  # noqa: BLE001 — TTL must never block approvals
        logger.warning("approval TTL answer failed for %s",
                       request_id[:8], exc_info=True)
        return "unknown", None


def ttl_read(request_id):
    """The effective TTL state of a card, or None when unknown/inert.

    Returns the read() dict (pending with expires_at_ms, or the
    denial for an expired card). Pure — it never mutates the store.
    A terminal-expired item (already answered/swept) reads back as
    {"status": "denied", "answer": "expired"} with no card/reason;
    it is normalized to the full denial shape here so callers can
    treat the pending-past-TTL and terminal-expired cases the same.
    """
    store = _ttl_store()
    if store is None:
        return None
    module = _load_ttl_module()
    try:
        state = module.read(store, request_id)
    except module.UnknownRequestError:
        return None
    except Exception:  # noqa: BLE001 — listing must never break
        logger.warning("approval TTL read failed for %s",
                       request_id[:8], exc_info=True)
        return None
    if state.get("status") == "denied" and state.get("answer") == "expired":
        item = store.find(store.load(), request_id)
        if item is not None:
            return module.denial_for(item)
    return state


class ApprovalIdentityPolicy(str, Enum):
    """Identity boundary applied when an approval is resolved.

    ``AGENT`` preserves the established tool/subagent delegation model.
    ``EXACT_REQUESTER`` is for user-triggered side effects: the resolver must
    match every request identity field, unless it is explicitly an admin.
    """

    AGENT = "agent"
    EXACT_REQUESTER = "exact_requester"


@dataclass(frozen=True)
class ApprovalActor:
    """Identity of the caller attempting to resolve an approval."""

    session_id: str
    root_session_id: str
    user_id: str
    channel: str
    agent_id: str
    is_admin: bool = False


class ApprovalIdentityMismatchError(PermissionError):
    """Raised when a caller crosses an approval's identity boundary."""


# ------------------------------------------------------------------
# Data model
# ------------------------------------------------------------------


@dataclass
class PendingApproval:
    """In-memory record for one pending approval."""

    request_id: str
    session_id: str
    root_session_id: str  # Root session for cross-session approval routing
    owner_agent_id: str  # Conversation owner/root agent
    user_id: str
    channel: str
    agent_id: str  # Which agent is requesting approval
    tool_name: str
    created_at: float
    future: asyncio.Future[ApprovalDecision]
    timeout_seconds: float = 300.0  # Approval timeout in seconds
    status: str = "pending"
    resolved_at: float | None = None
    result_summary: str = ""
    findings_count: int = 0
    severity: str = "medium"  # For frontend display
    extra: dict[str, Any] = field(default_factory=dict)
    # Resolution authorization. Most existing tool approvals are agent-scoped;
    # direct user-triggered side effects can opt into exact requester matching.
    identity_policy: ApprovalIdentityPolicy = ApprovalIdentityPolicy.AGENT
    # How widely the approved call should be remembered (EXACT vs SIMILAR).
    # Set by ``resolve_request`` from the approve path; ``None`` means the
    # caller didn't choose (IM channels, CLI, non-governance paths) and is
    # treated as EXACT by the governance consumer. Only meaningful when the
    # decision is APPROVED.
    scope: ApprovalScope | None = None


def _is_spawn_child_approval(pending: PendingApproval) -> bool:
    """Return whether this approval belongs to a same-agent spawned child."""
    return bool(
        pending.extra.get("_spawn_subagent")
        and pending.agent_id == pending.owner_agent_id
        and pending.session_id != pending.root_session_id
        and pending.root_session_id,
    )


# ------------------------------------------------------------------
# Service
# ------------------------------------------------------------------


class ApprovalService:
    """Global singleton approval service.

    Manages approval requests across sessions and agents and applies their
    identity policy atomically when any supported surface resolves them.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._pending: dict[str, PendingApproval] = {}
        self._channel_managers: dict[str, Any] = {}

    def set_channel_manager(
        self,
        channel_manager: Any,
        agent_id: str = "default",
    ) -> None:
        """Register an agent's channel manager for spawned-child routing."""
        self._channel_managers[agent_id] = channel_manager

    async def _notify_channel(
        self,
        pending: PendingApproval,
        channel_body: str,
    ) -> None:
        """Fire-and-forget: push approval notification to channel."""
        if not pending.channel or pending.channel == "console":
            return
        is_spawn_child = _is_spawn_child_approval(pending)
        try:
            channel_instance = (pending.extra or {}).get("_channel_instance")
            if is_spawn_child:
                channel_manager = self._channel_managers.get(pending.agent_id)
                if channel_manager is None:
                    return
                channel_instance = await channel_manager.get_channel(
                    pending.channel,
                )
            if channel_instance is None:
                return
            channel_meta = (pending.extra or {}).get("channel_meta")
            delivery_session_id = (
                pending.root_session_id
                if is_spawn_child
                else pending.session_id
            )
            await channel_instance.send_approval_notification(
                session_id=delivery_session_id,
                user_id=pending.user_id,
                request_id=pending.request_id,
                tool_name=pending.tool_name,
                severity=pending.severity,
                result_summary=channel_body,
                channel_meta=channel_meta,
            )
        except Exception:
            logger.warning(
                "Failed to push approval notification: request_id=%s",
                pending.request_id[:8],
                exc_info=True,
            )

    # ------------------------------------------------------------------
    # Core approval lifecycle
    # ------------------------------------------------------------------

    async def create_pending(
        self,
        *,
        session_id: str,
        root_session_id: str,
        owner_agent_id: str,
        user_id: str,
        channel: str,
        agent_id: str,
        tool_name: str,
        result: "ToolGuardResult",
        timeout_seconds: float = TOOL_GUARD_APPROVAL_TIMEOUT_SECONDS,
        extra: dict[str, Any] | None = None,
        identity_policy: ApprovalIdentityPolicy = ApprovalIdentityPolicy.AGENT,
    ) -> PendingApproval:
        """Create a pending approval record and return it."""
        from ...security.tool_guard.approval import (
            format_channel_approval_body,
            format_findings_summary,
        )

        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()

        pending = PendingApproval(
            request_id=request_id,
            session_id=session_id,
            root_session_id=root_session_id,
            owner_agent_id=owner_agent_id,
            user_id=user_id,
            channel=channel,
            agent_id=agent_id,
            tool_name=tool_name,
            created_at=time.time(),
            future=loop.create_future(),
            timeout_seconds=timeout_seconds,
            result_summary=format_findings_summary(result),
            findings_count=result.findings_count,
            severity=result.max_severity.value,
            extra=dict(extra or {}),
            identity_policy=identity_policy,
        )

        async with self._lock:
            self._pending[request_id] = pending
            self._gc_pending_locked()
            _sdk_approval_changed(pending)

        # Approval TTL (T132): stamp the card's expiry at issue time.
        # to_thread keeps the blocking file write off the event loop.
        await asyncio.to_thread(ttl_issue, request_id, tool_name,
                                session_id)

        logger.info(
            "Approval pending created: request_id=%s agent_id=%s tool=%s "
            "severity=%s session=%s root=%s",
            request_id[:8],
            agent_id,
            tool_name,
            pending.severity,
            session_id[:8],
            root_session_id[:8],
        )

        if (
            channel
            and channel != "console"
            and (
                (extra or {}).get("_channel_instance")
                or _is_spawn_child_approval(pending)
            )
        ):
            channel_body = format_channel_approval_body(result)
            asyncio.create_task(
                self._notify_channel(pending, channel_body),
                name=f"approval-notify-{request_id[:8]}",
            )

        return pending

    async def create_pending_summary(
        self,
        *,
        session_id: str,
        root_session_id: str,
        owner_agent_id: str,
        user_id: str,
        channel: str,
        agent_id: str,
        summary: ApprovalRequestSummary,
        timeout_seconds: float = TOOL_GUARD_APPROVAL_TIMEOUT_SECONDS,
        extra: dict[str, Any] | None = None,
        identity_policy: ApprovalIdentityPolicy = ApprovalIdentityPolicy.AGENT,
    ) -> PendingApproval:
        """Create a pending approval from a generic summary."""
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        merged_extra = {
            "source_type": summary.source_type,
            **summary.payload,
            **dict(extra or {}),
        }
        pending = PendingApproval(
            request_id=request_id,
            session_id=session_id,
            root_session_id=root_session_id,
            owner_agent_id=owner_agent_id,
            user_id=user_id,
            channel=channel,
            agent_id=agent_id,
            tool_name=summary.name,
            created_at=time.time(),
            future=loop.create_future(),
            timeout_seconds=timeout_seconds,
            result_summary=summary.result_summary,
            findings_count=summary.findings_count,
            severity=summary.severity,
            extra=merged_extra,
            identity_policy=identity_policy,
        )
        async with self._lock:
            self._pending[request_id] = pending
            self._gc_pending_locked()
            _sdk_approval_changed(pending)

        # Approval TTL (T132): stamp the card's expiry at issue time.
        await asyncio.to_thread(ttl_issue, request_id, summary.name,
                                session_id)

        logger.info(
            "Generic approval pending created: request_id=%s agent_id=%s "
            "name=%s source=%s session=%s root=%s",
            request_id[:8],
            agent_id,
            summary.name,
            summary.source_type,
            session_id[:8],
            root_session_id[:8],
        )

        if (
            channel
            and channel != "console"
            and (
                (extra or {}).get("_channel_instance")
                or _is_spawn_child_approval(pending)
            )
        ):
            asyncio.create_task(
                self._notify_channel(pending, pending.result_summary),
                name=f"approval-notify-{request_id[:8]}",
            )

        return pending

    async def resolve_request(
        self,
        request_id: str,
        decision: ApprovalDecision,
        scope: ApprovalScope | None = None,
        *,
        actor: ApprovalActor | None = None,
    ) -> PendingApproval | None:
        """Resolve pending approval by setting Future result.

        Args:
            scope: how widely an APPROVED call should be remembered
                (EXACT vs SIMILAR). Stashed on ``pending.scope`` so the
                governance consumer can pick the rule target. ``None`` is
                treated as EXACT. Ignored for non-APPROVED decisions.
            actor: caller identity used by policies stricter than ``AGENT``.
                Exact-requester approvals reject missing or mismatched actors.
                Automatic timeout resolution is the only actor-free exception.

        Returns None if another resolver won or the request expired.
        Expired requests resolve to TIMEOUT even when an approval arrives.
        """
        async with self._lock:
            pending = self._pending.get(request_id)
            if pending is None:
                logger.warning(
                    "Approval request %s not found (already resolved?)",
                    request_id[:8],
                )
                return None

            if (
                pending.identity_policy
                == ApprovalIdentityPolicy.EXACT_REQUESTER
                and decision != ApprovalDecision.TIMEOUT
                and not self.actor_can_resolve(pending, actor)
            ):
                raise ApprovalIdentityMismatchError(
                    "approval caller does not match the original requester",
                )

            expired = (
                time.time() >= pending.created_at + pending.timeout_seconds
            )
            if expired:
                decision = ApprovalDecision.TIMEOUT
                scope = None

            self._pending.pop(request_id)
            pending.status = decision.value
            pending.resolved_at = time.time()
            pending.scope = scope

        # Set Future result outside lock
        if not pending.future.done():
            pending.future.set_result(decision)
        _sdk_approval_changed(pending)

        logger.info(
            "Approval request %s resolved: decision=%s scope=%s tool=%s",
            request_id[:8],
            decision.value,
            scope.value if scope else "exact(default)",
            pending.tool_name,
        )

        return None if expired else pending

    @staticmethod
    def actor_can_resolve(
        pending: PendingApproval,
        actor: ApprovalActor | None,
    ) -> bool:
        """Return whether ``actor`` may resolve ``pending``.

        Agent-scoped approvals retain their existing resolver behavior. Exact
        approvals require the original request identity unless an admin is
        represented explicitly.
        """
        if pending.identity_policy == ApprovalIdentityPolicy.AGENT:
            return actor is None or actor.agent_id == pending.agent_id
        if actor is None:
            return False
        if actor.is_admin:
            return True
        return (
            actor.agent_id == pending.agent_id
            and actor.user_id == pending.user_id
            and actor.channel == pending.channel
            and actor.session_id == pending.session_id
            and actor.root_session_id == pending.root_session_id
        )

    async def get_request(self, request_id: str) -> PendingApproval | None:
        """Get a pending request by id."""
        async with self._lock:
            return self._pending.get(request_id)

    async def get_pending_by_session(
        self,
        session_id: str,
    ) -> PendingApproval | None:
        """Return the next pending approval for *session_id* (FIFO).

        Pending approvals are consumed in creation order, so repeated
        ``/approve`` inputs walk the queue from oldest to newest.
        """
        async with self._lock:
            for pending in self._pending.values():
                if (
                    pending.session_id == session_id
                    and pending.status == "pending"
                ):
                    return pending
        return None

    async def get_all_pending_by_session(
        self,
        session_id: str,
    ) -> list[PendingApproval]:
        """Return all pending approvals for *session_id* (FIFO order)."""
        async with self._lock:
            return [
                p
                for p in self._pending.values()
                if p.session_id == session_id and p.status == "pending"
            ]

    async def list_pending_by_session(
        self,
        session_id: str,
        include_subagents: bool = True,  # pylint: disable=unused-argument
    ) -> list[PendingApproval]:
        """List all pending approvals for a session (FIFO order).

        Args:
            session_id: Session ID to filter
            include_subagents: If False, exclude sub-agent approvals (future)

        Returns:
            List of pending approvals sorted by creation time
        """
        async with self._lock:
            result = [
                p
                for p in self._pending.values()
                if p.session_id == session_id and p.status == "pending"
            ]
            return sorted(result, key=lambda p: p.created_at)

    async def get_pending_by_root_session(
        self,
        root_session_id: str,
    ) -> list[PendingApproval]:
        """Get all pending approvals for root session and its children.

        Args:
            root_session_id: Root session ID

        Returns:
            List of pending approvals sorted by creation time (FIFO)
        """
        async with self._lock:
            result = [
                p
                for p in self._pending.values()
                if p.root_session_id == root_session_id
                and p.status == "pending"
            ]
            return sorted(result, key=lambda p: p.created_at)

    async def get_all_pending_by_agent(
        self,
        agent_id: str,
    ) -> list[PendingApproval]:
        """Get all pending approvals for an agent (across all sessions).

        Used by /approval list --all command.

        Args:
            agent_id: Agent ID

        Returns:
            List of pending approvals sorted by creation time (FIFO)
        """
        async with self._lock:
            result = [
                p
                for p in self._pending.values()
                if p.agent_id == agent_id and p.status == "pending"
            ]
            return sorted(result, key=lambda p: p.created_at)

    async def wait_for_approval(
        self,
        request_id: str | PendingApproval,
        timeout_seconds: float,
    ) -> ApprovalDecision:
        """Block and wait for approval decision with timeout.

        Args:
            request_id: Request ID or the record returned when created.
            timeout_seconds: Maximum wait time in seconds

        Returns:
            ApprovalDecision (APPROVED/DENIED/TIMEOUT)

        Raises:
            ValueError: If request_id not found
        """
        if isinstance(request_id, PendingApproval):
            # Retain decisions resolved before the consumer starts waiting.
            pending = request_id
        else:
            async with self._lock:
                pending = self._pending.get(request_id)

        if pending is None:
            raise ValueError(f"Approval request {request_id} not found")

        try:
            decision = await asyncio.wait_for(
                asyncio.shield(pending.future),
                timeout=max(
                    0.0,
                    min(
                        timeout_seconds,
                        pending.created_at
                        + pending.timeout_seconds
                        - time.time(),
                    ),
                ),
            )
        except asyncio.TimeoutError:
            await self.resolve_request(
                pending.request_id,
                ApprovalDecision.TIMEOUT,
            )
            # A response may have won the race with this waiter's timeout.
            decision = pending.future.result()

        return decision

    async def cancel_stale_pending_for_tool_call(
        self,
        session_id: str,
        tool_call_id: str,
    ) -> int:
        """Cancel pending approvals whose stored tool_call id matches.

        When a tool call is replayed (e.g. after approval triggers
        sibling replay), the guard may create a *new* pending for the
        same logical tool call.  This method cancels the old pending
        first so orphaned records don't accumulate.

        Returns the number of records cancelled.
        """
        now = time.time()
        cancelled = 0
        async with self._lock:
            to_cancel = [
                k
                for k, p in self._pending.items()
                if p.session_id == session_id
                and p.status == "pending"
                and isinstance(p.extra.get("tool_call"), dict)
                and p.extra["tool_call"].get("id") == tool_call_id
            ]
            for k in to_cancel:
                pending = self._pending.pop(k)
                if not pending.future.done():
                    pending.future.set_result(ApprovalDecision.TIMEOUT)
                pending.status = "superseded"
                pending.resolved_at = now
                _sdk_approval_changed(pending)
                cancelled += 1
        if cancelled:
            logger.info(
                "Tool guard: cancelled %d stale pending approval(s) "
                "for tool_call %s (session %s)",
                cancelled,
                tool_call_id,
                session_id[:8],
            )
        return cancelled

    async def cancel_request(
        self,
        request_id: str,
        *,
        actor: ApprovalActor,
    ) -> bool:
        """Cancel one owned pending request without affecting sibling calls."""
        async with self._lock:
            pending = self._pending.get(request_id)
            if pending is None or pending.status != "pending":
                return False
            if not self.actor_can_resolve(pending, actor):
                raise ApprovalIdentityMismatchError(
                    "approval caller does not match the original requester",
                )
            self._pending.pop(request_id)
            if not pending.future.done():
                pending.future.set_result(ApprovalDecision.DENIED)
            pending.status = "cancelled"
            pending.resolved_at = time.time()
            _sdk_approval_changed(pending)
            return True

    async def cancel_all_pending_by_root_session(
        self,
        root_session_id: str,
    ) -> int:
        """Cancel all pending approvals for root session and its children.

        Called when user stops/cancels a task (e.g., /stop command or
        SSE disconnect). Auto-denies all pending approvals to unblock
        waiting tasks.

        Args:
            root_session_id: Root session ID

        Returns:
            Number of approvals cancelled
        """
        now = time.time()
        cancelled = 0
        async with self._lock:
            to_cancel = [
                k
                for k, p in self._pending.items()
                if p.root_session_id == root_session_id
                and p.status == "pending"
            ]
            for k in to_cancel:
                pending = self._pending.pop(k)
                if not pending.future.done():
                    pending.future.set_result(ApprovalDecision.DENIED)
                pending.status = "cancelled"
                pending.resolved_at = now
                _sdk_approval_changed(pending)
                cancelled += 1
        if cancelled:
            logger.info(
                "Cancelled %d pending approval(s) for root session %s",
                cancelled,
                root_session_id[:8]
                if len(root_session_id) >= 8
                else root_session_id,
            )
        return cancelled

    # ------------------------------------------------------------------
    # Garbage collection
    # ------------------------------------------------------------------

    def _gc_pending_locked(self) -> None:
        """Evict stale pending records whose futures were never resolved.

        Caller must hold ``_lock``.
        """
        now = time.time()
        expired = [
            k
            for k, v in self._pending.items()
            if now - v.created_at > _GC_PENDING_MAX_AGE_SECONDS
        ]
        for k in expired:
            pending = self._pending.pop(k)
            if not pending.future.done():
                pending.future.set_result(ApprovalDecision.TIMEOUT)
            pending.status = "timeout"
            pending.resolved_at = now
            _sdk_approval_changed(pending)

        overflow = len(self._pending) - _GC_MAX_PENDING
        if overflow <= 0:
            return
        ordered = sorted(
            self._pending.items(),
            key=lambda item: item[1].created_at,
        )
        for key, pending in ordered[:overflow]:
            del self._pending[key]
            if not pending.future.done():
                pending.future.set_result(ApprovalDecision.TIMEOUT)
            pending.status = "timeout"
            pending.resolved_at = now
            _sdk_approval_changed(pending)


# ------------------------------------------------------------------
# Singleton
# ------------------------------------------------------------------

_approval_service: ApprovalService | None = None


def get_approval_service() -> ApprovalService:
    """Return the process-wide approval service singleton."""
    global _approval_service
    if _approval_service is None:
        _approval_service = ApprovalService()
    return _approval_service
