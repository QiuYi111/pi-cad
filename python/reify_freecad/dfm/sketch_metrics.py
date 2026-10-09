"""Width and corner metrics of one closed sketch loop (pure Python, no FreeCAD).

Input loop: ``{"geometry": [items in drawing order], "orient": [bool, ...]}`` where the items are
the sketch geometry dicts of ``transfer._geometry`` (line / arc / circle, with ``id``) and
``orient[i]`` is True when item i is traversed from its end to its start (see
``transfer_geometry.build_loops``).

Corners are described relative to the loop's own region: ``concave`` means the region has a
reflex vertex there (material corner), so a pocket's rectangle corners are convex.
"""

from __future__ import annotations

import math
from typing import Any

_EPS = 1e-6


def _traversal(item: dict[str, Any], flipped: bool) -> tuple[list[float], list[float], float]:
    """(start point, end point, turning sign) of an item traversed in the loop's direction."""
    if item["type"] == "line":
        a, b = (item["end"], item["start"]) if flipped else (item["start"], item["end"])
        return list(a), list(b), 0.0
    a, b = (item["end"], item["start"]) if flipped else (item["start"], item["end"])
    return list(a), list(b), -1.0 if flipped else 1.0


def _signed_area(items: list[dict[str, Any]], orient: list[bool]) -> float:
    total = 0.0
    for item, flipped in zip(items, orient):
        if item["type"] == "circle":
            return math.pi * item["radius"] ** 2
        if item["type"] == "line":
            a, b, _t = _traversal(item, flipped)
            total += 0.5 * (a[0] * b[1] - b[0] * a[1])
        else:
            cx, cy = item["center"]
            r = item["radius"]
            t0 = math.radians(item["start_angle"])
            t1 = t0 + arc_sweep_rad(item)
            if flipped:
                t0, t1 = t1, t0
            total += 0.5 * (r * r * (t1 - t0) + cx * r * (math.sin(t1) - math.sin(t0)) - cy * r * (math.cos(t1) - math.cos(t0)))
    return total


def arc_sweep_rad(item: dict[str, Any]) -> float:
    sweep = math.radians(item["end_angle"] - item["start_angle"]) % (2 * math.pi)
    return sweep if sweep > 1e-12 else 2 * math.pi


def _unit(a: list[float], b: list[float]) -> tuple[float, float, float]:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    return (dx / length, dy / length, length) if length > _EPS else (0.0, 0.0, 0.0)


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return min(max(a0, a1), max(b0, b1)) - max(min(a0, a1), min(b0, b1))


