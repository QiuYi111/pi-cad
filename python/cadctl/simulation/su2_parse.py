"""Translate SU2 outputs back into canonical evidence.

SU2 world -> Pi-CAD world:

* ``history.csv`` gives the residual trajectory (log10 RMS per field). The
  convergence decision is Pi-CAD's, against the spec's residualTarget.
* ``vol_solution.vtu`` gives per-node fields on the exact mesh we generated.
  Per-surface statistics (area-weighted means, integrated mass flow, heat
  rates) are computed by Pi-CAD from its own marker connectivity instead of
  trusting SU2's surface writers.
* The heat solver writes temperature nondimensionalized by an internal
  reference. The reference is recovered exactly from the Dirichlet anchors
  Pi-CAD itself prescribed (self-calibration), so canonical temperatures
  stay in Kelvin regardless of SU2's internal scaling choices.

The module reports numbers only. Judging whether a Mach number satisfies a
requirement is the Agent's job.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

import numpy as np


class ResultParseError(RuntimeError):
    pass


def parse_history(path: str | Path) -> dict[str, Any]:
    """Residual trajectory from SU2 history.csv (steady runs)."""
    path = Path(path)
    if not path.exists():
        raise ResultParseError(f"SU2 did not write a history file: {path}")
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = [h.strip().strip('"') for h in next(reader)]
        rows = [row for row in reader if row]

    residual_columns = {
        name: index for index, name in enumerate(header) if name.startswith("rms[")
    }
    if not residual_columns:
        raise ResultParseError("history.csv contains no rms[...] residual columns")
    iterations = 0
    final: dict[str, float] = {}
    if rows:
        last = rows[-1]
        for name, index in residual_columns.items():
            try:
                final[name] = float(last[index])
            except (ValueError, IndexError):
                final[name] = float("nan")
        iterations = int(float(last[header.index("Inner_Iter")])) + 1 if "Inner_Iter" in header else len(rows)
    worst = max((v for v in final.values() if np.isfinite(v)), default=float("nan"))
    return {
        "iterations": iterations,
        "finalResidualsLog10": {k: round(v, 6) for k, v in final.items()},
        "worstResidualLog10": round(worst, 6) if np.isfinite(worst) else None,
    }


def converged(history: dict[str, Any], residual_target: float | None) -> bool:
    if residual_target is None or history.get("worstResidualLog10") is None:
        return False
    return float(history["worstResidualLog10"]) <= float(residual_target)


def read_volume_fields(path: str | Path) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Nodes and named point fields from the SU2 volume solution (.vtu)."""
    import pyvista as pv

    grid = pv.read(str(path))
    points = np.asarray(grid.points, dtype=np.float64)
    fields = {name: np.asarray(data, dtype=np.float64) for name, data in grid.point_data.items()}
    if not fields:
        raise ResultParseError("volume solution contains no point fields")
    return points, fields


