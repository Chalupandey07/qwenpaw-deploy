# -*- coding: utf-8 -*-
"""Authenticated Console endpoints for shared approval requests."""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..approvals import (
    ApprovalActor,
    PendingApproval,
    get_approval_service,
    ttl_answer,
    ttl_read,
)
from ..approvals.display import approval_display_fields
from ...security.tool_guard.approval import ApprovalDecision, ApprovalScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/approval", tags=["approval"])


def _console_admin_actor(
    request: Request,
    pending: PendingApproval,
) -> ApprovalActor:
    """Represent the authenticated/local Console as an explicit admin."""
    user = getattr(request.state, "user", None)
    username = (
        user.get("username", "console")
        if isinstance(user, dict)
        else "console"
    )
    return ApprovalActor(
        session_id=pending.session_id,
        root_session_id=pending.root_session_id,
        user_id=str(username),
        channel="console",
        agent_id=pending.agent_id,
        is_admin=True,
    )


class ApprovalActionRequest(BaseModel):
    """Request body for approval actions."""

    request_id: str = Field(..., description="Approval request ID (UUID)")
    session_id: str = Field(..., description="Session ID")
    user_id: Optional[str] = Field(
        None,
        description="User ID (optional, for validation)",
    )
    reason: Optional[str] = Field(
        None,
        description="Optional reason for denial",
    )
    scope: Optional[str] = Field(
        None,
        description=(
            "Approval scope for approve actions: 'exact' (record the "
            "literal target) or 'similar' (record the generalized "
            "pattern). Omitted/unknown defaults to 'exact'."
        ),
    )


class ApprovalActionResponse(BaseModel):
    """Response for approval actions."""

    success: bool
    message: str
    tool_name: Optional[str] = None
    request_id: str


class ApprovalListResponse(BaseModel):
    """Response for listing pending approvals."""

    pending_approvals: list[dict]
    count: int


@router.post(
    "/approve",
    response_model=ApprovalActionResponse,
    summary="Approve a pending tool execution",
)
async def post_approval_approve(
    request: Request,  # pylint: disable=unused-argument
    body: ApprovalActionRequest,
) -> ApprovalActionResponse:
    """Approve a pending tool execution.

    Resolves the Future associated with the approval request,
    allowing the agent to continue executing the tool.
    """
    svc = get_approval_service()

    logger.info(
        "Approval approve request: request_id=%s session_id=%s",
        body.request_id[:16],
        body.session_id,
    )

    # Verify the request belongs to the root session (support cross-session)
    pending = await svc.get_request(body.request_id)
    if pending is None:
        logger.warning(
            "Approval request not found: %s",
            body.request_id[:16],
        )
        raise HTTPException(
            status_code=404,
            detail=f"Approval request not found: {body.request_id[:16]}",
        )

    if pending.root_session_id != body.session_id:
        logger.warning(
            "Root session mismatch: request %s (root: %s) not in session %s",
            body.request_id[:16],
            pending.root_session_id,
            body.session_id,
        )
        raise HTTPException(
            status_code=403,
            detail="Root session mismatch: cannot approve other session trees",
        )

    # Parse the approval scope. Unknown / omitted values fall back to None,
    # which the governance consumer treats as EXACT (least-privilege).
    scope: ApprovalScope | None = None
    if body.scope:
        try:
            scope = ApprovalScope(body.scope.strip().lower())
        except ValueError:
            logger.info(
                "Approval approve: unknown scope %r, defaulting to exact",
                body.scope,
            )
            scope = None

    # Approval TTL (T132): refuse a late answer before resolving the
    # Future. ttl_answer runs off the event loop (blocking file I/O).
    # "expired" means the card waited out its TTL — unblock the
    # waiting agent call as denied, then refuse the late approval so
    # the Future never resolves approved after expiry. "unknown" /
    # "answered" fall through to the normal resolve path below.
    outcome, _denial = await asyncio.to_thread(
        ttl_answer, body.request_id, True)
    if outcome == "expired":
        await svc.resolve_request(
            body.request_id,
            ApprovalDecision.DENIED,
            actor=_console_admin_actor(request, pending),
        )
        raise HTTPException(
            status_code=409,
            detail="approval_expired: This request expired before it "
            "was answered.",
        )

    # Resolve the Future
    resolved = await svc.resolve_request(
        body.request_id,
        ApprovalDecision.APPROVED,
        scope=scope,
        actor=_console_admin_actor(request, pending),
    )
    if resolved is None:
        raise HTTPException(
            status_code=409,
            detail=f"Approval request already resolved or expired",
        )

    logger.info(
        "Approval approved: request_id=%s session=%s tool=%s",
        body.request_id[:16],
        body.session_id,
        resolved.tool_name,
    )

    return ApprovalActionResponse(
        success=True,
        message=f"Tool '{resolved.tool_name}' approved, executing...",
        tool_name=resolved.tool_name,
        request_id=body.request_id,
    )


