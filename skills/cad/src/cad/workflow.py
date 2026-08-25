from __future__ import annotations

"""Procedural workflow projection and transition helpers."""

from typing import Any

from .client import request


async def current() -> dict[str, Any] | None:
    return await request("workflow-current")


async def advance(event: str) -> dict[str, Any]:
    return await request("workflow-advance", event=event)
