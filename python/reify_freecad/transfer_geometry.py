"""Pure geometry helpers for the feature canonicalizer (no FreeCAD import).

Geometry items are plain dicts in sketch coordinates (mm, degrees):

    {"id": 0, "type": "line",   "start": [u, v], "end": [u, v]}
    {"id": 1, "type": "arc",    "center": [u, v], "radius": r, "start_angle": a0, "end_angle": a1,
                                "start": [u, v], "end": [u, v]}          # counter-clockwise from a0 to a1
    {"id": 2, "type": "circle", "center": [u, v], "radius": r}

Everything here is exact (no polygon sampling): loop areas use Green's theorem and the
containment test counts ray crossings against lines and circular arcs analytically.
"""

from __future__ import annotations

import math
import re
from typing import Any

TOL = 1e-6
TAU = 2.0 * math.pi


class LoopError(Exception):
    """An open, branching, intersecting or touching profile. ``reason`` is a stable token."""

    def __init__(self, reason: str, message: str, geometry: list[int]) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.geometry = geometry


# ------------------------------------------------------------------ primitives
def _dist(a: tuple[float, float] | list[float], b: tuple[float, float] | list[float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _ends(g: dict[str, Any]) -> tuple[list[float], list[float]] | None:
    return None if g["type"] == "circle" else (g["start"], g["end"])


def arc_sweep(g: dict[str, Any]) -> float:
    """Counter-clockwise sweep of an arc in radians, in (0, 2 pi]."""
    sweep = math.radians(g["end_angle"] - g["start_angle"]) % TAU
    return sweep if sweep > 1e-12 else TAU


def _angle_on_arc(g: dict[str, Any], point: tuple[float, float], tol: float) -> bool:
    cx, cy = g["center"]
    rel = (math.atan2(point[1] - cy, point[0] - cx) - math.radians(g["start_angle"])) % TAU
    sweep = arc_sweep(g)
    slack = tol / max(g["radius"], tol)
    return rel <= sweep + slack or rel >= TAU - slack


def _on_segment(g: dict[str, Any], t: float, length: float, tol: float) -> bool:
    return -tol <= t <= length + tol


def point_on(g: dict[str, Any], tol: float = TOL) -> list[float]:
    """A representative point on the geometry (start point; circles at angle 0)."""
    if g["type"] == "circle":
        return [g["center"][0] + g["radius"], g["center"][1]]
    return list(g["start"])


# ------------------------------------------------------------------ loops
def build_loops(geometry: list[dict[str, Any]], tol: float = TOL, strict: bool = True) -> list[dict[str, Any]]:
    """Join endpoints into closed loops.

    Returns ``[{"id", "geometry": [ids in drawing order], "closed": True, "orient": [bool,...]}]``
    sorted by the smallest geometry id. ``orient[i]`` is True when geometry i is traversed
    from its end to its start. Circles are single-id loops. With ``strict`` an open chain or
    a vertex shared by more than two curves raises ``LoopError``; otherwise those chains are
    dropped.
    """
    loops: list[dict[str, Any]] = []
    chain_items = []
    for g in geometry:
        if g["type"] == "circle":
            loops.append({"geometry": [g["id"]], "closed": True, "orient": [False]})
        elif g["type"] in ("line", "arc"):
            chain_items.append(g)
    # Cluster endpoints within tol.
    nodes: list[list[float]] = []

    def node_of(p: list[float]) -> int:
        for i, q in enumerate(nodes):
            if _dist(p, q) <= tol:
                return i
        nodes.append(list(p))
        return len(nodes) - 1

    edges: dict[int, tuple[int, int]] = {}
    incident: dict[int, list[int]] = {}
    for g in chain_items:
        a, b = node_of(g["start"]), node_of(g["end"])
        edges[g["id"]] = (a, b)
        incident.setdefault(a, []).append(g["id"])
        incident.setdefault(b, []).append(g["id"])
        if a == b:
            if strict:
                raise LoopError("degenerate_geometry", f"geometry {g['id']} starts and ends at the same point", [g["id"]])
    # a self-closed arc (a == b) lists its id twice at its node: a valid single-edge loop
    for n in [n for n, ids in incident.items() if len(ids) != 2]:
        ids = incident[n]
        if len(ids) == 1:
            if strict:
                raise LoopError("open_loop", f"geometry {ids[0]} has a free end at {_fmt(nodes[n])}", ids)
        elif strict:
            raise LoopError("touching_loops", f"{len(ids)} curves meet at {_fmt(nodes[n])}", sorted(set(ids)))
    used: set[int] = set()
    for g in chain_items:
        gid = g["id"]
        if gid in used:
            continue
        chain = [gid]
        orient = [False]
        used.add(gid)
        start_node, node = edges[gid]
        ok = True
        while node != start_node:
            options = [e for e in incident[node] if e not in used]
            if len(incident[node]) != 2 or not options:
                ok = False
                break
            nxt = options[0]
            used.add(nxt)
            a, b = edges[nxt]
            chain.append(nxt)
            if a == node:
                orient.append(False)
                node = b
            else:
                orient.append(True)
                node = a
        if ok and (len(chain) > 1 or edges[gid][0] == edges[gid][1]):
            loops.append({"geometry": chain, "closed": True, "orient": orient})
        elif strict:
            raise LoopError("open_loop", f"geometry {chain} does not close", chain)
    loops.sort(key=lambda l: min(l["geometry"]))
    for index, loop in enumerate(loops):
        loop["id"] = index
    return loops


def _fmt(p: list[float]) -> str:
    return f"({p[0]:.6g}, {p[1]:.6g})"


# ------------------------------------------------------------------ area
def loop_area(loop: dict[str, Any], by_id: dict[int, dict[str, Any]]) -> float:
    """Absolute enclosed area by Green's theorem (exact for lines and arcs)."""
    total = 0.0
    for gid, flipped in zip(loop["geometry"], loop["orient"]):
        g = by_id[gid]
        if g["type"] == "circle":
            return math.pi * g["radius"] ** 2
        if g["type"] == "line":
            a, b = (g["end"], g["start"]) if flipped else (g["start"], g["end"])
            total += 0.5 * (a[0] * b[1] - b[0] * a[1])
        else:
            cx, cy = g["center"]
            r = g["radius"]
            t0 = math.radians(g["start_angle"])
            sweep = arc_sweep(g)
            t1 = t0 + sweep
            if flipped:
                t0, t1 = t1, t0
            total += 0.5 * (r * r * (t1 - t0) + cx * r * (math.sin(t1) - math.sin(t0)) - cy * r * (math.cos(t1) - math.cos(t0)))
    return abs(total)


# ------------------------------------------------------------------ intersections
OVERLAP = "overlap"


def curve_intersections(a: dict[str, Any], b: dict[str, Any], tol: float = TOL) -> list[tuple[float, float]] | str:
    """Common points of two curves (touching counts); ``OVERLAP`` when they share a stretch."""
    ta, tb = a["type"], b["type"]
    if ta == "line" and tb == "line":
        return _line_line(a, b, tol)
    if ta == "line":
        return _line_circle(a, b, tol)
    if tb == "line":
        return _line_circle(b, a, tol)
    return _circle_circle(a, b, tol)


def _line_line(a: dict[str, Any], b: dict[str, Any], tol: float) -> list[tuple[float, float]] | str:
    p, r = a["start"], (a["end"][0] - a["start"][0], a["end"][1] - a["start"][1])
    q, s = b["start"], (b["end"][0] - b["start"][0], b["end"][1] - b["start"][1])
    la, lb = math.hypot(*r), math.hypot(*s)
    if la <= tol or lb <= tol:
        return []
    cross = r[0] * s[1] - r[1] * s[0]
    qp = (q[0] - p[0], q[1] - p[1])
    if abs(cross) <= 1e-12 * la * lb:  # parallel
        if abs(qp[0] * r[1] - qp[1] * r[0]) / la > tol:
            return []
        ts = sorted([((q[0] - p[0]) * r[0] + (q[1] - p[1]) * r[1]) / la, ((b["end"][0] - p[0]) * r[0] + (b["end"][1] - p[1]) * r[1]) / la])
        lo, hi = max(ts[0], 0.0), min(ts[1], la)
        if hi - lo > tol:
            return OVERLAP
        if hi - lo >= -tol:
            t = (lo + hi) / 2
            return [(p[0] + r[0] / la * t, p[1] + r[1] / la * t)]
        return []
    t = (qp[0] * s[1] - qp[1] * s[0]) / cross
    u = (qp[0] * r[1] - qp[1] * r[0]) / cross
    if -tol / la <= t <= 1 + tol / la and -tol / lb <= u <= 1 + tol / lb:
        return [(p[0] + t * r[0], p[1] + t * r[1])]
    return []


def _line_circle(line: dict[str, Any], c: dict[str, Any], tol: float) -> list[tuple[float, float]]:
    p = line["start"]
    d = (line["end"][0] - p[0], line["end"][1] - p[1])
    length = math.hypot(*d)
    if length <= tol:
        return []
    ux, uy = d[0] / length, d[1] / length
    cx, cy = c["center"]
    r = c["radius"]
    # foot of the perpendicular from the centre
    t0 = (cx - p[0]) * ux + (cy - p[1]) * uy
    dist = abs((cx - p[0]) * uy - (cy - p[1]) * ux)
    if dist > r + tol:
        return []
    found: list[tuple[float, float]] = []
    if abs(dist - r) <= tol:
        ts = [t0]
    else:
        h = math.sqrt(max(r * r - dist * dist, 0.0))
        ts = [t0 - h, t0 + h]
    for t in ts:
        if not _on_segment(line, t, length, tol):
            continue
        pt = (p[0] + ux * t, p[1] + uy * t)
        if c["type"] == "arc" and not _angle_on_arc(c, pt, tol):
            continue
        found.append(pt)
    return found


def _circle_circle(a: dict[str, Any], b: dict[str, Any], tol: float) -> list[tuple[float, float]] | str:
    (x1, y1), (x2, y2) = a["center"], b["center"]
    r1, r2 = a["radius"], b["radius"]
    d = math.hypot(x2 - x1, y2 - y1)
    if d <= tol and abs(r1 - r2) <= tol:
        # concentric and equal: shared stretch unless the arcs only meet end to end
        if a["type"] == "circle" or b["type"] == "circle":
            return OVERLAP
        return _arc_arc_same_circle(a, b, tol)
    if d > r1 + r2 + tol or d < abs(r1 - r2) - tol or d <= 1e-12:
        return []
    x = (d * d + r1 * r1 - r2 * r2) / (2 * d)
    h = math.sqrt(max(r1 * r1 - x * x, 0.0))
    ex, ey = (x2 - x1) / d, (y2 - y1) / d
    mx, my = x1 + ex * x, y1 + ey * x
    pts = [(mx, my)] if h <= tol / 2 else [(mx - ey * h, my + ex * h), (mx + ey * h, my - ex * h)]
    out = []
    for pt in pts:
        if a["type"] == "arc" and not _angle_on_arc(a, pt, tol):
            continue
        if b["type"] == "arc" and not _angle_on_arc(b, pt, tol):
            continue
        out.append(pt)
    return out


def _arc_arc_same_circle(a: dict[str, Any], b: dict[str, Any], tol: float) -> list[tuple[float, float]] | str:
    r = a["radius"]
    sa, sb = math.radians(a["start_angle"]), math.radians(b["start_angle"])
    la, lb = arc_sweep(a), arc_sweep(b)
    rel = (sb - sa) % TAU
    # overlap length of [0, la] and [rel, rel+lb] on the circle
    overlap = 0.0
    for shift in (-TAU, 0.0, TAU):
        lo, hi = max(0.0, rel + shift), min(la, rel + shift + lb)
        overlap = max(overlap, hi - lo)
    if overlap * r > tol:
        return OVERLAP
    pts = []
    for g in (a, b):
        for key in ("start", "end"):
            pt = tuple(g[key])
            other = b if g is a else a
            if _angle_on_arc(other, pt, tol) and pt not in pts:
                pts.append(pt)
    return pts


def check_intersections(geometry: list[dict[str, Any]], loops: list[dict[str, Any]], tol: float = TOL) -> None:
    """Raise ``LoopError`` when curves of different loops meet, or a loop crosses itself."""
    by_id = {g["id"]: g for g in geometry}
    owner = {gid: loop["id"] for loop in loops for gid in loop["geometry"]}
    ids = sorted(owner)
    for i, ia in enumerate(ids):
        for ib in ids[i + 1:]:
            a, b = by_id[ia], by_id[ib]
            hit = curve_intersections(a, b, tol)
            if hit == OVERLAP:
                raise LoopError("touching_loops" if owner[ia] != owner[ib] else "self_intersecting_loop",
                                f"geometry {ia} and {ib} overlap", [ia, ib])
            if not hit:
                continue
            if owner[ia] != owner[ib]:
                reason = "intersecting_loops" if len(hit) > 1 else "touching_loops"
                raise LoopError(reason, f"loops {owner[ia]} and {owner[ib]} meet at {_fmt(list(hit[0]))} (geometry {ia}, {ib})", [ia, ib])
            shared = [p for p in _vertices(a) if any(_dist(p, q) <= tol for q in _vertices(b))]
            for pt in hit:
                if not any(_dist(pt, s) <= tol for s in shared):
                    raise LoopError("self_intersecting_loop", f"geometry {ia} crosses {ib} at {_fmt(list(pt))}", [ia, ib])


def _vertices(g: dict[str, Any]) -> list[list[float]]:
    return [] if g["type"] == "circle" else [g["start"], g["end"]]


# ------------------------------------------------------------------ containment and depth
def contains_point(loop: dict[str, Any], by_id: dict[int, dict[str, Any]], point: tuple[float, float] | list[float]) -> bool:
    """Even-odd test of ``point`` against the loop using an exact ray cast.

    The ray leaves in an irrational direction so it does not run through vertices.
    """
    angle = 0.7345912
    ca, sa = math.cos(angle), math.sin(angle)
    px, py = point

    def rot(x: float, y: float) -> tuple[float, float]:
        dx, dy = x - px, y - py
        return dx * ca + dy * sa, -dx * sa + dy * ca

    crossings = 0
    for gid in loop["geometry"]:
        g = by_id[gid]
        if g["type"] == "line":
            (x1, y1), (x2, y2) = rot(*g["start"]), rot(*g["end"])
            if (y1 > 0) != (y2 > 0):
                x = x1 + (0 - y1) * (x2 - x1) / (y2 - y1)
                if x > 0:
                    crossings += 1
        else:
            cx, cy = rot(*g["center"])
            r = g["radius"]
            if abs(cy) >= r:
                continue
            h = math.sqrt(r * r - cy * cy)
            for x in (cx - h, cx + h):
                if x <= 0:
                    continue
                if g["type"] == "arc":
                    # angle of the hit point in the sketch frame
                    hx, hy = x, 0.0
                    wx, wy = px + hx * ca - hy * sa, py + hx * sa + hy * ca
                    if not _angle_on_arc(g, (wx, wy), 1e-9):
                        continue
                crossings += 1
    return crossings % 2 == 1


def nesting_depths(geometry: list[dict[str, Any]], loops: list[dict[str, Any]]) -> dict[int, int]:
    """loop id -> number of other loops that contain it (loops must not meet)."""
    by_id = {g["id"]: g for g in geometry}
    depths = {}
    for loop in loops:
        probe = point_on(by_id[loop["geometry"][0]])
        depths[loop["id"]] = sum(1 for other in loops if other["id"] != loop["id"] and contains_point(other, by_id, probe))
    return depths


def analyse_sketch(geometry: list[dict[str, Any]], tol: float = TOL, strict: bool = True) -> list[dict[str, Any]]:
    """Loops with ``id``, ``geometry``, ``closed``, ``depth`` and ``area`` (no private keys)."""
    loops = build_loops(geometry, tol, strict)
    if strict:
        check_intersections(geometry, loops, tol)
    by_id = {g["id"]: g for g in geometry}
    depths = nesting_depths(geometry, loops)
    return [
        {"id": l["id"], "geometry": l["geometry"], "closed": True, "depth": depths[l["id"]], "area": loop_area(l, by_id)}
        for l in loops
    ]


# ------------------------------------------------------------------ plane detection
_BASES = (("XY", 2, "Z"), ("XZ", 1, "Y"), ("YZ", 0, "X"))


def detect_plane(frame: dict[str, list[float]], tol: float = 1e-6) -> dict[str, Any] | None:
    """``{"base": "XY"|"XZ"|"YZ", "offset": signed distance along the +world axis}`` or None.

    The normal must be parallel to a world axis. ``offset`` is the coordinate of the frame
    origin along that axis (XY -> z, XZ -> y, YZ -> x), i.e. along the positive world axis,
    even when the sketch normal points the other way (the XZ plane's normal is -Y).
    """
    n = frame["n"]
    for base, axis, _name in _BASES:
        others = [abs(n[i]) for i in range(3) if i != axis]
        if abs(abs(n[axis]) - 1.0) <= tol and max(others) <= tol:
            return {"base": base, "offset": frame["origin"][axis]}
    return None


# ------------------------------------------------------------------ expression text
_PARAMS = re.compile(r"\bParams\.")
_OTHER_UNITS = re.compile(r"(?<=[\d.)])\s*\b(cm|m|km|um|in|ft|rad|inch|mil|yd|mi)\b(?!\w)")


def clean_expression(text: str, unit: str | None = None) -> str:
    """FreeCAD expression text -> Reify style ``=...``.

    Rules:
    * every ``Params.`` prefix is removed (``Params.width / 2`` -> ``width/2``);
    * the unit of the property (``mm`` for lengths, ``deg`` for angles; pass it as ``unit``)
      is dropped when it directly follows a number or a closing bracket, because Reify
      numbers are already in that unit (``Params.width - 3 mm`` -> ``=width - 3``). Units of
      any other kind (``cm``, ``in``, ...) make the whole expression keep its unit tokens
      untouched, since dropping only some of them would change the value;
    * spaces around ``*`` and ``/`` are removed and runs of spaces collapse; spaces around
      ``+`` and ``-`` are kept for readability.
    """
    body = _PARAMS.sub("", text.strip())
    if unit and not _OTHER_UNITS.search(body):
        body = re.sub(rf"(?<=[\d.)])\s*\b{re.escape(unit)}\b(?!\s*[\w(^])", "", body)
    body = re.sub(r"\s*([*/])\s*", r"\1", body)
    body = re.sub(r"\s+", " ", body).strip()
    return "=" + body
