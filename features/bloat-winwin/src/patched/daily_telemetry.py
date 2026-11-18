# -*- coding: utf-8 -*-
"""Daily Runtime telemetry — REMOVED (bloat-winwin).

Upstream this module started a daemon sender thread at app startup
that POSTed a daily "runtime_active" event to an Alibaba Cloud
endpoint. This deployment forbids China endpoints. The stub keeps
every public name the rest of the codebase imports, as safe no-ops,
with NO thread, NO network code, NO endpoint import, and NO disk
writes:

- ``start_daily_telemetry`` returns a ``DailyTelemetry`` whose
  ``start`` does nothing (no thread is created) and whose async
  ``close`` / ``record`` are no-ops, so ``app/_app.py`` (which calls
  ``start_daily_telemetry()`` at lifespan start and awaits
  ``daily_telemetry.close()`` at shutdown) works unchanged.
- ``record_agent_activity`` is an async no-op, so the runtime and
  harness call sites work unchanged.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

_service = None  # No-op service instance (never sends anything).


class DailyTelemetry:
    """No-op stand-in for the removed daily telemetry sender."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory

    def start(self) -> None:
        """Telemetry removed: no sender thread is started."""
        return None

    async def close(self) -> None:
        """Telemetry removed: nothing to shut down."""
        return None

    async def record(self, day: str | None = None) -> bool:
        """Telemetry removed: nothing is recorded."""
        return False


def start_daily_telemetry() -> DailyTelemetry:
    """Attach the (removed) daily sender: returns a no-op service."""
    global _service  # pylint: disable=global-statement
    _service = DailyTelemetry()
    return _service


async def record_agent_activity() -> None:
    """Telemetry removed: agent activity is not recorded anywhere."""
    return None
