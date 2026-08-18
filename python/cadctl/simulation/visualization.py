from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

VIEW_CAMERAS = {
    "iso": {"position": (-1.0, -1.0, 1.0), "focal": (0.0, 0.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "front": {"position": (0.0, -1.0, 0.0), "focal": (0.0, 0.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "back": {"position": (0.0, 1.0, 0.0), "focal": (0.0, 0.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "left": {"position": (-1.0, 0.0, 0.0), "focal": (0.0, 0.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "right": {"position": (1.0, 0.0, 0.0), "focal": (0.0, 0.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "top": {"position": (0.0, 0.0, 1.0), "focal": (0.0, 0.0, 0.0), "up": (0.0, 1.0, 0.0)},
    "bottom": {"position": (0.0, 0.0, -1.0), "focal": (0.0, 0.0, 0.0), "up": (0.0, -1.0, 0.0)},
}


def render_simulation_views(
    nodes: np.ndarray,
    elements: np.ndarray,
    displacement: np.ndarray,
    element_field: np.ndarray,
    output_dir: str | Path,
    field_name: str = "vonMises",
    views: list[str] | None = None,
    width: int = 640,
    height: int = 480,
) -> dict[str, Any]:
    """Render seven deterministic simulation result views with PyVista.

    The views are field visualizations of the deformed FE mesh. They are
    observation artifacts, not engineering conclusions.
    """
    import pyvista as pv

    pv.OFF_SCREEN = True
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    nodes_np = np.asarray(nodes, dtype=np.float64)
    elements_np = np.asarray(elements, dtype=np.int64)
    displacement_np = np.asarray(displacement, dtype=np.float64)
    if displacement_np.shape != nodes_np.shape:
        raise ValueError("displacement shape must match nodes")
    deformed = nodes_np + displacement_np

    n_elem, nodes_per = elements_np.shape
    cells = np.empty((n_elem, nodes_per + 1), dtype=np.int64)
    cells[:, 0] = nodes_per
    cells[:, 1:] = elements_np
    celltypes = np.full(n_elem, pv.CellType.TETRA, dtype=np.uint8)
    grid = pv.UnstructuredGrid(cells.ravel(), celltypes, deformed.tolist())
    if element_field.ndim == 2 and element_field.shape == (n_elem, 3):
        field = element_field
    elif element_field.shape == (n_elem,):
        field = element_field
    else:
        field = np.full(n_elem, np.nan)
    grid.cell_data[field_name] = field

    selected = list(views or VIEW_CAMERAS.keys())
    rendered: list[dict[str, Any]] = []
    for view in selected:
        camera = VIEW_CAMERAS[view]
        plotter = pv.Plotter(off_screen=True, window_size=[width, height])
        plotter.add_mesh(
            grid,
            scalars=field_name,
            cmap="viridis",
            show_edges=True,
            lighting=True,
            smooth_shading=True,
            scalar_bar_args={"title": field_name, "vertical": True, "position_x": 0.85, "position_y": 0.05},
        )
        bounds = grid.bounds
        center = (
            (bounds[0] + bounds[1]) / 2.0,
            (bounds[2] + bounds[3]) / 2.0,
            (bounds[4] + bounds[5]) / 2.0,
        )
        span = max(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4], 1e-9)
        dist = span * 1.9
        pos = tuple(center[i] + camera["position"][i] * dist for i in range(3))
        plotter.camera_position = [pos, center, camera["up"]]
        path = output_dir / f"{view}.png"
        plotter.screenshot(path, return_img=False)
        plotter.close()
        rendered.append(
            {
                "name": view,
                "path": str(path),
                "camera": {"position": pos, "focalPoint": center, "viewUp": camera["up"]},
                "width": width,
                "height": height,
            }
        )
    return {"views": rendered, "field": field_name, "display": "deformed"}
