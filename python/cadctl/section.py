from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import build123d as bd
import numpy as np
from PIL import Image, ImageDraw

from .render import _normalize, _tessellate


def _polyline_points(edge: bd.Edge, samples: int) -> list[tuple[float, float, float]]:
    """Sample an edge in its parameter space. V0 sectioning uses equal
    parameter steps; output remains deterministic for a given artifact."""
    pts: list[tuple[float, float, float]] = []
    for i in range(samples):
        t = i / max(samples - 1, 1)
        p = edge @ t
        pts.append((float(p.X), float(p.Y), float(p.Z)))
    return pts


def _draw_projected_edges(
    image: Image.Image,
    edges: list[bd.Edge],
    right: np.ndarray,
    up: np.ndarray,
    color: tuple[int, int, int],
    width: int,
    height: int,
    fit_from: list[tuple[float, float]] | None = None,
) -> None:
    if not edges:
        return
    pts2d: list[tuple[float, float]] = []
    for edge in edges:
        samples = max(2, int(math.ceil(edge.length / 0.5)) + 1)
        samples = min(samples, 128)
        for p in _polyline_points(edge, samples):
            pts2d.append((float(np.dot(p, right)), float(np.dot(p, up))))
    if not pts2d:
        return
    if fit_from:
        all_x = [p[0] for p in fit_from] + [p[0] for p in pts2d]
        all_y = [p[1] for p in fit_from] + [p[1] for p in pts2d]
    else:
        all_x = [p[0] for p in pts2d]
        all_y = [p[1] for p in pts2d]
    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)
    span_x = max(max_x - min_x, 1e-9)
    span_y = max(max_y - min_y, 1e-9)
    margin = max(10, int(min(width, height) * 0.04))
    scale = min((width - 2 * margin) / span_x, (height - 2 * margin) / span_y)
    cx, cy = (min_x + max_x) / 2.0, (min_y + max_y) / 2.0
    draw = ImageDraw.Draw(image)
    last = None
    for idx, p in enumerate(pts2d):
        x = (p[0] - cx) * scale + width / 2.0
        y = (p[1] - cy) * scale + height / 2.0
        if idx > 0:
            draw.line((last[0], last[1], x, y), fill=color, width=1)
        last = (x, y)


