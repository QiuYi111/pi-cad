from __future__ import annotations

"""Living Plan helpers backed by the immutable workspace commit chain."""

from pathlib import Path
from typing import Any


async def current():
    """Return the latest commit named ``plan``, or ``None``."""
    from . import history, load

    matches = [item for item in await history() if item.name == "plan"]
    return await load(matches[-1].id) if matches else None


async def update(
    *,
    variables: dict[str, Any] | None = None,
    artifacts: list[str | Path | Any] | None = None,
):
    """Append a new current Plan while preserving every prior version."""
    from . import commit

    return await commit("plan", variables=variables, artifacts=artifacts)
