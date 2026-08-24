from __future__ import annotations

from typing import Any

from .client import request


async def current() -> dict[str, Any] | None:
    return await request("workflow-current")


async def advance(event: str) -> dict[str, Any]:
    return await request("workflow-advance", event=event)
