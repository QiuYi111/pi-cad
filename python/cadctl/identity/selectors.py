"""Deterministic geometric selection rules.

A selector binds an author-declared engineering name to final geometry.  It is
evaluated against the *exported and re-imported* artifact, never against the
in-memory build graph, so a boolean that deletes or splits a face is caught
instead of silently keeping a stale object reference.

Selection is always bounded: every numeric predicate carries a tolerance, so a
shape that moved or disappeared produces "no candidate", not a nearest guess.
"""

from __future__ import annotations

from typing import Any, Iterable

from .protocol import IdentityError

DEFAULT_TOLERANCE = 1e-6

_SOLID_KEYS = {"entity", "near", "volume", "bounds", "withinBounds", "extreme", "members", "tolerance"}
_FACE_KEYS = {
    "entity",
    "type",
    "normal",
    "axisDirection",
    "radius",
    "area",
    "centroid",
    "tolerance",
}
_EDGE_KEYS = {"entity", "type", "length", "radius", "centroid", "tolerance"}

_KEYS = {"solid": _SOLID_KEYS, "face": _FACE_KEYS, "edge": _EDGE_KEYS}


def _as_point(value: Any, key: str) -> tuple[float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise IdentityError("bad-selector", f"selector '{key}' needs three coordinates", key=key)
    try:
        return (float(value[0]), float(value[1]), float(value[2]))
    except (TypeError, ValueError) as error:
        raise IdentityError("bad-selector", f"selector '{key}' is not numeric: {value}", key=key) from error


def _tolerance(selector: dict[str, Any]) -> float:
    value = selector.get("tolerance", DEFAULT_TOLERANCE)
    try:
        tolerance = float(value)
    except (TypeError, ValueError) as error:
        raise IdentityError("bad-selector", f"selector tolerance is not numeric: {value}") from error
    if tolerance <= 0:
        raise IdentityError("bad-selector", "selector tolerance must be positive", tolerance=tolerance)
    return tolerance


def normalize(selector: dict[str, Any]) -> dict[str, Any]:
    """Validate one selector and return it unchanged apart from defaults."""
    if not isinstance(selector, dict):
        raise IdentityError("bad-selector", "selector must be a mapping")
    entity = selector.get("entity")
    if entity not in _KEYS:
        raise IdentityError(
            "bad-selector",
            f"selector entity must be one of {sorted(_KEYS)}; got {entity!r}",
            entity=entity,
        )
    unknown = set(selector) - _KEYS[entity]
    if unknown:
        raise IdentityError(
            "bad-selector",
            f"{entity} selector has unsupported keys {sorted(unknown)}; "
            f"allowed: {sorted(_KEYS[entity])}",
            entity=entity,
            unsupported=sorted(unknown),
        )
    normalized = dict(selector)
    normalized["tolerance"] = _tolerance(selector)
    if entity == "solid" and "members" in normalized:
        members = normalized["members"]
        if not isinstance(members, list) or not members:
            raise IdentityError("bad-selector", "solid selector members must be a non-empty list")
        for member in members:
            if not isinstance(member, dict) or set(member) != {"bounds", "volume"}:
                raise IdentityError(
                    "bad-selector",
                    "each solid selector member needs exact bounds and volume",
                )
    return normalized


def _close(left: float, right: float, tolerance: float) -> bool:
    return abs(left - right) <= tolerance


def _point_close(left: Iterable[float], right: Iterable[float], tolerance: float) -> bool:
    return all(_close(float(a), float(b), tolerance) for a, b in zip(left, right))


def _direction_close(left: tuple[float, float, float], right: tuple[float, float, float], tolerance: float, *, sign_free: bool) -> bool:
    direct = _point_close(left, right, tolerance)
    if direct or not sign_free:
        return direct
    return _point_close(left, (-right[0], -right[1], -right[2]), tolerance)


def _match_solid(record: dict[str, Any], selector: dict[str, Any], tolerance: float) -> bool:
    if "near" in selector and not _point_close(record["center"], _as_point(selector["near"], "near"), tolerance):
        return False
    if "withinBounds" in selector:
        low, high = selector["withinBounds"]
        if not all(
            float(low[axis]) - tolerance <= record["center"][axis] <= float(high[axis]) + tolerance
            for axis in range(3)
        ):
            return False
    if "volume" in selector and not _close(record["volume"], float(selector["volume"]), tolerance):
        return False
    if "bounds" in selector:
        low, high = selector["bounds"]
        if not _point_close(record["bounds"][0], low, tolerance):
            return False
        if not _point_close(record["bounds"][1], high, tolerance):
            return False
    return True


def _extreme_solids(records: list[dict[str, Any]], selector: dict[str, Any]) -> list[dict[str, Any]]:
    extreme = selector["extreme"]
    axis = extreme.get("axis")
    side = extreme.get("side")
    if axis not in ("x", "y", "z"):
        raise IdentityError("bad-selector", f"extreme axis must be x, y, or z; got {axis!r}")
    if side not in ("min", "max"):
        raise IdentityError("bad-selector", f"extreme side must be min or max; got {side!r}")
    index = "xyz".index(axis)
    key = (lambda record: record["center"][index]) if side == "max" else (lambda record: -record["center"][index])
    best = max(key(record) for record in records)
    return [record for record in records if key(record) == best]


def _match_face(record: dict[str, Any], selector: dict[str, Any], tolerance: float) -> bool:
    if "type" in selector and str(record["type"]).lower() != str(selector["type"]).lower():
        return False
    if "normal" in selector:
        if "normal" not in record:
            return False
        if not _direction_close(tuple(record["normal"]), _as_point(selector["normal"], "normal"), tolerance, sign_free=False):
            return False
    if "axisDirection" in selector:
        if "axis" not in record:
            return False
        if not _direction_close(
            tuple(record["axis"]["direction"]),
            _as_point(selector["axisDirection"], "axisDirection"),
            tolerance,
            sign_free=True,
        ):
            return False
    if "radius" in selector:
        if "radius" not in record or not _close(float(record["radius"]), float(selector["radius"]), tolerance):
            return False
    if "area" in selector and not _close(float(record["area"]), float(selector["area"]), tolerance):
        return False
    if "centroid" in selector and not _point_close(record["centroid"], _as_point(selector["centroid"], "centroid"), tolerance):
        return False
    return True


def _match_edge(record: dict[str, Any], selector: dict[str, Any], tolerance: float) -> bool:
    if "type" in selector and str(record["type"]).lower() != str(selector["type"]).lower():
        return False
    if "length" in selector and not _close(float(record["length"]), float(selector["length"]), tolerance):
        return False
    if "radius" in selector:
        if record["radius"] is None or not _close(float(record["radius"]), float(selector["radius"]), tolerance):
            return False
    if "centroid" in selector and not _point_close(record["centroid"], _as_point(selector["centroid"], "centroid"), tolerance):
        return False
    return True


def evaluate(
    model: Any,
    selector: dict[str, Any],
    solid_indices: list[int] | None,
) -> list[dict[str, Any]]:
    """Return every artifact object the selector matches, in artifact order.

    ``solid_indices`` narrows the search to the owner occurrence.  ``None``
    searches the whole artifact.  Matches are never truncated: the caller
    compares the full list against the declared cardinality.
    """
    normalized = normalize(selector)
    entity = normalized["entity"]
    tolerance = normalized["tolerance"]
    solids = model.solids
    if solid_indices is not None:
        wanted = set(solid_indices)
        solids = [record for record in solids if record["index"] in wanted]

    if entity == "solid":
        if "members" in normalized:
            result: list[dict[str, Any]] = []
            for member in normalized["members"]:
                matches = evaluate(
                    model,
                    {
                        "entity": "solid",
                        **member,
                        "tolerance": tolerance,
                    },
                    solid_indices,
                )
                if len(matches) != 1:
                    raise IdentityError(
                        "ambiguous-shape-member",
                        "shape= member matched "
                        f"{len(matches)} exported solids; refine the declaration or fail the build",
                        member=member,
                        matches=[match["ref"] for match in matches],
                    )
                if any(existing["ref"] == matches[0]["ref"] for existing in result):
                    raise IdentityError(
                        "ambiguous-shape-member",
                        "two source shape members match the same exported solid",
                        ref=matches[0]["ref"],
                    )
                result.append(matches[0])
            return result
        if "extreme" in normalized:
            matched = _extreme_solids(solids, normalized) if solids else []
            remaining = {key: value for key, value in normalized.items() if key not in ("extreme", "tolerance", "entity")}
        else:
            matched, remaining = solids, normalized
        return [
            {"kind": "solid", "ref": record["ref"], "solidIndex": record["index"], "facts": record}
            for record in matched
            if _match_solid(record, {**remaining, "entity": "solid"}, tolerance)
        ]

    if entity == "face":
        candidates = model.faces_of([record["index"] for record in solids])
        return [
            {"kind": "face", "ref": record["id"], "solidIndex": record["solidIndex"], "facts": record}
            for record in candidates
            if _match_face(record, normalized, tolerance)
        ]

    edges = model.edges_of([record["index"] for record in solids])
    return [
        {"kind": "edge", "ref": record["id"], "solidIndex": record["solidIndex"], "facts": record}
        for record in edges
        if _match_edge(record, normalized, tolerance)
    ]
