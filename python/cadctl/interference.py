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
from typing import Any, Sequence

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


def inspect_interference_shape(shape: bd.Shape, pairs: Sequence[tuple[int, int]] | None = None) -> dict[str, Any]:
    """Inspect an already imported (and, if needed, posed) B-Rep.

    ``pairs`` selects explicit solid index pairs and allows callers to reuse
    this same exact AABB/common implementation across a pose batch.
    """
    started = time.monotonic()
    parts = _solid_parts(shape)
    solids = list(shape.solids())
    selected_pairs = list(pairs) if pairs is not None else [(i, j) for i in range(len(solids)) for j in range(i + 1, len(solids))]
    if pairs is not None and not selected_pairs:
        raise InterferenceUnresolvedError("empty interference selection: choose at least one solid pair")
    for i, j in selected_pairs:
        if i == j or min(i, j) < 0 or max(i, j) >= len(solids):
            raise InterferenceUnresolvedError(f"invalid solid pair ({i}, {j}) for {len(solids)} solids")

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
    for i, j in selected_pairs:
        if j < i:
            i, j = j, i
        a, b = parts[i], parts[j]
        gap = _aabb_gap(a, b)
        intersection_volume = 0.0
        if gap <= 0.0:
            # AABBs overlap: exact boolean common. A boolean FAILURE is
            # an unresolved observation, never a fact: reporting the
            # pair as "contact" would translate solver failure into fact.
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
                "solidIndices": [i, j],
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


def inspect_interference(artifact: str | Path) -> dict[str, Any]:
    """Import once and compute pairwise interference facts for a STEP file."""
    try:
        shape = bd.import_step(Path(artifact))
    except Exception as error:
        raise InterferenceUnresolvedError(f"cannot import subject artifact: {error}") from error
    return inspect_interference_shape(shape)


def inspect_interference_batch(
    shape: bd.Shape,
    poses: Sequence[dict[str, Any]],
    pairs: Sequence[tuple[int, int]] | None = None,
) -> dict[str, Any]:
    """Evaluate a finite rigid-pose list after the caller's one STEP import.

    Each pose contains ``id`` and optional transforms, a list of
    ``{solidIndex, translationMm, rotationDegrees}`` records. Missing solids
    stay fixed. Results make failures explicit and never claim coverage of
    continuous motion between samples.
    """
    if not poses:
        raise InterferenceUnresolvedError("empty pose selection: provide at least one pose")
    if len(poses) > 1000:
        raise InterferenceUnresolvedError("pose batch exceeds the 1000-pose safety limit")
    source_solids = list(shape.solids())
    results: list[dict[str, Any]] = []
    for ordinal, pose in enumerate(poses):
        pose_id = str(pose.get("id", ordinal))
        try:
            posed_solids = list(source_solids)
            for transform in pose.get("transforms", []):
                index = int(transform["solidIndex"])
                if index < 0 or index >= len(posed_solids):
                    raise ValueError(f"solidIndex {index} is out of range")
                translation = transform.get("translationMm", [0, 0, 0])
                rotation = transform.get("rotationDegrees", [0, 0, 0])
                if len(translation) != 3 or len(rotation) != 3:
                    raise ValueError("translationMm and rotationDegrees must have three values")
                posed_solids[index] = source_solids[index].moved(bd.Location(tuple(translation), tuple(rotation)))
            posed_shape = bd.Compound(children=posed_solids)
            facts = inspect_interference_shape(posed_shape, pairs)
            results.append({"poseId": pose_id, "status": "evaluated", "facts": facts})
        except Exception as error:  # preserve each failed pose as an explicit unresolved row
            results.append({"poseId": pose_id, "status": "error", "error": f"{type(error).__name__}: {error}"})
    evaluated = sum(item["status"] == "evaluated" for item in results)
    errors = len(results) - evaluated
    return {
        "executionStatus": "completed" if errors == 0 else "partial",
        "coverage": "finite sampled poses only; no claim between samples",
        "requested": len(poses),
        "evaluated": evaluated,
        "skipped": 0,
        "errors": errors,
        "units": {"translation": "mm", "rotation": "degree"},
        "poses": results,
    }
