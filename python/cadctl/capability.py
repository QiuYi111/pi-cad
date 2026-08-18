from __future__ import annotations

from typing import Any


def capabilities() -> dict[str, Any]:
    from .doctor import doctor

    return doctor()["capabilities"]
