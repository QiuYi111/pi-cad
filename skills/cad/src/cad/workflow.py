from __future__ import annotations

"""Discover, pin, inspect, and advance compiled workflow packages."""

import builtins
from typing import Any

from .client import request


async def current() -> dict[str, Any] | None:
    return await request("workflow-current")


async def list() -> builtins.list[dict[str, Any]]:
    """Return bounded metadata for the newest installed version of each package."""
    return await request("workflow-list")


async def start(workflow_id: str, *, interaction_mode: str = "interactive") -> dict[str, Any]:
    """Compile and pin the currently installed version of ``workflow_id``."""
    if not workflow_id.strip():
        raise ValueError("workflow_id is required")
    return await request("workflow-start", id=workflow_id, interactionMode=interaction_mode)


async def advance(event: str) -> dict[str, Any]:
    return await request("workflow-advance", event=event)
