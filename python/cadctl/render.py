from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import build123d as bd
import numpy as np
from PIL import Image, ImageDraw

from .shape_facts import _tessellate

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




HIGHLIGHT_COLOR = (255, 140, 0)
NON_HIGHLIGHT_DIM = 0.85
MAX_ANNOTATIONS_PER_VIEW = 8


def _tessellate_faces(
    shape: bd.Shape, tolerance: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[int]]:
    """Like ``_tessellate`` but also returns, per triangle, the index of its face."""
    vertices: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []
    face_of: list[int] = []
    offset = 0
    for face_index, face in enumerate(shape.faces()):
        verts, tris = face.tessellate(tolerance, 0.2)
        if not verts or not tris:
            continue
        vertices.extend((float(v.X), float(v.Y), float(v.Z)) for v in verts)
        triangles.extend((a + offset, b + offset, c + offset) for a, b, c in tris)
        face_of.extend([face_index] * len(tris))
        offset += len(verts)
    if not vertices or not triangles:
        raise ValueError("STEP contains no tessellatable geometry")
    pts = np.asarray(vertices, dtype=np.float64)
    tri = np.asarray(triangles, dtype=np.int64)
    normals = np.cross(pts[tri[:, 1]] - pts[tri[:, 0]], pts[tri[:, 2]] - pts[tri[:, 0]])
    norms = np.linalg.norm(normals, axis=1)
    valid = norms > 1e-12
    return pts, tri[valid], normals[valid] / norms[valid, None], [f for f, keep in zip(face_of, valid) if keep]


def _highlighted_faces(part: bd.Shape, highlight: list[dict[str, Any]], diagonal: float) -> set[int]:
    """Indices of ``part`` faces that match a highlight fingerprint."""
    from .fingerprints import face_fingerprint, match_faces

    prints = [face_fingerprint(face, index) for index, face in enumerate(part.faces())]
    matched = match_faces(highlight, prints, diagonal)
    return {j for _i, j in matched["pairs"]}


def _draw_annotations(
    image: Image.Image,
    z_buffer: np.ndarray,
    projection: dict[str, float | np.ndarray],
    annotations: list[dict[str, Any]],
) -> None:
    """Dots, leader lines and ASCII text boxes for visible 3D anchor points."""
    right = projection["right"]
    up = projection["up"]
    forward = projection["forward"]
    scale = float(projection["scale"])
    center_x = float(projection["centerX"])
    center_y = float(projection["centerY"])
    width, height = image.size
    finite_depth = z_buffer[np.isfinite(z_buffer)]
    depth_tolerance = max(float(np.ptp(finite_depth)) * 0.01, 1e-4) if finite_depth.size else 1e-4
    draw = ImageDraw.Draw(image)
    drawn = 0
    for annotation in annotations:
        if drawn >= MAX_ANNOTATIONS_PER_VIEW:
            break
        point = np.asarray(annotation["at"], dtype=np.float64)
        sx = float((point @ right - center_x) * scale + width / 2.0)
        sy = float(height / 2.0 - (point @ up - center_y) * scale)
        ix, iy = int(round(sx)), int(round(sy))
        if not (0 <= ix < width and 0 <= iy < height):
            continue
        if float(point @ forward) < z_buffer[iy, ix] - depth_tolerance:
            continue  # hidden behind nearer geometry
        # PIL's default font has no CJK glyphs, so labels are ASCII only.
        text = str(annotation["text"]).encode("ascii", "replace").decode("ascii")
        box_w = 6 * len(text) + 6
        tx = min(max(sx + 14, 2), width - box_w - 2)
        ty = min(max(sy - 22, 2), height - 16)
        draw.line((sx, sy, tx, ty + 7), fill=(20, 20, 20), width=1)
        draw.ellipse((sx - 3, sy - 3, sx + 3, sy + 3), fill=HIGHLIGHT_COLOR, outline=(20, 20, 20))
        draw.rectangle((tx, ty, tx + box_w, ty + 14), fill=(255, 255, 255), outline=(20, 20, 20))
        draw.text((tx + 3, ty + 2), text, fill=(0, 0, 0))
        drawn += 1


