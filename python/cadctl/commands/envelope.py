"""Shared failure path for the cadctl command handlers.

Every handler prints one JSON envelope (``common.emit``) and returns an exit
code. ``fail`` is the single place that prints an error envelope, so the
failure shape stays the same across commands.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from ..common import emit_error, sha256_file


def elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def hash_or_empty(path: str | Path) -> str:
    """SHA-256 of ``path`` when it exists, else ``""`` (for error envelopes)."""
    path = Path(path)
    return sha256_file(path) if path.exists() else ""


def fail(
    tool: str,
    message: str,
    *,
    started: float,
    input_hashes: dict[str, str] | None = None,
    stderr: str = "",
    detail: dict[str, Any] | None = None,
    exit_code: int = 0,
) -> int:
    """Print an error envelope for ``tool`` and return ``exit_code``."""
    emit_error(
        tool,
        message,
        input_hashes=input_hashes,
        duration_ms=elapsed_ms(started),
        stderr=stderr,
        detail=detail,
    )
    return exit_code
