from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np


def _gmsh_available() -> bool:
    try:
        import gmsh  # noqa: F401

        return True
    except Exception:
        return False


def mesh_step_tetra(artifact: str | Path, size: float) -> dict[str, Any]:
    """Mesh a STEP solid with first-order tetrahedra using the Gmsh Python API."""
    import gmsh

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("Mesh.MeshSizeMax", float(size))
        gmsh.option.setNumber("Mesh.MeshSizeMin", float(size) * 0.5)
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        gmsh.model.occ.importShapes(str(Path(artifact).resolve()))
        gmsh.model.occ.synchronize()
        gmsh.model.mesh.generate(3)

        node_tags, coords, _ = gmsh.model.mesh.getNodes()
        nodes = np.asarray(coords, dtype=np.float64).reshape(-1, 3)
        tag_to_idx = {tag: idx for idx, tag in enumerate(node_tags)}

        elements: list[list[int]] = []
        element_types, _element_tags, element_node_tags = gmsh.model.mesh.getElements(3)
        for elem_type, node_tags in zip(element_types, element_node_tags):
            # 4 = linear tetrahedron, 10 = quadratic tetrahedron.
            if elem_type not in (4, 10):
                continue
            nodes_per_elem = 4 if elem_type == 4 else 10
            tags = np.asarray(node_tags, dtype=np.int64).reshape(-1, nodes_per_elem)
            elements.extend([[tag_to_idx[t] for t in row] for row in tags])

        if not elements:
            raise RuntimeError("Gmsh produced no 3D tetrahedral elements")
        return {
            "nodes": nodes.tolist(),
            "elements": elements,
            "elementType": "tet",
            "meshSize": float(size),
            "generator": f"gmsh {gmsh.__version__}",
        }
    finally:
        gmsh.finalize()


def structured_tetra_box(size: tuple[float, float, float], mesh_size: float) -> dict[str, Any]:
    """Structured tetrahedral cuboid mesh used by the no-STEP walking skeleton."""
    try:
        from torchfem.mesh import cube_tetra

        import torch
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(f"torch-fem is not installed: {exc}") from exc

    nx = max(2, int(max(size[0], 1.0) / mesh_size) + 1)
    ny = max(2, int(max(size[1], 1.0) / mesh_size) + 1)
    nz = max(2, int(max(size[2], 1.0) / mesh_size) + 1)
    nodes, elements = cube_tetra(nx, ny, nz, float(size[0]), float(size[1]), float(size[2]))
    return {
        "nodes": nodes.detach().cpu().numpy().tolist(),
        "elements": elements.detach().cpu().numpy().astype(int).tolist(),
        "elementType": "tet",
        "meshSize": float(mesh_size),
        "generator": "torchfem.structured",
    }
