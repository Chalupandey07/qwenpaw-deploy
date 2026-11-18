# -*- coding: utf-8 -*-
"""Telemetry collection — REMOVED (bloat-winwin).

Upstream QwenPaw phoned installation/runtime analytics home to an
Alibaba Cloud endpoint. This deployment forbids China endpoints, and
the deployment was already opted out by env var — but the code and
the daily sender thread were still present. This stub keeps every
public name the rest of the codebase imports, as safe no-ops, with
NO endpoint constant, NO network code, NO OS probes, and NO
disk writes:

- ``is_telemetry_opted_out`` always True, so the startup upload in
  ``app/_app.py`` is skipped before it can run.
- ``has_telemetry_been_collected`` always True, so the same call site
  can never fall through to an upload.
- ``collect_and_upload_telemetry`` always False (nothing collected,
  nothing uploaded).
- ``mark_telemetry_collected`` / ``telemetry_marker`` write nothing;
  the marker file is never created or read.
- ``get_system_info`` / ``get_environment_info`` return empty dicts.
- ``TELEMETRY_MARKER_FILE`` keeps its exact string value: the CLI
  clean command uses it only as a filename to preserve during a
  clean, not as telemetry.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

TELEMETRY_MARKER_FILE = ".telemetry_collected"


def get_system_info() -> dict[str, Any]:
    """Telemetry removed: no system information is collected."""
    return {}


def get_environment_info() -> dict[str, Any]:
    """Telemetry removed: no environment information is collected."""
    return {}


def has_telemetry_been_collected(working_dir: Path) -> bool:
    """Telemetry removed: report collected so no upload is attempted."""
    return True


def is_telemetry_opted_out(working_dir: Path) -> bool:
    """Telemetry removed: always opted out."""
    return True


@contextmanager
def telemetry_marker(working_dir: Path) -> Iterator[dict[str, Any]]:
    """Telemetry removed: yield a throwaway dict, write nothing."""
    yield {}


def mark_telemetry_collected(
    working_dir: Path,
    *,
    opted_out: bool = False,
) -> None:
    """Telemetry removed: no marker file is written."""
    return None


def _upload_telemetry_sync(data: dict[str, Any]) -> bool:
    """Telemetry removed: no upload is ever attempted."""
    return False


def collect_and_upload_telemetry(working_dir: Path) -> bool:
    """Telemetry removed: nothing is collected or uploaded."""
    return False
