from __future__ import annotations

"""Procedural workflow projection and transition helpers."""

from typing import Any

from .client import request


async def current() -> dict[str, Any] | None:
    return await request("workflow-current")


async def start(reason: str, *, interaction_mode: str = "interactive") -> dict[str, Any]:
    """Start the project-selected immutable workflow explicitly."""
    return await request("workflow-start", reason=reason, interactionMode=interaction_mode)


async def route(
    objective: str,
    *,
    lineage: str | None = None,
    structure: str | None = None,
    maturity: str | None = None,
    reason: str,
) -> dict[str, Any]:
    """Replace Mechanical intake with the fully specified task workflow."""
    if objective in {"analyze", "convert"}:
        if any(value is not None for value in (lineage, structure, maturity)):
            raise ValueError(f"{objective} routes accept only objective")
        selected: dict[str, str] = {"objective": objective}
    elif objective == "design":
        if None in {lineage, structure, maturity}:
            raise ValueError("design routes require lineage, structure, and maturity")
        selected = {"objective": objective, "lineage": lineage, "structure": structure, "maturity": maturity}  # type: ignore[dict-item]
    else:
        raise ValueError(f"unsupported CAD objective: {objective}")
    return await request("workflow-route", route=selected, reason=reason)


async def advance(event: str) -> dict[str, Any]:
    return await request("workflow-advance", event=event)