def _rasterize_reference(
    sx: np.ndarray, sy: np.ndarray, pz: np.ndarray, tri: np.ndarray, colors: np.ndarray, width: int, height: int,
) -> tuple[np.ndarray, np.ndarray]:
    """One triangle at a time. Kept as the definition of what ``_rasterize`` must produce."""
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

    return z_buffer, color_buffer


#: Triangles whose clipped bounding box is at most this many pixels wide and high go through the batched path.
_BATCH_SIZES = (2, 3, 4, 6, 8, 12, 16, 24, 32)
_BATCH_ELEMENTS = 1 << 22


def _rasterize(
    sx: np.ndarray, sy: np.ndarray, pz: np.ndarray, tri: np.ndarray, colors: np.ndarray, width: int, height: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Depth buffer and colour buffer of the triangles; the same pixels as ``_rasterize_reference``.

    The reference loop made about 25 small numpy calls per triangle: with the 60 000 triangles of a large
    assembly, seven views took 25 seconds, and every build renders them. Here triangles of similar size are
    tested together, and the covered pixels are collected and resolved at once: a pixel takes the greatest depth,
    and of equal depths the triangle that comes first, exactly what the loop's strict ``>`` gave.
    """
    z_buffer = np.full((height, width), -np.inf, dtype=np.float64)
    color_buffer = np.full((height, width, 3), 255.0, dtype=np.float64)
    count = tri.shape[0]
    if count == 0:
        return z_buffer, color_buffer
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    x0, y0, x1, y1, x2, y2 = sx[a], sy[a], sx[b], sy[b], sx[c], sy[c]
    min_px = np.maximum(0, np.floor(np.minimum(np.minimum(x0, x1), x2))).astype(np.int64)
    max_px = np.minimum(width - 1, np.ceil(np.maximum(np.maximum(x0, x1), x2))).astype(np.int64)
    min_py = np.maximum(0, np.floor(np.minimum(np.minimum(y0, y1), y2))).astype(np.int64)
    max_py = np.minimum(height - 1, np.ceil(np.maximum(np.maximum(y0, y1), y2))).astype(np.int64)
    area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
    valid = (min_px <= max_px) & (min_py <= max_py) & (np.abs(area) >= 1e-9)
    box = np.maximum(max_px - min_px, max_py - min_py) + 1
    za, zb, zc = pz[a], pz[b], pz[c]

    pixel_chunks: list[np.ndarray] = []
    depth_chunks: list[np.ndarray] = []
    index_chunks: list[np.ndarray] = []

    def cover(ids: np.ndarray, size: int) -> None:
        step = max(1, _BATCH_ELEMENTS // (size * size))
        offsets = np.arange(size, dtype=np.int64)
        for begin in range(0, ids.shape[0], step):
            t = ids[begin : begin + step]
            gx = (min_px[t][:, None, None] + offsets[None, None, :]).astype(np.float64)
            gy = (min_py[t][:, None, None] + offsets[None, :, None]).astype(np.float64)
            in_box = (gx <= max_px[t][:, None, None]) & (gy <= max_py[t][:, None, None])
            X0, Y0, X1, Y1, X2, Y2 = (v[t][:, None, None] for v in (x0, y0, x1, y1, x2, y2))
            w0 = (X1 - gx) * (Y2 - Y1) - (Y1 - gy) * (X2 - X1)
            w1 = (X2 - gx) * (Y0 - Y2) - (Y2 - gy) * (X0 - X2)
            w2 = (X0 - gx) * (Y1 - Y0) - (Y0 - gy) * (X1 - X0)
            w_sum = w0 + w1 + w2
            positive = (area[t] > 0)[:, None, None]
            lowest = np.minimum(np.minimum(w0, w1), w2) >= -1e-9
            highest = np.maximum(np.maximum(w0, w1), w2) <= 1e-9
            inside = in_box & (np.abs(w_sum) > 1e-9) & np.where(positive, lowest, highest)
            if not inside.any():
                continue
            with np.errstate(divide="ignore", invalid="ignore"):
                depth = (w0 * za[t][:, None, None] + w1 * zb[t][:, None, None] + w2 * zc[t][:, None, None]) / w_sum
            inside &= np.isfinite(depth)
            ti, row, col = np.nonzero(inside)
            pixel_chunks.append((min_py[t][ti] + row) * width + (min_px[t][ti] + col))
            depth_chunks.append(depth[ti, row, col])
            index_chunks.append(t[ti])

    previous = 0
    for size in _BATCH_SIZES:
        ids = np.nonzero(valid & (box > previous) & (box <= size))[0]
        previous = size
        if ids.shape[0]:
            cover(ids, size)
    for i in np.nonzero(valid & (box > _BATCH_SIZES[-1]))[0]:
        cover(np.asarray([i]), int(box[i]))

    if not pixel_chunks:
        return z_buffer, color_buffer
    pixel = np.concatenate(pixel_chunks)
    depth = np.concatenate(depth_chunks)
    index = np.concatenate(index_chunks)
    order = np.lexsort((index, -depth, pixel))
    pixel, depth, index = pixel[order], depth[order], index[order]
    first = np.ones(pixel.shape[0], dtype=bool)
    first[1:] = pixel[1:] != pixel[:-1]
    pixel, depth, index = pixel[first], depth[first], index[first]
    z_buffer.reshape(-1)[pixel] = depth
    color_buffer.reshape(-1, 3)[pixel] = colors[index]
    return z_buffer, color_buffer


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

    z_buffer, color_buffer = _rasterize(sx, sy, pz, tri, colors, width, height)

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


def _selection_index(artifact: Path, part_count: int) -> tuple[dict[str, set[int]], dict[str, list[str]], list[dict[str, Any]]]:
    from .assembly import assembly_tree
    from .mesh import mesh_document

    report = assembly_tree(artifact)
    identity = mesh_document(artifact)
    occurrences = list(report.get("occurrences") or [])
    lookup: dict[str, set[int]] = {}
    def bind(key: Any, index: int) -> None:
        if isinstance(key, str) and key:
            lookup.setdefault(key, set()).add(index)
    for index in range(part_count):
        bind(f"#s{index}", index)
        bind(f"solid-{index}", index)
        bind(f"solid-{index + 1}", index)
        if index < len(identity["parts"]):
            part = identity["parts"][index]
            for key in (part.get("partId"), part.get("occurrenceId"), part.get("solidId"), part.get("semanticId")):
                bind(key, index)
            for feature in part.get("features", []):
                if isinstance(feature, dict):
                    bind(feature.get("id"), index)
                    bind(feature.get("path"), index)
        if index >= len(occurrences):
            continue
        occurrence = occurrences[index]
        for key in (occurrence.get("ref"), occurrence.get("alias")):
            bind(key, index)
    for alias, ref in (report.get("aliases") or {}).items():
        if ref in lookup:
            lookup[str(alias)] = lookup[ref].copy()
    ambiguous = {
        str(label): [str(item) for item in aliases]
        for label, aliases in (report.get("ambiguousLabels") or {}).items()
    }
    return lookup, ambiguous, occurrences


def _resolve_parts(
    requested: list[str] | None,
    lookup: dict[str, set[int]],
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
        resolved.update(lookup[token])
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
    highlight: list[dict[str, Any]] | None = None,
    annotations: list[dict[str, Any]] | None = None,
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
    highlight = [item for item in (highlight or []) if isinstance(item, dict)]
    annotations = [item for item in (annotations or []) if isinstance(item, dict) and "at" in item and "text" in item]
    highlighted_by_part: list[set[int]] = []
    if highlight:
        # Per-face tessellation, only on this path: renders without a
        # highlight keep their exact pixels.
        meshes = []
        for part in (list(shape.solids()) or [shape]):
            pts_, tri_, normals_, face_of_ = _tessellate_faces(part, tolerance)
            meshes.append((pts_, tri_, normals_, part))
            chosen = _highlighted_faces(part, highlight, diagonal)
            highlighted_by_part.append({tri_index for tri_index, face_index in enumerate(face_of_) if face_index in chosen})
    else:
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
        part_colors = np.repeat(base[None, :], len(triangles), axis=0)
        if highlight and highlighted_by_part[index]:
            marked = np.zeros(len(triangles), dtype=bool)
            marked[list(highlighted_by_part[index])] = True
            part_colors[~marked] *= NON_HIGHLIGHT_DIM
            part_colors[marked] = np.asarray(HIGHLIGHT_COLOR, dtype=np.float64)
        color_chunks.append(part_colors)
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
        if annotations:
            _draw_annotations(img, z_buffer, projection, annotations)
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
        **({"highlighted": True} if highlight else {}),
        "occurrences": occurrences,
    }
