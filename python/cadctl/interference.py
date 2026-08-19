"""Pairwise solid interference facts (0.8 M3).

Deterministic interpreter: for every part pair in a STEP artifact, report
the intersection volume (exact boolean common), the minimum distance when
disjoint, and a three-state classification:

    penetration | contact | clearance

The interpreter never says "fail" or "bad": a press fit is penetration, a
deliberate stop is contact. Engineering meaning is the Agent's call.

Computation failures raise InterferenceUnresolvedError instead of
degrading to a distance-based guess: a failed boolean must never be
reported as "contact".
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import build123d as bd
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopTools import TopTools_ListOfShape


class InterferenceUnresolvedError(RuntimeError):
    """A geometric computation failed; the observation is unresolved.

    Raising (rather than degrading to a distance-based classification)
    keeps the interpreter fail-closed: the harness records no interference
    evidence, and integration review stays blocked until the facts can
    actually be computed.
    """


def _volume_of(shape: Any) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return float(props.Mass())


def _distance(a: Any, b: Any) -> float:
    computer = BRepExtrema_DistShapeShape(a, b)
    if not computer.IsDone():
        raise InterferenceUnresolvedError("distance computation failed: interference facts are unresolved")
    return float(computer.Value())


def _solid_parts(shape: bd.Shape) -> list[dict[str, Any]]:
    """World-positioned solids with deterministic index labels.

    Occurrence labels (when the STEP carries an assembly structure) are
    matched by exploring each child; otherwise parts are labeled by solid
    index, matching the #s<i> selector convention of cad_measure.
    """
    solids = list(shape.solids())
    parts: list[dict[str, Any]] = []
    children = list(shape.children)
    child_labels: list[str | None] = []
    if children and len(children) == len(solids):
        # Flat compound: children ARE the occurrences, in explorer order.
        for index, child in enumerate(children):
            label = getattr(child, "label", "") or ""
            child_labels.append(f"{index}:{label}" if label else str(index))
    else:
        child_labels = [None] * len(solids)
    for index, solid in enumerate(solids):
        bb = solid.bounding_box()
        parts.append(
            {
                "index": index,
                "label": child_labels[index] or f"#s{index}",
                "volume": round(solid.volume, 9),
                "bboxMin": [round(float(bb.min.X), 6), round(float(bb.min.Y), 6), round(float(bb.min.Z), 6)],
                "bboxMax": [round(float(bb.max.X), 6), round(float(bb.max.Y), 6), round(float(bb.max.Z), 6)],
                "bboxCenter": [
                    round(float((bb.min.X + bb.max.X) / 2), 6),
                    round(float((bb.min.Y + bb.max.Y) / 2), 6),
                    round(float((bb.min.Z + bb.max.Z) / 2), 6),
                ],
            }
        )
    return parts


def _aabb_gap(a: dict[str, Any], b: dict[str, Any]) -> float:
    gap = 0.0
    for axis in range(3):
        separation = max(b["bboxMin"][axis] - a["bboxMax"][axis], a["bboxMin"][axis] - b["bboxMax"][axis])
        gap = max(gap, separation)
    return gap


def inspect_interference(artifact: str | Path) -> dict[str, Any]:
    started = time.monotonic()
    artifact = Path(artifact)
    shape = bd.import_step(artifact)
    parts = _solid_parts(shape)
    solids = list(shape.solids())

    if parts:
        spans = [
            max(
                part["bboxMax"][axis] - part["bboxMin"][axis]
                for axis in range(3)
            )
            for part in parts
        ]
        overall = max(
            max(part["bboxMax"][axis] for part in parts) - min(part["bboxMin"][axis] for part in parts)
            for axis in range(3)
        )
        characteristic = max(max(spans), overall)
    else:
        characteristic = 1.0
    volume_tol = (1e-3 * max(characteristic, 1e-9)) ** 3
    distance_tol = 1e-4 * max(characteristic, 1e-9)

    pairs: list[dict[str, Any]] = []
    counts = {"penetration": 0, "contact": 0, "clearance": 0}
    for i in range(len(solids)):
        for j in range(i + 1, len(solids)):
            a, b = parts[i], parts[j]
            gap = _aabb_gap(a, b)
            intersection_volume = 0.0
            if gap <= 0.0:
                # AABBs overlap: exact boolean common. A boolean FAILURE is
                # an unresolved observation, never a fact: reporting the
                # pair as "contact" (the likely distance-based fallback)
                # would translate a solver failure into a physical claim.
                args = TopTools_ListOfShape()
                args.Append(solids[i].wrapped)
                tools = TopTools_ListOfShape()
                tools.Append(solids[j].wrapped)
                common = BRepAlgoAPI_Common()
                common.SetArguments(args)
                common.SetTools(tools)
                common.SetRunParallel(False)
                common.Build()
                if not common.IsDone():
                    raise InterferenceUnresolvedError(
                        f"boolean common failed for pair {a['label']}<->{b['label']}: "
                        "interference facts are unresolved for this artifact"
                    )
                intersection_volume = _volume_of(common.Shape())
            if intersection_volume > volume_tol:
                classification = "penetration"
                distance = 0.0
            else:
                distance = _distance(solids[i].wrapped, solids[j].wrapped)
                classification = "contact" if distance <= distance_tol else "clearance"
            counts[classification] += 1
            pairs.append(
                {
                    "a": a["label"],
                    "b": b["label"],
                    "intersectionVolume": round(intersection_volume, 9),
                    "minDistance": round(distance, 9),
                    "classification": classification,
                }
            )

    return {
        "units": "mm",
        "partCount": len(parts),
        "pairCount": len(pairs),
        "tolerances": {
            "volumeTolerance": round(volume_tol, 12),
            "distanceTolerance": round(distance_tol, 9),
            "basis": "bbox characteristic length of this artifact",
        },
        "parts": parts,
        "pairs": pairs,
        "summary": counts,
        "durationMs": int((time.monotonic() - started) * 1000),
    }
