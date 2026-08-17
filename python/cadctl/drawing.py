from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import build123d as bd
import ezdxf

from .render import _normalize, _VIEW_CAMERAS


def _sample_edge(edge: bd.Edge) -> list[tuple[float, float, float]]:
    samples = max(2, min(128, int(math.ceil(edge.length / 0.5)) + 1))
    return [
        (float(p.X), float(p.Y), float(p.Z))
        for i in range(samples)
        for p in [edge @ (i / max(samples - 1, 1))]
    ]


def _project(shape: bd.Shape, view: str) -> list[tuple[float, float]]:
    cam = _VIEW_CAMERAS[view]
    right = _normalize(cam["right"])
    up = _normalize(cam["up"])
    pts: list[tuple[float, float]] = []
    for edge in shape.edges():
        for p in _sample_edge(edge):
            pts.append(
                (
                    p[0] * right[0] + p[1] * right[1] + p[2] * right[2],
                    p[0] * up[0] + p[1] * up[1] + p[2] * up[2],
                )
            )
    return pts


def validate_drawing_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(spec, dict):
        return False, ["spec must be an object"]
    if not spec.get("artifact"):
        errors.append("artifact is required")
    views = spec.get("views")
    if not isinstance(views, list) or not views:
        errors.append("views must be a non-empty array")
    else:
        for index, view in enumerate(views):
            if view.get("name") not in _VIEW_CAMERAS:
                errors.append(f"views[{index}].name must be one of {', '.join(sorted(_VIEW_CAMERAS))}")
    for index, dim in enumerate(spec.get("dimensions") or []):
        p1, p2 = dim.get("p1"), dim.get("p2")
        if not (isinstance(p1, (list, tuple)) and len(p1) == 2 and isinstance(p2, (list, tuple)) and len(p2) == 2):
            errors.append(f"dimensions[{index}] requires 2D p1 and p2")
        if not dim.get("text"):
            errors.append(f"dimensions[{index}].text is required")
    return not errors, errors


def generate_drawing(spec_path: str | Path, output_dir: str | Path) -> dict[str, Any]:
    spec_path = Path(spec_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    ok, errors = validate_drawing_spec(spec)
    if not ok:
        raise ValueError("; ".join(errors))

    artifact = spec_path.parent / spec["artifact"] if not Path(spec["artifact"]).is_absolute() else Path(spec["artifact"])
    shape = bd.import_step(artifact)
    sheet = spec.get("sheet") or {"width": 297.0, "height": 210.0}
    units = spec.get("units", "mm")

    doc = ezdxf.new("R2010", setup=True)
    doc.units = 4 if units.lower() == "mm" else 1
    doc.header["$INSUNITS"] = 4 if units.lower() == "mm" else 1
    msp = doc.modelspace()
    doc.layers.add("VIEW", color=7)
    doc.layers.add("DIM", color=1)
    doc.layers.add("TEXT", color=3)

    view_positions: dict[str, list[float]] = {}
    margin = 20.0
    auto_index = 0
    default_positions = [[margin, margin], [sheet["width"] / 2, margin], [margin, sheet["height"] / 2], [sheet["width"] / 2, sheet["height"] / 2]]
    for view in spec["views"]:
        name = view["name"]
        pts = _project(shape, name)
        if not pts:
            continue
        min_x, max_x = min(p[0] for p in pts), max(p[0] for p in pts)
        min_y, max_y = min(p[1] for p in pts), max(p[1] for p in pts)
        span_x, span_y = max(max_x - min_x, 1e-9), max(max_y - min_y, 1e-9)
        target_size = min(sheet["width"], sheet["height"]) * 0.32
        scale = target_size / max(span_x, span_y)
        position = view.get("position") or default_positions[auto_index % len(default_positions)]
        auto_index += 1
        view_positions[name] = position
        for edge in shape.edges():
            previous = None
            for p in _sample_edge(edge):
                x = position[0] + (p[0] - min_x) * scale
                y = position[1] + (p[1] - min_y) * scale
                if previous:
                    msp.add_line(previous, (x, y), dxfattribs={"layer": "VIEW"})
                previous = (x, y)

    for index, dim in enumerate(spec.get("dimensions") or []):
        p1 = dim["p1"]
        p2 = dim["p2"]
        text = dim["text"]
        msp.add_line((p1[0], p1[1]), (p2[0], p2[1]), dxfattribs={"layer": "DIM"})
        msp.add_text(text, height=3.5, dxfattribs={"layer": "TEXT"}).set_placement(((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2))
        tolerance = dim.get("tolerance")
        if tolerance:
            note = f"{text} [{tolerance.get('lower', '')}/{tolerance.get('upper', '')}]"
            msp.add_text(note, height=2.5, dxfattribs={"layer": "TEXT"}).set_placement(((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2 + 5))

    dxf_path = output_dir / "drawing.dxf"
    doc.saveas(dxf_path)
    svg_path = output_dir / "drawing.svg"
    svg_lines = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{sheet["width"]}mm" height="{sheet["height"]}mm" viewBox="0 0 {sheet["width"]} {sheet["height"]}">']
    svg_lines.append('<g stroke="black" fill="none" stroke-width="0.3">')
    for view in spec["views"]:
        name = view["name"]
        if name not in view_positions:
            continue
        pts = _project(shape, name)
        if not pts:
            continue
        min_x, max_x = min(p[0] for p in pts), max(p[0] for p in pts)
        min_y, max_y = min(p[1] for p in pts), max(p[1] for p in pts)
        span = max(max_x - min_x, max_y - min_y, 1e-9)
        scale = (min(sheet["width"], sheet["height"]) * 0.32) / span
        pos = view_positions[name]
        for edge in shape.edges():
            path_parts = []
            for p in _sample_edge(edge):
                x = pos[0] + (p[0] - min_x) * scale
                y = pos[1] + (p[1] - min_y) * scale
                path_parts.append(f"{x:.2f},{y:.2f}")
            if path_parts:
                svg_lines.append(f'<polyline points="{" ".join(path_parts)}"/>')
    svg_lines.append("</g></svg>")
    svg_path.write_text("\n".join(svg_lines), encoding="utf-8")

    manifest = {
        "spec": str(spec_path),
        "artifact": str(artifact),
        "outputs": {"dxf": str(dxf_path), "svg": str(svg_path)},
        "gd_and_t": "structured_text_only",
        "pdf": False,
        "complete": False,
        "status": "mvp_drawing",
    }
    (output_dir / "drawing-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return {
        "manifest": manifest,
        "outputs": [str(dxf_path), str(svg_path), str(output_dir / "drawing-manifest.json")],
        "warnings": [
            "MVP drawing generator: projection edges and structured dimension text only; GD&T is not standards-compliant feature-control-frame typography; PDF unavailable."
        ],
    }
