from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import build123d as bd
import numpy as np
from PIL import Image, ImageDraw

DEFAULT_VIEW_NAMES = ("iso", "front", "back", "left", "right", "top", "bottom")
VIEW_NAMES = (*DEFAULT_VIEW_NAMES, "iso_opposite")

_VIEW_CAMERAS: dict[str, dict[str, tuple[float, float, float]]] = {
    "iso": {
        "forward": (-1.0, -1.0, 1.0),
        # Camera is at (-X, -Y, +Z); right = view_direction × world_up.
        "right": (1.0, -1.0, 0.0),
        "up": (1.0, 1.0, 2.0),
    },
    "iso_opposite": {
        "forward": (1.0, 1.0, 1.0),
        "right": (-1.0, 1.0, 0.0),
        "up": (-1.0, -1.0, 2.0),
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
    base_colors: np.ndarray | None = None,
) -> tuple[Image.Image, np.ndarray, dict[str, float | np.ndarray]]:
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
    # PIL rows grow downward.  Keep the declared camera up direction mapped
    # to visual up instead of vertically mirroring every orthographic view.
    sy = (height / 2.0) - ((py - center_y) * scale)

    light = np.asarray((0.45, 0.35, 0.82), dtype=np.float64)
    light = light / np.linalg.norm(light)
    intensity = 0.46 + 0.54 * np.abs(normals @ light)
    if base_colors is None:
        base_colors = np.repeat(np.asarray([[207, 212, 220]], dtype=np.float64), tri.shape[0], axis=0)
    colors = base_colors * intensity[:, None]

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

    image = Image.fromarray(np.clip(color_buffer, 0, 255).astype(np.uint8), "RGB")
    return image, z_buffer, {
        "right": right,
        "up": up,
        "forward": forward,
        "scale": scale,
        "centerX": center_x,
        "centerY": center_y,
    }


def _part_meshes(shape: bd.Shape, tolerance: float) -> list[tuple[np.ndarray, np.ndarray, np.ndarray, bd.Shape]]:
    parts = list(shape.solids()) or [shape]
    return [(*_tessellate(part, tolerance), part) for part in parts]


def _selection_index(artifact: Path, part_count: int) -> tuple[dict[str, int], dict[str, list[str]], list[dict[str, Any]]]:
    from .assembly import assembly_tree

    report = assembly_tree(artifact)
    occurrences = list(report.get("occurrences") or [])
    lookup: dict[str, int] = {}
    for index in range(part_count):
        lookup[f"#s{index}"] = index
        lookup[f"solid-{index}"] = index
        lookup[f"solid-{index + 1}"] = index
        if index >= len(occurrences):
            continue
        occurrence = occurrences[index]
        for key in (occurrence.get("ref"), occurrence.get("alias")):
            if isinstance(key, str) and key:
                lookup[key] = index
    for alias, ref in (report.get("aliases") or {}).items():
        if ref in lookup:
            lookup[str(alias)] = lookup[ref]
    ambiguous = {
        str(label): [str(item) for item in aliases]
        for label, aliases in (report.get("ambiguousLabels") or {}).items()
    }
    return lookup, ambiguous, occurrences


def _resolve_parts(
    requested: list[str] | None,
    lookup: dict[str, int],
    ambiguous: dict[str, list[str]],
    field: str,
) -> set[int]:
    resolved: set[int] = set()
    for raw in requested or []:
        token = str(raw).strip()
        if token in ambiguous:
            raise ValueError(f"{field} label {token!r} is ambiguous; use one of {ambiguous[token]}")
        if token not in lookup:
            raise ValueError(f"unknown {field} occurrence {token!r}; run preset='assembly' again")
        resolved.add(lookup[token])
    return resolved


def _explode_offsets(meshes: list[tuple[np.ndarray, np.ndarray, np.ndarray, bd.Shape]], amount: float) -> list[np.ndarray]:
    if amount <= 0 or len(meshes) <= 1:
        return [np.zeros(3, dtype=np.float64) for _ in meshes]
    all_points = np.concatenate([mesh[0] for mesh in meshes], axis=0)
    center = all_points.mean(axis=0)
    diagonal = float(np.linalg.norm(all_points.max(axis=0) - all_points.min(axis=0)))
    offsets: list[np.ndarray] = []
    fallback = (
        np.asarray((1.0, 0.0, 0.0)),
        np.asarray((0.0, 1.0, 0.0)),
        np.asarray((0.0, 0.0, 1.0)),
    )
    for index, (points, _triangles, _normals, _part) in enumerate(meshes):
        direction = points.mean(axis=0) - center
        length = float(np.linalg.norm(direction))
        if length < 1e-9:
            direction = fallback[index % len(fallback)]
        else:
            direction = direction / length
        offsets.append(direction * diagonal * 0.15 * amount)
    return offsets


def _edge_polylines(part: bd.Shape, offset: np.ndarray) -> list[np.ndarray]:
    polylines: list[np.ndarray] = []
    for edge in part.edges():
        samples = min(128, max(2, int(math.ceil(float(edge.length) / 0.75)) + 1))
        points = []
        for index in range(samples):
            point = edge @ (index / max(samples - 1, 1))
            points.append((float(point.X), float(point.Y), float(point.Z)))
        polylines.append(np.asarray(points, dtype=np.float64) + offset[None, :])
    return polylines


def _draw_edges(
    image: Image.Image,
    z_buffer: np.ndarray,
    projection: dict[str, float | np.ndarray],
    polylines: list[np.ndarray],
    display: str,
) -> None:
    if display == "solid":
        return
    right = projection["right"]
    up = projection["up"]
    forward = projection["forward"]
    scale = float(projection["scale"])
    center_x = float(projection["centerX"])
    center_y = float(projection["centerY"])
    width, height = image.size
    finite_depth = z_buffer[np.isfinite(z_buffer)]
    depth_tolerance = max(float(np.ptp(finite_depth)) * 0.003, 1e-5) if finite_depth.size else 1e-5
    draw = ImageDraw.Draw(image)
    for polyline in polylines:
        px = polyline @ right
        py = polyline @ up
        pz = polyline @ forward
        sx = (px - center_x) * scale + width / 2.0
        sy = height / 2.0 - (py - center_y) * scale
        for index in range(len(polyline) - 1):
            x0, y0, z0 = float(sx[index]), float(sy[index]), float(pz[index])
            x1, y1, z1 = float(sx[index + 1]), float(sy[index + 1]), float(pz[index + 1])
            mx = int(round((x0 + x1) / 2.0))
            my = int(round((y0 + y1) / 2.0))
            visible = 0 <= mx < width and 0 <= my < height and (z0 + z1) / 2.0 >= z_buffer[my, mx] - depth_tolerance
            if display == "solid_with_edges" and not visible:
                continue
            if display == "hidden_edges" and not visible:
                if index % 2 == 0:
                    draw.line((x0, y0, x1, y1), fill=(180, 184, 190), width=1)
                continue
            draw.line((x0, y0, x1, y1), fill=(45, 49, 55), width=1)


def render_views(
    artifact: str | Path,
    out_dir: str | Path,
    views: list[str] | None = None,
    width: int = 640,
    height: int = 480,
    display: str = "solid",
    labels: bool = False,
    focus: list[str] | None = None,
    hide: list[str] | None = None,
    explode: float = 0.0,
    ghost_others: bool = True,
) -> dict[str, Any]:
    artifact = Path(artifact)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    shape = bd.import_step(artifact)

    bb = shape.bounding_box()
    size = bb.size
    diagonal = math.sqrt(size.X**2 + size.Y**2 + size.Z**2)
    tolerance = max(diagonal * 0.0025, 0.05)
    if display not in {"solid", "solid_with_edges", "hidden_edges", "wireframe"}:
        raise ValueError("display must be solid, solid_with_edges, hidden_edges, or wireframe")
    if explode < 0 or explode > 5:
        raise ValueError("explode must be between 0 and 5")
    meshes = _part_meshes(shape, tolerance)
    if focus or hide:
        lookup, ambiguous, occurrences = _selection_index(artifact, len(meshes))
    else:
        lookup, ambiguous, occurrences = {}, {}, []
    focused = _resolve_parts(focus, lookup, ambiguous, "focus")
    hidden = _resolve_parts(hide, lookup, ambiguous, "hide")
    if focused and not ghost_others:
        hidden.update(set(range(len(meshes))) - focused)
    offsets = _explode_offsets(meshes, explode)

    point_chunks: list[np.ndarray] = []
    triangle_chunks: list[np.ndarray] = []
    normal_chunks: list[np.ndarray] = []
    color_chunks: list[np.ndarray] = []
    edge_polylines: list[np.ndarray] = []
    vertex_offset = 0
    palette = np.asarray(
        ((198, 205, 214), (174, 191, 210), (205, 194, 178), (185, 202, 189), (203, 183, 194)),
        dtype=np.float64,
    )
    for index, (points, triangles, part_normals, part) in enumerate(meshes):
        if index in hidden:
            continue
        translated = points + offsets[index][None, :]
        point_chunks.append(translated)
        triangle_chunks.append(triangles + vertex_offset)
        normal_chunks.append(part_normals)
        base = np.asarray((235, 237, 240), dtype=np.float64) if focused and index not in focused else palette[index % len(palette)]
        color_chunks.append(np.repeat(base[None, :], len(triangles), axis=0))
        if display != "solid":
            edge_polylines.extend(_edge_polylines(part, offsets[index]))
        vertex_offset += len(points)
    if not point_chunks:
        raise ValueError("focus/hide selection removed every occurrence")
    pts = np.concatenate(point_chunks, axis=0)
    tri = np.concatenate(triangle_chunks, axis=0)
    normals = np.concatenate(normal_chunks, axis=0)
    base_colors = np.concatenate(color_chunks, axis=0)

    selected = list(views or DEFAULT_VIEW_NAMES)
    for view in selected:
        if view not in _VIEW_CAMERAS:
            raise ValueError(f"unsupported view: {view}; expected one of {', '.join(VIEW_NAMES)}")

    rendered: list[dict[str, Any]] = []
    for view in selected:
        solid_image, z_buffer, projection = _render_view(
            pts, tri, normals, _VIEW_CAMERAS[view], width, height, base_colors
        )
        img = Image.new("RGB", (width, height), (255, 255, 255)) if display in {"wireframe", "hidden_edges"} else solid_image
        _draw_edges(img, z_buffer, projection, edge_polylines, display)
        if labels:
            draw = ImageDraw.Draw(img)
            draw.rectangle((0, 0, width - 1, 22), fill=(245, 245, 245))
            draw.text((7, 5), view.upper(), fill=(20, 20, 20))
            # A small, explicit world-frame triad makes front/back and
            # handedness unambiguous when several thumbnails look alike.
            origin = (34, height - 32)
            axis_length = max(22, min(width, height) // 15)
            right_basis = np.asarray(_normalize(_VIEW_CAMERAS[view]["right"]), dtype=np.float64)
            up_basis = np.asarray(_normalize(_VIEW_CAMERAS[view]["up"]), dtype=np.float64)
            for name, axis, color in (
                ("X", (1.0, 0.0, 0.0), (205, 55, 55)),
                ("Y", (0.0, 1.0, 0.0), (45, 155, 75)),
                ("Z", (0.0, 0.0, 1.0), (55, 95, 205)),
            ):
                dx = float(np.dot(np.asarray(axis), right_basis)) * axis_length
                dy = -float(np.dot(np.asarray(axis), up_basis)) * axis_length
                endpoint = (origin[0] + dx, origin[1] + dy)
                draw.line((origin, endpoint), fill=color, width=2)
                draw.ellipse((endpoint[0] - 2, endpoint[1] - 2, endpoint[0] + 2, endpoint[1] + 2), fill=color)
                draw.text((endpoint[0] + 4, endpoint[1] - 7), name, fill=color)
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
        "focus": list(focus or []),
        "hide": list(hide or []),
        "explode": explode,
        "ghostOthers": ghost_others,
        "occurrences": occurrences,
    }
