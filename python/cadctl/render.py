from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import build123d as bd
import numpy as np
from PIL import Image, ImageDraw

VIEW_NAMES = ("iso", "front", "back", "left", "right", "top", "bottom")

_VIEW_CAMERAS: dict[str, dict[str, tuple[float, float, float]]] = {
    "iso": {
        "forward": (-1.0, -1.0, 1.0),
        "right": (-1.0, 1.0, 0.0),
        "up": (1.0, 1.0, 2.0),
    },
    "front": {
        "forward": (0.0, -1.0, 0.0),
        "right": (1.0, 0.0, 0.0),
        "up": (0.0, 0.0, 1.0),
    },
    "back": {
        "forward": (0.0, 1.0, 0.0),
        "right": (-1.0, 0.0, 0.0),
        "up": (0.0, 0.0, 1.0),
    },
    "left": {
        "forward": (-1.0, 0.0, 0.0),
        "right": (0.0, 1.0, 0.0),
        "up": (0.0, 0.0, 1.0),
    },
    "right": {
        "forward": (1.0, 0.0, 0.0),
        "right": (0.0, -1.0, 0.0),
        "up": (0.0, 0.0, 1.0),
    },
    "top": {
        "forward": (0.0, 0.0, 1.0),
        "right": (1.0, 0.0, 0.0),
        "up": (0.0, 1.0, 0.0),
    },
    "bottom": {
        "forward": (0.0, 0.0, -1.0),
        "right": (1.0, 0.0, 0.0),
        "up": (0.0, -1.0, 0.0),
    },
}


def _normalize(v: tuple[float, float, float]) -> tuple[float, float, float]:
    n = math.sqrt(sum(c * c for c in v))
    if n < 1e-12:
        raise ValueError("zero-length camera vector")
    return (v[0] / n, v[1] / n, v[2] / n)


def _tessellate(shape: bd.Shape, tolerance: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    vertices: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []
    offset = 0
    solids = shape.solids()
    if len(solids) == 0:
        # A single shell/face-only STEP is still renderable.
        solids = [shape]
    for solid in solids:
        verts, tris = solid.tessellate(tolerance, 0.2)
        vertices.extend((float(v.X), float(v.Y), float(v.Z)) for v in verts)
        triangles.extend((a + offset, b + offset, c + offset) for a, b, c in tris)
        offset += len(verts)
    if not vertices or not triangles:
        raise ValueError("STEP contains no tessellatable geometry")
    pts = np.asarray(vertices, dtype=np.float64)
    tri = np.asarray(triangles, dtype=np.int64)
    normals = np.cross(pts[tri[:, 1]] - pts[tri[:, 0]], pts[tri[:, 2]] - pts[tri[:, 0]])
    norms = np.linalg.norm(normals, axis=1)
    valid = norms > 1e-12
    pts = pts
    tri = tri[valid]
    normals = normals[valid] / norms[valid, None]
    return pts, tri, normals


def _render_view(
    pts: np.ndarray,
    tri: np.ndarray,
    normals: np.ndarray,
    camera: dict[str, tuple[float, float, float]],
    width: int,
    height: int,
) -> Image.Image:
    forward = np.asarray(_normalize(camera["forward"]), dtype=np.float64)
    right = np.asarray(_normalize(camera["right"]), dtype=np.float64)
    up = np.asarray(_normalize(camera["up"]), dtype=np.float64)

    px = pts @ right
    py = pts @ up
    pz = pts @ forward

    margin = max(12, int(min(width, height) * 0.06))
    min_x, max_x = float(px.min()), float(px.max())
    min_y, max_y = float(py.min()), float(py.max())
    span_x = max(max_x - min_x, 1e-9)
    span_y = max(max_y - min_y, 1e-9)
    available_w = max(width - 2 * margin, 1)
    available_h = max(height - 2 * margin, 1)
    scale = min(available_w / span_x, available_h / span_y)
    center_x = (min_x + max_x) / 2.0
    center_y = (min_y + max_y) / 2.0
    sx = ((px - center_x) * scale) + (width / 2.0)
    sy = ((py - center_y) * scale) + (height / 2.0)

    light = np.asarray((0.45, 0.35, 0.82), dtype=np.float64)
    light = light / np.linalg.norm(light)
    intensity = 0.46 + 0.54 * np.abs(normals @ light)
    base = np.asarray((207, 212, 220), dtype=np.float64)
    colors = base[None, :] * intensity[:, None]

    z_buffer = np.full((height, width), -np.inf, dtype=np.float64)
    color_buffer = np.full((height, width, 3), 255.0, dtype=np.float64)

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
        inside = (np.abs(w_sum) > 1e-9) & (np.minimum(np.minimum(w0, w1), w2) >= -1e-9 if area > 0 else np.maximum(np.maximum(w0, w1), w2) <= 1e-9)

        if not np.any(inside):
            continue

        depth = (w0 * pz[a] + w1 * pz[b] + w2 * pz[c]) / w_sum
        depth = np.where(np.abs(w_sum) > 1e-9, depth, np.nan)

        rows = np.arange(min_py, max_py + 1)[:, None]
        cols = np.arange(min_px, max_px + 1)[None, :]
        candidate = inside & np.isfinite(depth) & (depth > z_buffer[min_py : max_py + 1, min_px : max_px + 1])

        z_slice = z_buffer[min_py : max_py + 1, min_px : max_px + 1]
        z_slice[candidate] = depth[candidate]
        color_slice = color_buffer[min_py : max_py + 1, min_px : max_px + 1, :]
        color_slice[candidate] = colors[i]

    return Image.fromarray(np.clip(color_buffer, 0, 255).astype(np.uint8), "RGB")


def render_views(
    artifact: str | Path,
    out_dir: str | Path,
    views: list[str] | None = None,
    width: int = 640,
    height: int = 480,
    display: str = "solid",
    labels: bool = False,
) -> dict[str, Any]:
    artifact = Path(artifact)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    shape = bd.import_step(artifact)

    bb = shape.bounding_box()
    size = bb.size
    diagonal = math.sqrt(size.X**2 + size.Y**2 + size.Z**2)
    tolerance = max(diagonal * 0.0025, 0.05)
    pts, tri, normals = _tessellate(shape, tolerance)

    selected = list(views or VIEW_NAMES)
    for view in selected:
        if view not in _VIEW_CAMERAS:
            raise ValueError(f"unsupported view: {view}; expected one of {', '.join(VIEW_NAMES)}")

    rendered: list[dict[str, Any]] = []
    for view in selected:
        img = _render_view(pts, tri, normals, _VIEW_CAMERAS[view], width, height)
        if labels:
            draw = ImageDraw.Draw(img)
            draw.rectangle((0, 0, width - 1, 20), fill=(245, 245, 245))
            draw.text((6, 4), view.upper(), fill=(20, 20, 20))
        path = out_dir / f"{view}.png"
        img.save(path)
        camera = {
            "forward": list(_normalize(_VIEW_CAMERAS[view]["forward"])),
            "right": list(_normalize(_VIEW_CAMERAS[view]["right"])),
            "up": list(_normalize(_VIEW_CAMERAS[view]["up"])),
        }
        rendered.append({"name": view, "path": str(path), "camera": camera, "width": width, "height": height})

    solids = shape.solids()
    return {
        "views": rendered,
        "units": "mm",
        "bbox": [round(float(size.X), 6), round(float(size.Y), 6), round(float(size.Z), 6)],
        "occurrenceCount": max(len(solids), 1),
        "solidCount": len(solids),
        "display": display,
    }
