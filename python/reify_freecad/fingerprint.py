"""Face fingerprints (pure Python). Same rule as ``cadctl.fingerprints``."""

from __future__ import annotations

import math
from typing import Any

CENTROID_TOLERANCE = 1e-3
AREA_TOLERANCE = 1e-3
DIRECTION_DOT = 0.9999
RADIUS_TOLERANCE = 1e-3
_AXIS_TYPES = {"CYLINDER", "CONE"}


def _unit_dot(a: list[float], b: list[float]) -> float:
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na < 1e-12 or nb < 1e-12:
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def _compatible(a: dict[str, Any], b: dict[str, Any], diagonal: float) -> float | None:
    if a.get("type") != b.get("type"):
        return None
    gap = math.dist(a["c"], b["c"])
    if gap > CENTROID_TOLERANCE * diagonal:
        return None
    if abs(a["a"] - b["a"]) > AREA_TOLERANCE * max(abs(a["a"]), abs(b["a"]), 1e-12):
        return None
    if a["type"] == "PLANE" and "n" in a and "n" in b:
        if _unit_dot(a["n"], b["n"]) < DIRECTION_DOT:
            return None
    elif a["type"] in _AXIS_TYPES:
        if "ax" in a and "ax" in b and abs(_unit_dot(a["ax"], b["ax"])) < DIRECTION_DOT:
            return None
        if "r" in a and "r" in b and abs(a["r"] - b["r"]) > RADIUS_TOLERANCE * max(abs(a["r"]), abs(b["r"]), 1e-12):
            return None
    return gap


def match_faces(before: list[dict[str, Any]], after: list[dict[str, Any]], diagonal: float) -> dict[str, Any]:
    candidates = []
    for i, a in enumerate(before):
        for j, b in enumerate(after):
            gap = _compatible(a, b, diagonal)
            if gap is not None:
                candidates.append((gap, i, j))
    candidates.sort()
    used_b: set[int] = set()
    used_a: set[int] = set()
    pairs: list[list[int]] = []
    for _gap, i, j in candidates:
        if i in used_b or j in used_a:
            continue
        used_b.add(i)
        used_a.add(j)
        pairs.append([i, j])
    pairs.sort()
    return {
        "pairs": pairs,
        "unmatchedBefore": [i for i in range(len(before)) if i not in used_b],
        "unmatchedAfter": [j for j in range(len(after)) if j not in used_a],
    }
