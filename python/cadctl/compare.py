from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import build123d as bd
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.gp import gp_Trsf


def _summary(shape: bd.Shape) -> dict[str, Any]:
    bb = shape.bounding_box()
    return {
        "bbox": [round(float(v), 6) for v in (bb.size.X, bb.size.Y, bb.size.Z)],
        "bboxMin": [round(float(v), 6) for v in (bb.min.X, bb.min.Y, bb.min.Z)],
        "bboxMax": [round(float(v), 6) for v in (bb.max.X, bb.max.Y, bb.max.Z)],
        "volume": round(float(shape.volume), 6),
        "surfaceArea": round(float(shape.area), 6),
        "solidCount": len(shape.solids()),
        "faceCount": len(shape.faces()),
        "edgeCount": len(shape.edges()),
        "vertexCount": len(shape.vertices()),
        "center": [round(float(v), 6) for v in (bb.center().X, bb.center().Y, bb.center().Z)],
    }


def _apply_transform(shape: bd.Shape, matrix: list[list[float]] | None) -> bd.Shape:
    if matrix is None:
        return shape
    if len(matrix) != 4 or any(len(row) != 4 for row in matrix):
        raise ValueError("transform must be a 4x4 matrix")
    trsf = gp_Trsf()
    # OCC SetValues is row-major: three rows of [R|t].
    trsf.SetValues(
        float(matrix[0][0]), float(matrix[0][1]), float(matrix[0][2]), float(matrix[0][3]),
        float(matrix[1][0]), float(matrix[1][1]), float(matrix[1][2]), float(matrix[1][3]),
        float(matrix[2][0]), float(matrix[2][1]), float(matrix[2][2]), float(matrix[2][3]),
    )
    api = BRepBuilderAPI_Transform(shape.wrapped, trsf, True)
    transformed = api.Shape()
    return bd.Compound(transformed)


def compare_geometry(
    before: str | Path,
    after: str | Path,
    transform_before: list[list[float]] | None = None,
    transform_after: list[list[float]] | None = None,
    metrics: list[str] | None = None,
    diff_output: str | Path | None = None,
) -> dict[str, Any]:
    before_path = Path(before)
    after_path = Path(after)
    before_shape = _apply_transform(bd.import_step(before_path), transform_before)
    after_shape = _apply_transform(bd.import_step(after_path), transform_after)

    before_summary = _summary(before_shape)
    after_summary = _summary(after_shape)

    delta: dict[str, Any] = {}
    for key in ("bbox", "volume", "surfaceArea", "solidCount", "faceCount", "edgeCount", "vertexCount"):
        a = before_summary[key]
        b = after_summary[key]
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            delta[key] = round(float(b) - float(a), 6)
        elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            delta[key] = [round(float(b[i]) - float(a[i]), 6) for i in range(len(a))]

    center_delta = [
        round(float(after_summary["center"][i]) - float(before_summary["center"][i]), 6)
        for i in range(3)
    ]

    common_volume: float | None = None
    common_solid_count: int | None = None
    try:
        common = before_shape.intersect(after_shape)
        if common:
            common_volume = round(float(sum((s.volume for s in common), 0.0)), 6)
            common_solid_count = len(common)
    except Exception:
        common_volume = None
        common_solid_count = None

    payload: dict[str, Any] = {
        "units": "mm",
        "before": before_summary,
        "after": after_summary,
        "delta": delta,
        "centerDelta": center_delta,
        "transformBefore": transform_before,
        "transformAfter": transform_after,
        "metrics": metrics,
        "commonVolume": common_volume,
        "commonSolidCount": common_solid_count,
    }
    if diff_output:
        from .common import write_json

        write_json(diff_output, payload)
        payload["diff"] = str(diff_output)
    return payload