def loop_metrics(loop: dict[str, Any]) -> dict[str, Any]:
    """min_width, corners [{at, concave, radius}], is_slot, slot_width, slot_length of one closed loop."""
    items: list[dict[str, Any]] = list(loop["geometry"])
    orient: list[bool] = list(loop["orient"])
    empty = {"min_width": None, "corners": [], "is_slot": False, "slot_width": None, "slot_length": None}
    if len(items) == 1 and items[0]["type"] == "circle":
        return {**empty, "min_width": 2 * items[0]["radius"]}
    if any(item["type"] == "circle" for item in items):
        return empty  # a circle never shares a loop with other curves
    s = 1.0 if _signed_area(items, orient) > 0 else -1.0
    segs = [_traversal(item, flipped) for item, flipped in zip(items, orient)]
    n = len(items)
    kinds = [item["type"] for item in items]

    # corners: sharp vertices between two lines, and arcs that join two lines (rounded corners)
    corners: list[dict[str, Any]] = []
    for i in range(n):
        prev_i, next_i = (i - 1) % n, (i + 1) % n
        if kinds[i] == "arc" and kinds[prev_i] == "line" and kinds[next_i] == "line" and arc_sweep_rad(items[i]) < math.pi - 1e-4:
            # a fillet corner; a half-turn arc between two parallel lines is a slot end, not a corner
            t = segs[i][2]
            corners.append({"at": [round(v, 6) for v in segs[i][0]], "concave": t != s, "radius": round(items[i]["radius"], 6)})
        elif kinds[i] == "line" and kinds[prev_i] == "line":
            ux, uy, _ = _unit(segs[prev_i][0], segs[prev_i][1])
            vx, vy, _ = _unit(segs[i][0], segs[i][1])
            cross = ux * vy - uy * vx
            if abs(cross) > 1e-6:
                corners.append({"at": [round(v, 6) for v in segs[i][0]], "concave": cross * s < 0, "radius": 0.0})

    # minimum width: parallel facing lines, arcs of at least a half turn (slot ends), else line-to-vertex heights
    lines = [(k, segs[k]) for k in range(n) if kinds[k] == "line"]
    normals: dict[int, tuple[float, float]] = {}
    for k, (a, b, _t) in lines:
        ux, uy, _ = _unit(a, b)
        normals[k] = (-uy * s, ux * s)  # interior side of the loop
    candidates: list[float] = []
    for index, (i, (a, b, _)) in enumerate(lines):
        ux, uy, li = _unit(a, b)
        for j, (c, d, _) in lines[index + 1:]:
            vx, vy, lj = _unit(c, d)
            if abs(ux * vy - uy * vx) > 1e-6:
                continue
            ni = normals[i]
            if ni[0] * normals[j][0] + ni[1] * normals[j][1] > -0.999:
                continue  # both loop sides face the same way: a step, not a width
            distance = ni[0] * (c[0] - a[0]) + ni[1] * (c[1] - a[1])
            if distance <= _EPS:
                continue
            along = lambda p: p[0] * ux + p[1] * uy  # noqa: E731
            if _overlap(along(a), along(b), along(c), along(d)) > _EPS:
                candidates.append(distance)
    for k in range(n):
        if kinds[k] == "arc" and arc_sweep_rad(items[k]) >= math.pi - 1e-6:
            candidates.append(2 * items[k]["radius"])
    if not candidates and lines and len(lines) == n:
        points = [seg[0] for seg in segs]
        heights = []
        for k, (a, _b, _t) in lines:
            ni = normals[k]
            heights.append(max(ni[0] * (p[0] - a[0]) + ni[1] * (p[1] - a[1]) for p in points))
        candidates.append(min(heights))
    min_width = round(min(candidates), 6) if candidates else None

    slot = _slot(items, kinds, segs)
    return {"min_width": min_width, "corners": corners, **slot}


def _slot(items: list[dict[str, Any]], kinds: list[str], segs: list[tuple[list[float], list[float], float]]) -> dict[str, Any]:
    none = {"is_slot": False, "slot_width": None, "slot_length": None}
    if len(items) != 4 or kinds.count("line") != 2 or kinds.count("arc") != 2:
        return none
    arcs = [items[k] for k in range(4) if kinds[k] == "arc"]
    if any(abs(arc_sweep_rad(arc) - math.pi) > 1e-4 for arc in arcs):
        return none
    if abs(arcs[0]["radius"] - arcs[1]["radius"]) > 1e-6:
        return none
    lines = [k for k in range(4) if kinds[k] == "line"]
    a, b = segs[lines[0]][0], segs[lines[0]][1]
    c, d = segs[lines[1]][0], segs[lines[1]][1]
    ux, uy, l1 = _unit(a, b)
    vx, vy, l2 = _unit(c, d)
    if abs(ux * vy - uy * vx) > 1e-6 or abs(l1 - l2) > 1e-6:
        return none
    width = 2 * arcs[0]["radius"]
    centre_gap = math.hypot(arcs[0]["center"][0] - arcs[1]["center"][0], arcs[0]["center"][1] - arcs[1]["center"][1])
    return {"is_slot": True, "slot_width": round(width, 6), "slot_length": round(centre_gap + width, 6)}
