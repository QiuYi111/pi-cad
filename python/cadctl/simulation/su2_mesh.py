"""Mesh a STEP fluid-domain or solid into SU2 format with surface-ID markers.

The mesh is the bridge between canonical surface selectors and SU2 marker
names: every boundary face of the artifact becomes one gmsh physical group
named by its ``surf-`` ID, so ``boundaries[].surfaces[]`` in a flow/thermal
spec maps one-to-one onto SU2 ``MARKER_*`` entries.

Geometry units: the spec declares how STEP numbers should be interpreted
(``mm`` or ``m``); the written ``.su2`` mesh is always in meters because the
flow/thermal physical quantities in the spec are SI. No implicit scale ever
reaches the solver.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .surface_selector import enumerate_surfaces

_UNIT_SCALE = {"mm": 1e-3, "m": 1.0, "meter": 1.0, "millimeter": 1e-3}


class MeshGenerationError(RuntimeError):
    pass


def unit_scale(geometry_units: str) -> float:
    key = str(geometry_units).strip().lower()
    if key not in _UNIT_SCALE:
        raise MeshGenerationError(
            f"unsupported geometryUnits {geometry_units!r}; expected one of mm, m"
        )
    return _UNIT_SCALE[key]


def _entity_triangles(gmsh: Any, tag: int, node_index: dict[int, int]) -> list[list[int]]:
    import numpy as np

    element_types, _, element_nodes = gmsh.model.mesh.getElements(2, tag)
    triangles: list[list[int]] = []
    for element_type, nodes_flat in zip(element_types, element_nodes):
        if element_type != 2:  # 2 = linear triangle
            continue
        for row in np.asarray(nodes_flat, dtype=np.int64).reshape(-1, 3):
            triangles.append([node_index[int(v)] for v in row])
    return triangles


def mesh_step_su2(
    artifact: str | Path,
    output_path: str | Path,
    *,
    geometry_units: str,
    max_size: float,
    min_size: float | None = None,
) -> dict[str, Any]:
    """Mesh the artifact's single solid and write an SU2 mesh in meters.

    Returns mesh facts plus the marker connectivity needed for per-surface
    statistics: every boundary surface carries its canonical ``surf-`` ID.
    """
    import gmsh
    import numpy as np

    artifact = Path(artifact)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Canonical surface facts (exact B-Rep) define the marker names.
    surface_report = enumerate_surfaces(artifact)
    surfaces = surface_report["surfaces"]
    if not surfaces:
        raise MeshGenerationError(f"artifact has no boundary surfaces: {artifact}")

    scale = unit_scale(geometry_units)

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("pi-cad")
        gmsh.model.occ.importShapes(str(artifact.resolve()))
        gmsh.model.occ.synchronize()

        volumes = gmsh.model.getEntities(3)
        if len(volumes) != 1:
            raise MeshGenerationError(
                f"expected exactly one volume to mesh in V1; {artifact.name} has {len(volumes)}"
            )

        gmsh.option.setNumber("Mesh.MeshSizeMax", float(max_size))
        gmsh.option.setNumber("Mesh.MeshSizeMin", float(min_size if min_size else max_size * 0.35))
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.model.mesh.generate(3)

        node_tags, coords, _ = gmsh.model.mesh.getNodes()
        nodes_model = np.asarray(coords, dtype=np.float64).reshape(-1, 3)
        node_index = {int(tag): i for i, tag in enumerate(node_tags)}
        coord_map = {int(tag): nodes_model[i] for i, tag in enumerate(node_tags)}

        # Match each gmsh surface entity to a canonical surface by nearest
        # bbox-center (exact for every face type, unlike a curved face's
        # seam-dependent "center"). One CAD face may arrive seam-split into
        # several mesh entities (common for full cylinders/cones), so the
        # mapping is many-entities -> one marker; each entity is claimed by
        # exactly one marker. Per-marker area is then verified against the
        # exact B-Rep area: mesh facets approximate curved faces from inside
        # (~1-2% low).
        marker_to_entities: dict[str, list[int]] = {}
        entity_areas: dict[int, float] = {}
        for _dim, tag in gmsh.model.getEntities(2):
            triangles = _entity_triangles(gmsh, tag, node_index)
            if not triangles:
                continue
            area = 0.0
            centroid_sum = np.zeros(3)
            for tri in triangles:
                p = [nodes_model[v] for v in tri]
                cross = np.cross(p[1] - p[0], p[2] - p[0])
                face_area = 0.5 * float(np.linalg.norm(cross))
                area += face_area
                centroid_sum += face_area * (p[0] + p[1] + p[2]) / 3.0
            centroid = centroid_sum / area if area else np.zeros(3)
            entity_areas[tag] = area

            best = None
            best_distance = None
            for surface in surfaces:
                distance = float(np.linalg.norm(centroid - np.asarray(surface["bboxCenter"])))
                if best_distance is None or distance < best_distance:
                    best_distance = distance
                    best = surface
            marker_to_entities.setdefault(best["id"], []).append(tag)

        bad_areas: list[str] = []
        for surface in surfaces:
            matched_area = sum(
                entity_areas[tag] for tag in marker_to_entities.get(surface["id"], [])
            )
            exact_area = surface["area"]  # both sides are in model units here
            if not (0.5 * exact_area <= matched_area <= 1.5 * exact_area):
                bad_areas.append(surface["id"])
        if bad_areas or len(marker_to_entities) != len(surfaces):
            raise MeshGenerationError(
                "could not match every boundary surface to a canonical surface ID "
                f"(matched {len(marker_to_entities)}/{len(surfaces)}, bad area match {bad_areas})"
            )

        gmsh.model.addPhysicalGroup(3, [volumes[0][1]], name="fluid")
        for marker, tags in marker_to_entities.items():
            gmsh.model.addPhysicalGroup(2, tags, name=marker)

        # Scale to meters at export time; SU2 physical quantities are SI.
        gmsh.option.setNumber("Mesh.ScalingFactor", scale)
        gmsh.write(str(output_path))

        element_types, _, element_nodes = gmsh.model.mesh.getElements(3)
        tetrahedra = 0
        for element_type, nodes_flat in zip(element_types, element_nodes):
            if element_type == 4:  # linear tetrahedron
                tetrahedra += len(nodes_flat) // 4
        if tetrahedra == 0:
            raise MeshGenerationError("gmsh produced no 3D tetrahedral elements")

        marker_stats: dict[str, Any] = {}
        for marker, tags in marker_to_entities.items():
            triangles: list[list[int]] = []
            marker_nodes: set[int] = set()
            for tag in tags:
                for tri in _entity_triangles(gmsh, tag, node_index):
                    triangles.append(tri)
                    marker_nodes.update(tri)
            marker_stats[marker] = {
                "triangles": triangles,
                "nodeCount": len(marker_nodes),
            }

        return {
            "meshPath": str(output_path),
            "nodes": (nodes_model * scale).tolist(),
            "nodeCount": int(nodes_model.shape[0]),
            "elementCount": int(tetrahedra),
            "elementType": "tet",
            "meshSizeMax": float(max_size),
            "meshSizeMin": float(min_size if min_size else max_size * 0.35),
            "geometryUnits": geometry_units,
            "scaleToMeters": scale,
            "markers": marker_stats,
            "surfaceCount": len(surfaces),
            "generator": f"gmsh {gmsh.__version__}",
        }
    finally:
        gmsh.finalize()
