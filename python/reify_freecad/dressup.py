"""Diagnosis of a failed fillet or chamfer (imports FreeCAD).

OCC reports ``BRep_API: command not done`` for every dress-up failure. The usual
cause is a radius or size that does not fit the faces next to the edge, so the
failure is explained with the room those faces actually leave.
"""

from __future__ import annotations

from typing import Any

import Part

_VALUE_PROPERTY = {"PartDesign::Fillet": ("Radius", "radius", "fillet"), "PartDesign::Chamfer": ("Size", "size", "chamfer")}


def _width_from_edge(face: Any, edge: Any) -> float | None:
    """How far ``face`` reaches away from ``edge`` (the most a dress-up of that edge can take from it)."""
    try:
        start = edge.valueAt(edge.FirstParameter)
        stop = edge.valueAt(edge.LastParameter)
    except Exception:
        return None
    direction = stop - start
    if direction.Length < 1e-9:  # a closed edge (circle): measure from the circle itself
        reach = max((vertex.Point - edge.CenterOfMass).Length for vertex in face.Vertexes) if face.Vertexes else None
        return None if reach is None else round(reach, 4)
    direction.normalize()
    best = 0.0
    for vertex in face.Vertexes:
        offset = vertex.Point - start
        best = max(best, (offset - direction * offset.dot(direction)).Length)
    return round(best, 4) if best > 1e-9 else None


def diagnose(feature: Any) -> tuple[dict[str, Any], list[str]]:
    """(detail, hints) for a failed PartDesign fillet or chamfer; both empty when nothing can be computed."""
    spec = _VALUE_PROPERTY.get(feature.TypeId)
    if spec is None:
        return {}, []
    prop, word, other = spec
    hints: list[str] = []
    detail: dict[str, Any] = {}
    try:
        value = float(getattr(feature, prop).Value)
        base, names = feature.Base
        shape = base.Shape
        detail["value"] = value
        widths: list[tuple[float, str]] = []
        lengths: list[tuple[float, str]] = []
        for name in names:
            edge = shape.getElement(name)
            for face in shape.ancestorsOfType(edge, Part.Face):
                width = _width_from_edge(face, edge)
                if width is not None:
                    widths.append((width, name))
                lengths.extend((round(other_edge.Length, 4), name) for other_edge in face.Edges if not other_edge.isSame(edge))
        if widths:
            narrow, at = min(widths)
            detail["narrowestAdjacentFaceMm"] = narrow
            detail["narrowestAdjacentFaceAt"] = at
        if lengths:
            short, at = min(lengths)
            detail["shortestAdjacentEdgeMm"] = short
        limit = min([w for w, _n in widths] + [l for l, _n in lengths], default=None)
        if limit is not None and value >= limit * 0.5:
            hints.append(
                f"{word} {value:g} mm does not fit: the narrowest face next to the edge is {detail.get('narrowestAdjacentFaceMm', limit):g} mm wide"
                f"{'' if 'shortestAdjacentEdgeMm' not in detail else ' and the shortest neighbouring edge is ' + format(detail['shortestAdjacentEdgeMm'], 'g') + ' mm'}; "
                f"use a {word} below {limit * 0.5:g} mm"
            )
    except Exception:
        pass
    hints.append(f"try a {other} of the other kind (a {'chamfer' if other == 'fillet' else 'fillet'} needs different room), or split the edge set into several ops")
    if other == "fillet":
        hints.append("fillet before the pockets and holes that cut near the edge: put the fillet op earlier in the batch")
    else:
        hints.append("chamfer before the pockets and holes that cut near the edge: put the chamfer op earlier in the batch")
    hints.append("check that every selected edge still exists after the later features; select it by a role of the feature that is current at this point")
    return detail, hints
