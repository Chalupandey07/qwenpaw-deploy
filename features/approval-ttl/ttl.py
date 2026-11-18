#!/usr/bin/env python3
"""Approval TTL (gap #18, T132) — port of gogibeta/rakazo PR #50 (F6).

A pending approval card or secret request expires after a time-to-live
instead of sitting open forever. When nobody answers in time the request
resolves as a denial — the bot carries on without doing the action — and
the card shows it expired. A late answer is refused, in the app and in
chat apps. This module is the repo-side port; it is NOT wired into
QwenPaw's live approval-card path yet (that needs a derived-image change
by the parent — see README.md). Until then it is a correct, tested
model of the rule, not live enforcement.

Port notes (fork PR #50, verified from the PR body + diff 2026-11-18):
- The fork stamps `external_effects.expiresAt` when an effect is
  recorded, from env `APPROVAL_TTL` (ms, default 86400000 = 24h), one
  value for every surface. Its answer path checks expiry under the
  thread lock (`AnswerExpiredError`: "This request expired before it
  was answered."), and a job-reconciler sweep resolves waiting asks
  past expiry. Expiry denies the effect (approval) or completes a
  secret request like a dismissal with `{ok: false, expired: true}`.
  The card is recorded answered with `answer: "expired"`. Audit writes
  `tool.approval_decision` with actor `system`, outcome `denied`, and
  metadata `{tool, decision: "expired", via: "sweep" | "answer",
  ageMs}`. Plain questions carry no effect and never expire. Effects
  recorded before the migration carry no expiry and are never swept.
- Deliberate divergences from the fork (see README.md for why):
  (1) per-type TTLs — secrets expire faster than approvals
  (approval 24h, secret 1h), each with its own env var;
  (2) the store is a JSON file (not a database table) with an
  exclusive file lock, because QwenPaw's PendingApproval lives in
  container memory and the repo has no database to add a column to;
  (3) `read()` is pure — it reports the effective state but never
  mutates — so a poller cannot mislabel audit or race the sweep.
  The fork's answer-path check + sweep are the mutation points, and
  this port keeps exactly that shape.

Enforcement contract (the part that must never break):
- An expired item NEVER reads as pending and NEVER approves.
  `read()` on an expired item returns denied with reason "timed out".
- `answer()` on an expired item persists the expired terminal state
  (with the audit row) and then raises `ExpiredError` — the late
  approval is never applied.
- Terminal state is sticky and is checked BEFORE the clock, so a clock
  rollback can never resurrect an expired or answered card.
- Expiry is a pure function of the stored `expires_at_ms` and now, so
  a restart cannot resurrect a stale card: the timestamp survives in
  the file and every read after the restart still denies it.
- A bad TTL env value can never make approvals expire instantly: an
  unparsable value, or one below the 1-second floor, falls back to the
  default (the fork's rule, verified from its test).

Concurrency: every read-modify-write (issue / answer / sweep) runs
inside an exclusive `fcntl.flock` on `<store>.lock`, re-reading the
store after acquiring the lock — so a sweep and a late answer cannot
lose each other's update. `read()` takes no lock: `os.replace` gives
it a consistent old-or-new snapshot, and it mutates nothing. Unix
only (fcntl); the machine and this VM are Linux.

All timestamps are epoch milliseconds, UTC. No local time anywhere.

Usage:
    python3 ttl.py sweep --store PATH [--lock-timeout SECONDS]
    python3 ttl.py check --store PATH
    python3 ttl.py issue --store PATH --kind approval|secret|question
                         --request-id ID --tool TOOL [--session-id S]
Stdlib only.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path

TTL_VERSION = 1
# Fork default (24h) for approvals; secrets expire faster (1h) — the
# per-type divergence, required by the task. Env overrides below.
DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
DEFAULT_SECRET_TTL_MS = 60 * 60 * 1000
MIN_TTL_MS = 1000  # fork floor: below 1s falls back to the default
MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000  # 30 days; above is effectively no TTL
MAX_AUDIT_ROWS = 1000

ENV_VARS = {
    "approval": "APPROVAL_TTL_MS",
    "secret": "SECRET_REQUEST_TTL_MS",
}
DEFAULT_TTLS_MS = {
    "approval": DEFAULT_APPROVAL_TTL_MS,
    "secret": DEFAULT_SECRET_TTL_MS,
}
KINDS = ("approval", "secret", "question")

EXPIRED_ANSWER = "expired"  # fork: EXPIRED_ASK_ANSWER
EXPIRED_REASON = "timed out"  # the reason surfaced to the user
EXPIRED_SECRET_RESULT = {"ok": False, "expired": True}  # fork
EXPIRED_SECRET_PROMPT = "The request expired before it was answered."  # fork
EXPIRED_CARD_COPY = {
    "approval": "This approval expired",  # fork AskCard copy
    "secret": "Expired",  # fork SecretAskCard copy
}
EXPIRED_ERROR_MESSAGE = "This request expired before it was answered."  # fork


class ExpiredError(Exception):
    """A late answer on an item that already expired (fork: AnswerExpiredError)."""


class AlreadyAnsweredError(Exception):
    """An answer on an item that is already terminal (approved/denied/expired)."""


class CorruptStoreError(Exception):
    """The store file exists but is not a readable pending-item store."""


class UnknownRequestError(KeyError):
    """No item with this request_id exists in the store."""


def utcnow_ms() -> int:
    return int(time.time() * 1000)


def ttl_ms_for(kind: str, env: dict | None = None) -> int | None:
    """TTL in ms for a kind, honouring the env override.

    Follows the fork's parsing rule (`approvalTtlMs`): the env value is
    parsed as a number; if it is finite and at least the 1-second floor
    it is used (floored), otherwise the default applies — so a bad value
    can never make approvals expire instantly. A value above the 30-day
    cap also falls back (effectively no TTL). `question` never expires
    (returns None). The env is read at issue time only; changing it
    later never moves an existing item's `expires_at_ms`.
    """
    if kind == "question":
        return None
    if kind not in DEFAULT_TTLS_MS:
        raise ValueError(f"unknown kind {kind!r} (expected one of {KINDS})")
    default = DEFAULT_TTLS_MS[kind]
    raw = (env if env is not None else os.environ).get(ENV_VARS[kind])
    if raw is None or str(raw).strip() == "":
        return default
    try:
        parsed = float(str(raw).strip())
    except (TypeError, ValueError):
        return default
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return default
    if parsed < MIN_TTL_MS or parsed > MAX_TTL_MS:
        return default
    return int(parsed)


def is_legacy(item: dict) -> bool:
    """A pre-migration item: no ttl_version and no expires_at.

    The fork's migration rule: effects recorded before the TTL column
    existed carry no expiry and are never swept. Such an item stays
    answerable forever and is counted separately by `check`.
    """
    return "ttl_version" not in item and item.get("expires_at_ms") is None


def _invalid_expiry(item: dict) -> bool:
    """A post-migration item whose expiry is missing or unusable.

    Any record this module stamped carries `ttl_version`; if such a
    record has no valid `expires_at_ms` (truncated write, manual edit,
    a code path that forgot `issue()`), it fails closed as expired —
    it is never left immortal the way a legacy item is.
    """
    if "ttl_version" not in item:
        return False
    expires_at = item.get("expires_at_ms")
    return not isinstance(expires_at, int) or isinstance(expires_at, bool)


def is_expired(item: dict, now_ms: int) -> bool:
    """True when a pending item has waited out its TTL.

    Boundary: now == expires_at counts as expired (>=, not >) — the
    same boundary the routines Worker's `expires_at > now` read
    enforces. Legacy items never expire; a post-migration item with a
    missing/invalid expiry fails closed as expired.
    """
    if item.get("status") != "pending":
        return False
    if item.get("kind") == "question":
        return False  # plain questions carry no effect and never expire
    if is_legacy(item):
        return False
    if _invalid_expiry(item):
        return True
    return now_ms >= item["expires_at_ms"]


def effective_state(item: dict, now_ms: int) -> str:
    """The state a caller must act on: "pending" or "denied" (expired).

    Pure — it never mutates. A terminal item reports its stored
    status; a pending item past its TTL reports denied.
    """
    if item.get("status") != "pending":
        return item["status"]
    return "denied" if is_expired(item, now_ms) else "pending"


def denial_for(item: dict) -> dict:
    """The denial dict an expired item resolves to.

    The shape the runtime already understands: a denial with a
    do-not-retry instruction, so the model does not immediately
    re-issue the call with tweaked parameters (the same instruction
    QwenPaw's approval path attaches to a denied call).
    """
    kind = item.get("kind", "approval")
    return {
        "request_id": item["request_id"],
        "kind": kind,
        "tool": item.get("tool"),
        "status": "denied",
        "reason": EXPIRED_REASON,
        "expired": True,
        "do_not_retry": True,
        "card": EXPIRED_CARD_COPY.get(kind, "This approval expired"),
    }


def _audit_row(item: dict, via: str, now_ms: int) -> dict:
    """One audit row, in the fork's shape (snake_case).

    Fork: `tool.approval_decision`, actor `system`, outcome `denied`,
    metadata `{tool, decision: "expired", via: "sweep" | "answer",
    ageMs}`. `age_ms` is how long the item waited past its expiry
    (0 when the expiry itself is invalid and the item failed closed).
    """
    expires_at = item.get("expires_at_ms")
    age_ms = max(0, now_ms - expires_at) if isinstance(expires_at, int) else 0
    return {
        "actor": "system",
        "outcome": "denied",
        "tool": item.get("tool"),
        "request_id": item["request_id"],
        "decision": "expired",
        "via": via,
        "age_ms": age_ms,
        "at_ms": now_ms,
    }


def _new_item(kind: str, request_id: str, tool: str | None,
              session_id: str | None, now_ms: int,
              env: dict | None) -> dict:
    ttl = ttl_ms_for(kind, env)
    return {
        "request_id": request_id,
        "kind": kind,
        "tool": tool,
        "session_id": session_id,
        "status": "pending",
        "answer": None,
        "created_at_ms": now_ms,
        "expires_at_ms": None if ttl is None else now_ms + ttl,
        "ttl_version": TTL_VERSION,
        "answered_at_ms": None,
        "via": None,
        "reason": None,
        "result": None,
    }


def _expire_item(item: dict, via: str, now_ms: int) -> dict:
    """Resolve a pending item by expiry, in place (fork: expireLocatedAsk).

    An approval is denied; a secret request settles like a dismissal
    with an expired result and the expired prompt the resumed run
    sees. The card is recorded answered with `answer: "expired"` so
    every surface renders it as expired. Returns the audit row.
    """
    item["answered_at_ms"] = now_ms
    item["answer"] = EXPIRED_ANSWER
    item["via"] = via
    item["reason"] = EXPIRED_REASON
    if item.get("kind") == "secret":
        item["status"] = "completed"
        item["result"] = dict(EXPIRED_SECRET_RESULT)
        item["resume_prompt"] = EXPIRED_SECRET_PROMPT
    else:
        item["status"] = "denied"
    return _audit_row(item, via, now_ms)


class CardStore:
    """A JSON file of pending approval/secret items + audit rows.

    `{version, items: [...], audit: [...]}`. Writes are atomic (temp
    file in the same directory + flush + fsync + os.replace + a
    best-effort directory fsync) and the file is mode 0600 — it holds
    the queue of things the owner has not answered yet, and a restart
    must find it intact. A missing file is an empty store; a 0-byte
    file is an empty store; anything else that does not parse as the
    expected shape raises CorruptStoreError — never a silent empty
    store, so a corrupt file can never be mistaken for "nothing
    pending" (which would be an allow path).
    """

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.lock_path = Path(str(self.path) + ".lock")

    def empty(self) -> dict:
        return {"version": TTL_VERSION, "items": [], "audit": []}

    def load(self) -> dict:
        if not self.path.exists():
            return self.empty()
        raw = self.path.read_bytes()
        if raw.strip() == b"":
            return self.empty()
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise CorruptStoreError(f"{self.path}: not valid JSON: {exc}") from exc
        if (not isinstance(data, dict) or not isinstance(data.get("items"), list)
                or not isinstance(data.get("audit"), list)):
            raise CorruptStoreError(
                f"{self.path}: expected an object with 'items' and 'audit' lists")
        return data

    def save(self, data: dict) -> None:
        data["audit"] = data.get("audit", [])[-MAX_AUDIT_ROWS:]
        data["version"] = TTL_VERSION
        tmp = self.path.with_name(f".{self.path.name}.tmp.{os.getpid()}")
        blob = (json.dumps(data, indent=2, sort_keys=True) + "\n").encode("utf-8")
        with open(tmp, "wb") as fh:
            fh.write(blob)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)
        try:
            dir_fd = os.open(str(self.path.parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass  # directory fsync is best-effort (not all filesystems)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @contextmanager
    def locked(self, timeout: float = 10.0):
        """Exclusive flock around a read-modify-write, re-reading inside.

        The lock file is `<store>.lock` (mode 0600). A caller that
        cannot acquire the lock within `timeout` gets TimeoutError —
        it must not proceed with a stale snapshot, or its write would
        resurrect the other writer's update (the lost-update hole).
        """
        fd = os.open(str(self.lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.chmod(self.lock_path, 0o600)
        except OSError:
            pass
        deadline = time.monotonic() + timeout
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            f"could not acquire the approval-TTL store lock "
                            f"({self.lock_path}) within {timeout}s") from None
                    time.sleep(0.05)
            yield
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)

    def find(self, data: dict, request_id: str) -> dict | None:
        for item in data["items"]:
            if item.get("request_id") == request_id:
                return item
        return None


def issue(store: CardStore, kind: str, request_id: str, tool: str | None,
          session_id: str | None = None, now_ms: int | None = None,
          env: dict | None = None, lock_timeout: float = 10.0) -> dict:
    """Record a pending item, stamping its expiry (fork: recordEffect).

    Re-issuing an existing request_id is an idempotent no-op: the
    existing record is returned unchanged (no new expiry, no duplicate
    item) — the fork's idempotency-key behaviour.
    """
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind!r} (expected one of {KINDS})")
    if not request_id:
        raise ValueError("request_id must not be empty")
    now = utcnow_ms() if now_ms is None else now_ms
    with store.locked(timeout=lock_timeout):
        data = store.load()
        existing = store.find(data, request_id)
        if existing is not None:
            return existing
        item = _new_item(kind, request_id, tool, session_id, now, env)
        data["items"].append(item)
        store.save(data)
        return item


def read(store: CardStore, request_id: str,
         now_ms: int | None = None) -> dict:
    """The effective state of an item. PURE — it never mutates.

    A pending item past its TTL returns the denial (reason
    "timed out", never pending, never allow); a pending item inside
    its TTL returns pending; a terminal item returns its stored
    state. The expiry is computed from the stored `expires_at_ms`,
    so a restart cannot resurrect a stale card. Unknown ids raise
    UnknownRequestError.
    """
    now = utcnow_ms() if now_ms is None else now_ms
    item = store.find(store.load(), request_id)
    if item is None:
        raise UnknownRequestError(request_id)
    if item.get("status") != "pending":
        return {"request_id": item["request_id"], "kind": item.get("kind"),
                "tool": item.get("tool"), "status": item["status"],
                "answer": item.get("answer")}
    if is_expired(item, now):
        return denial_for(item)
    return {"request_id": item["request_id"], "kind": item.get("kind"),
            "tool": item.get("tool"), "status": "pending",
            "expires_at_ms": item.get("expires_at_ms")}


def answer(store: CardStore, request_id: str, approve: bool,
           now_ms: int | None = None, reason: str | None = None,
           lock_timeout: float = 10.0) -> dict:
    """Answer a pending item. Terminal state is checked BEFORE the clock.

    - Pending + inside its TTL: records approved/denied and returns it.
    - Pending + past its TTL: persists the expired terminal state
      (with the audit row, via "answer") and then raises ExpiredError
      — the late approval is never applied (fork: AnswerExpiredError).
    - Already terminal: raises AlreadyAnsweredError — the stored
      decision is never flipped, whatever the clock says (a clock
      rollback cannot resurrect it).
    - A question item carries no effect to answer: raises ValueError.
    """
    now = utcnow_ms() if now_ms is None else now_ms
    with store.locked(timeout=lock_timeout):
        data = store.load()
        item = store.find(data, request_id)
        if item is None:
            raise UnknownRequestError(request_id)
        if item.get("status") != "pending":
            raise AlreadyAnsweredError(
                f"{request_id} is already {item.get('status')} "
                f"(answer {item.get('answer')!r}); refusing to flip it")
        if item.get("kind") == "question":
            raise ValueError(
                f"{request_id} is a plain question: it carries no effect "
                f"to approve or deny")
        if is_expired(item, now):
            row = _expire_item(item, "answer", now)
            data["audit"].append(row)
            store.save(data)
            raise ExpiredError(EXPIRED_ERROR_MESSAGE)
        item["status"] = "approved" if approve else "denied"
        item["answer"] = "approved" if approve else "denied"
        item["answered_at_ms"] = now
        item["via"] = "answer"
        item["reason"] = reason
        store.save(data)
        return {"request_id": item["request_id"], "kind": item.get("kind"),
                "tool": item.get("tool"), "status": item["status"],
                "answer": item["answer"]}


def sweep(store: CardStore, now_ms: int | None = None,
          lock_timeout: float = 10.0) -> list[dict]:
    """Resolve every pending item past its TTL (fork: approval-expiry sweeper).

    Only items still pending inside the lock are resolved — the
    conditional-update equivalent of the fork's
    `updateMany({status: "waiting_input"})` guard, so a concurrent
    answer that won the race is never overwritten. Legacy items (no
    expiry, pre-migration) are never swept; a post-migration item with
    a missing/invalid expiry fails closed as expired. Idempotent: a
    second sweep finds nothing. Returns one dict per expired item:
    `{request_id, kind, age_ms}`.
    """
    now = utcnow_ms() if now_ms is None else now_ms
    expired: list[dict] = []
    with store.locked(timeout=lock_timeout):
        data = store.load()
        for item in data["items"]:
            if item.get("status") != "pending":
                continue
            if is_legacy(item):
                continue
            if not is_expired(item, now):
                continue
            row = _expire_item(item, "sweep", now)
            data["audit"].append(row)
            expired.append({"request_id": item["request_id"],
                            "kind": item.get("kind"),
                            "age_ms": row["age_ms"]})
        if expired:
            store.save(data)
    return expired


def check_counts(store: CardStore, now_ms: int | None = None) -> dict:
    """Stored-state counts for the operator (read-only).

    pending: still waiting inside its TTL. stale: pending but past
    expiry (the sweep would resolve these). expired: terminal with
    answer "expired". legacy: pending pre-migration items with no
    expiry (never swept). answered: terminal approved/denied/completed
    that did not expire. The five sum to the item count.
    """
    now = utcnow_ms() if now_ms is None else now_ms
    counts = {"pending": 0, "stale": 0, "expired": 0, "legacy": 0,
              "answered": 0, "total": 0}
    for item in store.load()["items"]:
        counts["total"] += 1
        if item.get("status") != "pending":
            if item.get("answer") == EXPIRED_ANSWER:
                counts["expired"] += 1
            else:
                counts["answered"] += 1
        elif is_legacy(item):
            counts["legacy"] += 1
        elif is_expired(item, now):
            counts["stale"] += 1
        else:
            counts["pending"] += 1
    return counts


def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="Approval TTL: expire pending approvals + secret requests.")
    sub = parser.add_subparsers(dest="command", required=True)
    p_sweep = sub.add_parser("sweep", help="resolve pending items past their TTL")
    p_sweep.add_argument("--store", required=True)
    p_sweep.add_argument("--lock-timeout", type=float, default=10.0)
    p_sweep.add_argument("--now-ms", type=int, default=None)
    p_check = sub.add_parser("check", help="report stored-state counts")
    p_check.add_argument("--store", required=True)
    p_issue = sub.add_parser("issue", help="record a pending item")
    p_issue.add_argument("--store", required=True)
    p_issue.add_argument("--kind", choices=list(KINDS), required=True)
    p_issue.add_argument("--request-id", required=True)
    p_issue.add_argument("--tool", default=None)
    p_issue.add_argument("--session-id", default=None)
    args = parser.parse_args()
    store = CardStore(args.store)
    try:
        if args.command == "sweep":
            expired = sweep(store, now_ms=args.now_ms,
                            lock_timeout=args.lock_timeout)
            if expired:
                for entry in expired:
                    print(f"expired {entry['request_id']} "
                          f"({entry['kind']}, age {entry['age_ms']} ms)")
            else:
                print("no expired approvals")
            return 0
        if args.command == "check":
            counts = check_counts(store)
            print("pending={pending} stale={stale} expired={expired} "
                  "legacy={legacy} answered={answered} total={total}"
                  .format(**counts))
            return 0
        item = issue(store, args.kind, args.request_id, args.tool,
                     session_id=args.session_id)
        print(json.dumps(item, sort_keys=True))
        return 0
    except CorruptStoreError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except TimeoutError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(_cli())