def _outward_normals(
    triangles: list[list[int]],
    nodes: np.ndarray,
    elements: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Outward unit normals, areas, and owning-element index per triangle.

    Orientation uses the tetrahedron owning each boundary face: the outward
    normal points away from the owner's fourth vertex. The owner index lets
    callers use the owner's exact (constant) element gradient on the face.
    """
    face_to_owner: dict[tuple[int, int, int], int] = {}
    for element_index, tet in enumerate(elements):
        for i in range(4):
            key = tuple(sorted(int(v) for v in (tet[(i + 1) % 4], tet[(i + 2) % 4], tet[(i + 3) % 4])))
            # A boundary face appears in exactly one tet.
            if key not in face_to_owner:
                face_to_owner[key] = element_index

    normals = np.zeros((len(triangles), 3), dtype=np.float64)
    areas = np.zeros(len(triangles), dtype=np.float64)
    owners = np.full(len(triangles), -1, dtype=np.int64)
    for tri_index, tri in enumerate(triangles):
        p0, p1, p2 = (nodes[tri[0]], nodes[tri[1]], nodes[tri[2]])
        cross = np.cross(p1 - p0, p2 - p0)
        norm = float(np.linalg.norm(cross))
        if norm < 1e-15:
            continue
        owner = face_to_owner.get(tuple(sorted(int(v) for v in tri)))
        normal = cross / norm
        if owner is not None:
            owner_centroid = nodes[elements[owner]].mean(axis=0)
            face_centroid = (p0 + p1 + p2) / 3.0
            if float(np.dot(normal, face_centroid - owner_centroid)) < 0.0:
                normal = -normal
            owners[tri_index] = owner
        normals[tri_index] = normal
        areas[tri_index] = 0.5 * norm
    return normals, areas, owners


def marker_surface_stats(
    nodes: np.ndarray,
    elements: np.ndarray,
    triangles: list[list[int]],
    fields: dict[str, np.ndarray],
    velocity_field: str = "Velocity",
    density_field: str = "Density",
) -> dict[str, Any]:
    """Area-weighted field means and integrated mass flow for one marker."""
    normals, areas, _owners = _outward_normals(triangles, nodes, elements)
    total_area = float(areas.sum())
    stats: dict[str, Any] = {"areaM2": round(total_area, 9)}
    if total_area <= 0:
        return stats

    for name, values in fields.items():
        if values.ndim == 1 and len(values) == len(nodes):
            tri_values = np.asarray(
                [values[tri].mean() for tri in triangles], dtype=np.float64
            )
            stats[f"areaWeightedMean_{name}"] = round(
                float((tri_values * areas).sum() / total_area), 9
            )

    velocity = fields.get(velocity_field)
    density = fields.get(density_field)
    if velocity is not None and density is not None and velocity.shape == (len(nodes), 3):
        # Nodal quadrature of the exact integrand rho*(v.n): the solution is
        # linear on each face, so averaging the pointwise product over the
        # three nodes is exact (mean(rho)*mean(v).n is not, and introduces a
        # covariance error on compressible boundaries).
        tri_flux = 0.0
        for index, tri in enumerate(triangles):
            pointwise = density[tri] * (velocity[tri] @ normals[index])
            tri_flux += float(pointwise.mean()) * areas[index]
        stats["massFlowKgPerS"] = round(tri_flux, 9)
    return stats


def calibrate_temperature_scale(
    anchors: list[tuple[str, float]],
    marker_nodes: dict[str, set[int]],
    temperature_star: np.ndarray,
) -> float:
    """Recover the heat solver's temperature reference from Dirichlet anchors.

    T* at isothermal nodes equals T_prescribed / T_ref exactly, so the ratio
    recovers T_ref without depending on SU2's internal reference choice.
    """
    numerator = 0.0
    denominator = 0.0
    for marker, temperature_k in anchors:
        for node in marker_nodes.get(marker, set()):
            value = float(temperature_star[node])
            if value > 0 and np.isfinite(value):
                numerator += temperature_k
                denominator += value
    if denominator <= 0:
        raise ResultParseError("could not calibrate the temperature reference from isothermal nodes")
    return numerator / denominator


def node_gradients(
    nodes: np.ndarray,
    elements: np.ndarray,
    values: np.ndarray,
) -> np.ndarray:
    """Volume-weighted node gradients of a per-node field.

    The solution field is linear on each tetrahedron, so the exact element
    gradient is the plane through its four nodes; node gradients are the
    volume-weighted average of incident element gradients.
    """
    gradients = np.zeros((len(nodes), 3), dtype=np.float64)
    weights = np.zeros(len(nodes), dtype=np.float64)
    for tet in elements:
        pts = nodes[tet]
        matrix = np.stack([pts[1] - pts[0], pts[2] - pts[0], pts[3] - pts[0]])
        rhs = values[tet[1:]] - values[tet[0]]
        try:
            gradient = np.linalg.solve(matrix, rhs)
        except np.linalg.LinAlgError:
            continue
        volume = float(abs(np.dot(pts[0] - pts[3], np.cross(pts[1] - pts[3], pts[2] - pts[3]))) / 6.0)
        if volume < 1e-18:
            continue
        for node in tet:
            gradients[node] += gradient * volume
            weights[node] += volume
    safe = np.where(weights > 0, weights, 1.0)
    return gradients / safe[:, None]


def read_su2_elements(path: str | Path) -> np.ndarray:
    """Tet connectivity (SU2 node indices) read back from a .su2 mesh."""
    elements: list[list[int]] = []
    with open(path, encoding="utf-8") as handle:
        lines = handle.readlines()
    for index, raw in enumerate(lines):
        line = raw.strip()
        if line.startswith("NELEM="):
            count = int(line.split("=")[1])
            for offset in range(1, count + 1):
                parts = lines[index + offset].split()
                if parts and parts[0] == "10":  # SU2 linear tetrahedron
                    elements.append([int(p) for p in parts[1:5]])
            break
    if not elements:
        raise ResultParseError(f"no tetrahedral elements found in {path}")
    return np.asarray(elements, dtype=np.int64)


def element_gradients(
    nodes: np.ndarray,
    elements: np.ndarray,
    values: np.ndarray,
) -> np.ndarray:
    """Exact constant gradient per tetrahedron (the solution is linear on
    each element, so this is the plane through its four nodes)."""
    gradients = np.zeros((elements.shape[0], 3), dtype=np.float64)
    for index, tet in enumerate(elements):
        pts = nodes[tet]
        matrix = np.stack([pts[1] - pts[0], pts[2] - pts[0], pts[3] - pts[0]])
        rhs = values[tet[1:]] - values[tet[0]]
        try:
            gradients[index] = np.linalg.solve(matrix, rhs)
        except np.linalg.LinAlgError:
            continue
    return gradients


def boundary_heat_rates(
    nodes: np.ndarray,
    elements: np.ndarray,
    marker_triangles: dict[str, list[list[int]]],
    temperature: np.ndarray,
    conductivity: float,
    temperature_scale: float,
) -> dict[str, dict[str, float]]:
    """Reconstructed conductive heat rate per boundary surface (W).

    Each boundary face uses its owning tetrahedron's exact constant element
    gradient. This is still a *reconstruction* of the balance, not SU2's own
    conservative face fluxes, so the field names say so; the reported rate is
    the surface integral of -k (dT/dn) with n the outward normal (a surface
    being heated reads negative).
    """
    gradients = element_gradients(nodes, elements, temperature)

    rates: dict[str, dict[str, float]] = {}
    for marker, triangles in marker_triangles.items():
        normals, areas, owners = _outward_normals(triangles, nodes, elements)
        total = 0.0
        for index, tri in enumerate(triangles):
            owner = int(owners[index])
            gradient = gradients[owner] if owner >= 0 else np.zeros(3)
            total += (
                -conductivity
                * temperature_scale
                * float(np.dot(gradient, normals[index]))
                * areas[index]
            )
        rates[marker] = {
            "reconstructedHeatRateW": round(total, 9),
            "areaM2": round(float(areas.sum()), 9),
        }
    return rates


def fields_summary(fields: dict[str, np.ndarray]) -> dict[str, dict[str, float]]:
    summary: dict[str, dict[str, float]] = {}
    for name, values in fields.items():
        if values.ndim == 1 and len(values):
            finite = values[np.isfinite(values)]
            if not len(finite):
                continue
            summary[name] = {
                "min": round(float(finite.min()), 9),
                "max": round(float(finite.max()), 9),
                "mean": round(float(finite.mean()), 9),
            }
    return summary
