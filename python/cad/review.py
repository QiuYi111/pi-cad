from __future__ import annotations

from typing import Any

from .client import request


async def current() -> dict[str, Any] | None:
    return await request("review-current")


async def submit(_commit: Any = None) -> None:
    raise RuntimeError("Fresh Review must run through Prime's current extension context so it receives a fresh model session; use the Pi-CAD review action, then inspect await cad.review.current()")