def render_section(
    artifact: str | Path,
    out_dir: str | Path,
    origin: tuple[float, float, float],
    normal: tuple[float, float, float],
    width: int = 640,
    height: int = 480,
    display: str = "solid",
    labels: bool = False,
) -> dict[str, Any]:
    artifact = Path(artifact)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    shape = bd.import_step(artifact)
    if math.sqrt(sum(c * c for c in normal)) < 1e-12:
        raise ValueError("section normal must be non-zero")

    plane = bd.Plane(origin=bd.Vector(*origin), z_dir=bd.Vector(*normal))
    intersections = shape.intersect(plane)
    section_faces: list[bd.Face] = []
    section_edges: list[bd.Edge] = []
    section_area = 0.0
    if intersections:
        for item in intersections:
            if isinstance(item, bd.Face):
                section_faces.append(item)
                section_area += float(item.area)
                section_edges.extend(item.edges())
            elif hasattr(item, "edges"):
                section_edges.extend(item.edges())

    right = np.asarray((plane.x_dir.X, plane.x_dir.Y, plane.x_dir.Z), dtype=np.float64)
    up = np.asarray((plane.y_dir.X, plane.y_dir.Y, plane.y_dir.Z), dtype=np.float64)
    forward = np.asarray((plane.z_dir.X, plane.z_dir.Y, plane.z_dir.Z), dtype=np.float64)
    right = right / np.linalg.norm(right)
    up = up / np.linalg.norm(up)
    forward = forward / np.linalg.norm(forward)

    # Base image: hidden edges of the complete artifact behind the section.
    img = Image.new("RGB", (width, height), (255, 255, 255))
    all_edges = list(shape.edges())
    fit_pts: list[tuple[float, float]] | None = None
    if display in {"hidden_edges", "solid_with_hidden"} and section_faces:
        # Compute fit from the section face bounds for a stable frame.
        fit_pts = []
        for face in section_faces:
            bb = face.bounding_box()
            for p in (bb.min, bb.max):
                fit_pts.append(
                    (
                        float(p.X * right[0] + p.Y * right[1] + p.Z * right[2]),
                        float(p.X * up[0] + p.Y * up[1] + p.Z * up[2]),
                    )
                )
    if display in {"hidden_edges", "solid_with_hidden"}:
        _draw_projected_edges(img, all_edges, right, up, (214, 214, 214), width, height, fit_pts)

    # Fill section faces by rasterizing their tessellations in section-plane
    # coordinates. Painter order is irrelevant for a single plane.
    if section_faces:
        section_shape = bd.Compound(children=section_faces)
        diag = max(
            math.sqrt(sum(c * c for c in (section_shape.bounding_box().size.X, section_shape.bounding_box().size.Y, section_shape.bounding_box().size.Z))),
            1.0,
        )
        tolerance = max(diag * 0.0025, 0.05)
        pts, tri, normals = _tessellate(section_shape, tolerance)
        # Project into the section-plane 2D frame.
        px = pts @ right
        py = pts @ up
        pz = pts @ forward
        min_x, max_x = float(px.min()), float(px.max())
        min_y, max_y = float(py.min()), float(py.max())
        span_x = max(max_x - min_x, 1e-9)
        span_y = max(max_y - min_y, 1e-9)
        margin = max(10, int(min(width, height) * 0.04))
        scale = min((width - 2 * margin) / span_x, (height - 2 * margin) / span_y)
        cx, cy = (min_x + max_x) / 2.0, (min_y + max_y) / 2.0
        sx = (px - cx) * scale + width / 2.0
        sy = (py - cy) * scale + height / 2.0

        z_buffer = np.full((height, width), -np.inf, dtype=np.float64)
        color_buffer = np.asarray(img, dtype=np.float64)
        section_color = np.asarray((168, 72, 50), dtype=np.float64)
        for i in range(tri.shape[0]):
            a, b, c = tri[i]
            x0, y0 = float(sx[a]), float(sy[a])
            x1, y1 = float(sx[b]), float(sy[b])
            x2, y2 = float(sx[c]), float(sy[c])
            min_px = max(0, math.floor(min(x0, x1, x2)))
            max_px = min(width - 1, math.ceil(max(x0, x1, x2)))
            min_py = max(0, math.floor(min(y0, y1, y2)))
            max_py = min(height - 1, math.ceil(max(y0, y1, y2)))
            if min_px > max_px or min_py > max_py:
                continue
            area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
            if abs(area) < 1e-9:
                continue
            xs = np.arange(min_px, max_px + 1, dtype=np.float64)
            ys = np.arange(min_py, max_py + 1, dtype=np.float64)
            gx, gy = np.meshgrid(xs, ys)
            w0 = (x1 - gx) * (y2 - y1) - (y1 - gy) * (x2 - x1)
            w1 = (x2 - gx) * (y0 - y2) - (y2 - gy) * (x0 - x2)
            w2 = (x0 - gx) * (y1 - y0) - (y0 - gy) * (x1 - x0)
            w_sum = w0 + w1 + w2
            inside = np.abs(w_sum) > 1e-9
            if area > 0:
                inside &= np.minimum(np.minimum(w0, w1), w2) >= -1e-9
            else:
                inside &= np.maximum(np.maximum(w0, w1), w2) <= 1e-9
            if not np.any(inside):
                continue
            depth = (w0 * pz[a] + w1 * pz[b] + w2 * pz[c]) / w_sum
            depth = np.where(np.abs(w_sum) > 1e-9, depth, np.nan)
            candidate = inside & np.isfinite(depth) & (depth > z_buffer[min_py : max_py + 1, min_px : max_px + 1])
            z_slice = z_buffer[min_py : max_py + 1, min_px : max_px + 1]
            z_slice[candidate] = depth[candidate]
            color_slice = color_buffer[min_py : max_py + 1, min_px : max_px + 1, :]
            color_slice[candidate] = section_color
        img = Image.fromarray(np.clip(color_buffer, 0, 255).astype(np.uint8), "RGB")

    if labels:
        draw = ImageDraw.Draw(img)
        draw.rectangle((0, 0, width - 1, 20), fill=(245, 245, 245))
        draw.text((6, 4), "SECTION", fill=(20, 20, 20))

    path = out_dir / "section.png"
    img.save(path)

    return {
        "views": [
            {
                "name": "section",
                "path": str(path),
                "width": width,
                "height": height,
                "camera": {
                    "right": [float(c) for c in right],
                    "up": [float(c) for c in up],
                    "forward": [float(c) for c in forward],
                },
            }
        ],
        "plane": {
            "origin": [float(c) for c in origin],
            "normal": [float(c) for c in normal],
        },
        "intersectionCurves": len(section_edges),
        "sectionFaceCount": len(section_faces),
        "sectionArea": round(section_area, 6),
        "display": display,
        "units": "mm",
    }
