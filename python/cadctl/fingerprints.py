"""Face fingerprints: a rebuild-stable way to say "this is the same face".

A fingerprint is a small record (type, centroid, area, plus a normal for
planes or an axis and radius for cylinders and cones). Two builds of a model
never share face handles, so changes between builds are found by matching
fingerprints. The matching rule is mirrored in
``src/modules/model/build-changes.ts``; both sides are tested with the vectors
in ``tests/fixtures/face-fingerprints``.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

MAX_FINGERPRINTS = 5000
CENTROID_TOLERANCE = 1e-3  # relative to the larger bounding-box diagonal
AREA_TOLERANCE = 1e-3
DIRECTION_DOT = 0.9999
RADIUS_TOLERANCE = 1e-3

_AXIS_TYPES = {"CYLINDER", "CONE"}


def _round(values: Iterable[float]) -> list[float]:
    return [round(float(v), 4) for v in values]


def face_fingerprint(face: Any, index: int) -> dict[str, Any]:
    """Fingerprint one build123d face."""
    kind = str(face.geom_type.name)
    center = face.center()
    record: dict[str, Any] = {
        "i": index,
        "type": kind,
        "c": _round((center.X, center.Y, center.Z)),
        "a": round(float(face.area), 4),
    }
    if kind == "PLANE":
        normal = face.normal_at(center)
        record["n"] = _round((normal.X, normal.Y, normal.Z))
    elif kind in _AXIS_TYPES:
        try:
            axis = face.axis_of_rotation
            direction = axis.direction
            record["ax"] = _round((direction.X, direction.Y, direction.Z))
        except Exception:
            pass
        try:
            record["r"] = round(float(face.radius), 4)
        except Exception:
            pass
    return record


def shape_fingerprints(shape: Any, limit: int = MAX_FINGERPRINTS) -> tuple[list[dict[str, Any]], bool]:
    """Fingerprints of every face (capped), and whether the list was truncated."""
    faces = shape.faces()
    records = [face_fingerprint(face, index) for index, face in enumerate(faces[:limit])]
    return records, len(faces) > limit


def _dot(a: list[float], b: list[float]) -> float:
    return sum(float(x) * float(y) for x, y in zip(a, b))


def _norm(a: list[float]) -> float:
    return math.sqrt(sum(float(x) * float(x) for x in a))


def _unit_dot(a: list[float], b: list[float]) -> float:
    na, nb = _norm(a), _norm(b)
    if na < 1e-12 or nb < 1e-12:
        return 0.0
    return _dot(a, b) / (na * nb)


def _distance(a: list[float], b: list[float]) -> float:
    return math.sqrt(sum((float(x) - float(y)) ** 2 for x, y in zip(a, b)))


def _compatible(a: dict[str, Any], b: dict[str, Any], diagonal: float) -> float | None:
    """Centroid distance when the two fingerprints match, else None."""
    if a.get("type") != b.get("type"):
        return None
    distance = _distance(a["c"], b["c"])
    if distance > CENTROID_TOLERANCE * diagonal:
        return None
    area_a, area_b = float(a["a"]), float(b["a"])
    if abs(area_a - area_b) > AREA_TOLERANCE * max(abs(area_a), abs(area_b), 1e-12):
        return None
    kind = a.get("type")
    if kind == "PLANE" and "n" in a and "n" in b:
        if _unit_dot(a["n"], b["n"]) < DIRECTION_DOT:
            return None
    elif kind in _AXIS_TYPES:
        if "ax" in a and "ax" in b and abs(_unit_dot(a["ax"], b["ax"])) < DIRECTION_DOT:
            return None
        if "r" in a and "r" in b:
            ra, rb = float(a["r"]), float(b["r"])
            if abs(ra - rb) > RADIUS_TOLERANCE * max(abs(ra), abs(rb), 1e-12):
                return None
    return distance


def match_faces(
    before: list[dict[str, Any]], after: list[dict[str, Any]], diagonal: float
) -> dict[str, Any]:
    """Greedy one-to-one matching by ascending centroid distance.

    Returns positions in the two input lists: ``pairs`` (before, after),
    ``unmatchedBefore`` and ``unmatchedAfter``.
    """
    candidates: list[tuple[float, int, int]] = []
    for i, a in enumerate(before):
        for j, b in enumerate(after):
            distance = _compatible(a, b, diagonal)
            if distance is not None:
                candidates.append((distance, i, j))
    candidates.sort()
    used_before: set[int] = set()
    used_after: set[int] = set()
    pairs: list[list[int]] = []
    for _distance_value, i, j in candidates:
        if i in used_before or j in used_after:
            continue
        used_before.add(i)
        used_after.add(j)
        pairs.append([i, j])
    pairs.sort()
    return {
        "pairs": pairs,
        "unmatchedBefore": [i for i in range(len(before)) if i not in used_before],
        "unmatchedAfter": [j for j in range(len(after)) if j not in used_after],
    }
