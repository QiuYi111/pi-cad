"""Deterministic field views for SU2 flow/thermal results.

Observation artifacts only: colored surface and longitudinal-slice views of
the raw solution fields. The renderer never annotates engineering meaning.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

_VIEW_CAMERAS = {
    "iso": {"position": (-1.0, -1.0, 1.0), "up": (0.0, 0.0, 1.0)},
    "front": {"position": (0.0, -1.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "side": {"position": (1.0, 0.0, 0.0), "up": (0.0, 0.0, 1.0)},
}


def render_su2_views(
    nodes: np.ndarray,
    elements: np.ndarray,
    boundary_triangles: list[list[int]],
    point_fields: dict[str, np.ndarray],
    output_dir: str | Path,
    field_name: str,
    views: list[str] | None = None,
    width: int = 720,
    height: int = 520,
) -> dict[str, Any]:
    """Render boundary-field views plus one longitudinal mid-plane slice."""
    import pyvista as pv

    pv.OFF_SCREEN = True
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if field_name not in point_fields:
        field_name = next(iter(point_fields))

    n_cells = elements.shape[0]
    cells = np.empty((n_cells, 5), dtype=np.int64)
    cells[:, 0] = 4
    cells[:, 1:] = elements
    celltypes = np.full(n_cells, pv.CellType.TETRA, dtype=np.uint8)
    volume = pv.UnstructuredGrid(cells.ravel(), celltypes, nodes)
    for name, values in point_fields.items():
        if values.ndim == 1 and len(values) == len(nodes):
            volume.point_data[name] = values

    surface = volume.extract_surface()
    surface = surface.compute_normals(auto_orient_normals=True)

    rendered: list[dict[str, Any]] = []
    selected = list(views) if views else ["iso", "front", "side"]
    for view in selected:
        camera = _VIEW_CAMERAS.get(view, _VIEW_CAMERAS["iso"])
        plotter = pv.Plotter(off_screen=True, window_size=[width, height])
        plotter.add_mesh(
            surface,
            scalars=field_name,
            cmap="viridis",
            show_edges=False,
            smooth_shading=True,
            scalar_bar_args={"title": field_name, "vertical": True, "position_x": 0.85, "position_y": 0.05},
        )
        bounds = surface.bounds
        center = (
            (bounds[0] + bounds[1]) / 2.0,
            (bounds[2] + bounds[3]) / 2.0,
            (bounds[4] + bounds[5]) / 2.0,
        )
        span = max(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4], 1e-9)
        pos = tuple(center[i] + camera["position"][i] * span * 1.9 for i in range(3))
        plotter.camera_position = [pos, center, camera["up"]]
        path = output_dir / f"su2-{view}.png"
        plotter.screenshot(path, return_img=False)
        plotter.close()
        rendered.append(
            {
                "name": view,
                "path": str(path),
                "kind": "surface",
                "field": field_name,
                "camera": {"position": pos, "focalPoint": center, "viewUp": camera["up"]},
                "width": width,
                "height": height,
            }
        )

    # Longitudinal mid-plane slice: normal along the smallest bounding-box
    # extent, so the section contains the longest axis.
    try:
        bounds = volume.bounds
        extents = [bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]]
        axis = int(np.argmin(extents))
        normal = [0.0, 0.0, 0.0]
        normal[axis] = 1.0
        center = (
            (bounds[0] + bounds[1]) / 2.0,
            (bounds[2] + bounds[3]) / 2.0,
            (bounds[4] + bounds[5]) / 2.0,
        )
        sliced = volume.slice(normal=normal, origin=center)
        if sliced.n_cells:
            plotter = pv.Plotter(off_screen=True, window_size=[width, height])
            plotter.add_mesh(
                sliced,
                scalars=field_name,
                cmap="viridis",
                show_edges=True,
                scalar_bar_args={"title": field_name, "vertical": True, "position_x": 0.85, "position_y": 0.05},
            )
            span = max(extents)
            pos = tuple(center[i] + _VIEW_CAMERAS["iso"]["position"][i] * span * 1.9 for i in range(3))
            plotter.camera_position = [pos, center, _VIEW_CAMERAS["iso"]["up"]]
            path = output_dir / "su2-slice.png"
            plotter.screenshot(path, return_img=False)
            plotter.close()
            rendered.append(
                {
                    "name": "slice",
                    "path": str(path),
                    "kind": "midplane_slice",
                    "field": field_name,
                    "sliceNormal": normal,
                    "width": width,
                    "height": height,
                }
            )
    except Exception:
        pass

    return {"views": rendered, "field": field_name, "display": "surface+slice"}