@router.post(
    "/deny",
    response_model=ApprovalActionResponse,
    summary="Deny a pending tool execution",
)
async def post_approval_deny(
    request: Request,  # pylint: disable=unused-argument
    body: ApprovalActionRequest,
) -> ApprovalActionResponse:
    """Deny a pending tool execution.

    Resolves the Future with DENIED decision, preventing
    the agent from executing the tool.
    """
    svc = get_approval_service()

    reason = body.reason or "User denied"

    logger.info(
        "Approval deny request: request_id=%s session_id=%s reason=%s",
        body.request_id[:16],
        body.session_id,
        reason,
    )

    # Verify the request belongs to the root session (support cross-session)
    pending = await svc.get_request(body.request_id)
    if pending is None:
        logger.warning(
            "Approval request not found: %s",
            body.request_id[:16],
        )
        raise HTTPException(
            status_code=404,
            detail=f"Approval request not found: {body.request_id[:16]}",
        )

    if pending.root_session_id != body.session_id:
        logger.warning(
            "Root session mismatch: request %s (root: %s) not in session %s",
            body.request_id[:16],
            pending.root_session_id,
            body.session_id,
        )
        raise HTTPException(
            status_code=403,
            detail="Root session mismatch: cannot approve other session trees",
        )

    # Approval TTL (T132): refuse a late answer before resolving the
    # Future. On expiry the waiting call is already denied by the
    # resolve below, so the handler only refuses the late answer.
    outcome, _denial = await asyncio.to_thread(
        ttl_answer, body.request_id, False)
    if outcome == "expired":
        await svc.resolve_request(
            body.request_id,
            ApprovalDecision.DENIED,
            actor=_console_admin_actor(request, pending),
        )
        raise HTTPException(
            status_code=409,
            detail="approval_expired: This request expired before it "
            "was answered.",
        )

    # Resolve the Future
    resolved = await svc.resolve_request(
        body.request_id,
        ApprovalDecision.DENIED,
        actor=_console_admin_actor(request, pending),
    )
    if resolved is None:
        raise HTTPException(
            status_code=409,
            detail=f"Approval request already resolved or expired",
        )

    logger.info(
        "Approval denied: request_id=%s session=%s tool=%s",
        body.request_id[:16],
        body.session_id,
        resolved.tool_name,
    )

    return ApprovalActionResponse(
        success=True,
        message=f"Tool '{resolved.tool_name}' denied: {reason}",
        tool_name=resolved.tool_name,
        request_id=body.request_id,
    )


@router.get(
    "/list",
    response_model=ApprovalListResponse,
    summary="List pending approval requests",
)
async def get_approval_list(
    request: Request,  # pylint: disable=unused-argument
    session_id: Optional[str] = None,
) -> ApprovalListResponse:
    """List all pending approval requests.

    Optionally filter by session_id.
    """
    svc = get_approval_service()

    if session_id:
        logger.debug(
            "Listing approvals for root session (includes children): %s",
            session_id,
        )
        # Use get_pending_by_root_session for cross-session support
        pending_list = await svc.get_pending_by_root_session(session_id)
    else:
        logger.debug("Listing all pending approvals")
        # pylint: disable=protected-access
        async with svc._lock:
            pending_list = list(svc._pending.values())

    # Serialize pending approvals
    result = []
    for pending in pending_list:
        result.append(
            {
                "request_id": pending.request_id,
                "session_id": pending.session_id,
                "root_session_id": pending.root_session_id,
                "owner_agent_id": pending.owner_agent_id,
                "agent_id": pending.agent_id,
                "tool_name": pending.tool_name,
                **approval_display_fields(pending),
                "severity": pending.severity,
                "findings_count": pending.findings_count,
                "created_at": pending.created_at,
                "timeout_seconds": pending.timeout_seconds,
                "result_summary": pending.result_summary,
                "reasoning": pending.extra.get("reasoning", ""),
            },
        )

    # Approval TTL (T132): an expired card renders as expired, not as
    # a live Approve/Deny button; a pending card carries its expiry
    # so the UI can show a countdown. ttl_read is pure — listing
    # never mutates the store. Cards absent from the store (created
    # before the wiring) render unchanged.
    for entry in result:
        state = await asyncio.to_thread(ttl_read, entry["request_id"])
        if state is None:
            continue
        if state.get("status") == "denied" and state.get("expired"):
            entry["expired"] = True
            entry["card"] = state.get("card")
            entry["reason"] = state.get("reason")
        elif state.get("status") == "pending":
            entry["expires_at_ms"] = state.get("expires_at_ms")

    logger.info("Listed %d pending approvals", len(result))

    return ApprovalListResponse(
        pending_approvals=result,
        count=len(result),
    )
