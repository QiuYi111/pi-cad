from __future__ import annotations

"""Deterministically sew closed STEP surfaces; never invent or drop material."""

from pathlib import Path
from typing import Any, Iterator

import build123d as bd
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_ShapeEnum
from OCP.TopoDS import TopoDS, TopoDS_Iterator

from .geometry import _shell_is_closed, _signed_volume

# Relative tolerance for the "every input face is covered" area check. Sewing may
# re-sew faces (splitting or re-merging) but it must never lose surface area.
AREA_TOLERANCE = 1e-6


def _children(shape: Any) -> Iterator[Any]:
    iterator = TopoDS_Iterator(shape)
    while iterator.More():
        yield iterator.Value()
        iterator.Next()


def _surface_area(shape: Any) -> float:
    properties = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, properties)
    return float(properties.Mass())


def _sew(faces: list[Any]) -> Any:
    sewing = BRepBuilderAPI_Sewing()
    sewing.SetTolerance(1e-5)
    for face in faces:
        sewing.Add(face.wrapped)
    sewing.Perform()
    return sewing.SewedShape()


def _shells(sewed: Any) -> list[Any]:
    """Collect sewn shells; anything no shell covers means the file is not closed."""
    shells: list[Any] = []
    pending = [sewed]
    while pending:
        shape = pending.pop()
        kind = shape.ShapeType()
        if kind == TopAbs_ShapeEnum.TopAbs_SHELL:
            shells.append(TopoDS.Shell_s(shape))
        elif kind == TopAbs_ShapeEnum.TopAbs_COMPOUND:
            pending.extend(_children(shape))
        else:
            raise ValueError(
                "STEP contains geometry that no closed shell covers; import it as a reference instead"
            )
    return shells


def solidify_closed_step(source: str | Path, output: str | Path) -> None:
    shape = bd.import_step(source)
    if shape.solids():
        raise ValueError("STEP already contains solids; solidify is only for surface-only files")
    faces = shape.faces()
    if not faces:
        raise ValueError("STEP contains no faces to sew")
    sewed = _sew(faces)
    shells = _shells(sewed)
    solids = []
    covered_area = 0.0
    for shell in shells:
        if not _shell_is_closed(shell):
            raise ValueError("STEP surfaces are open; no solid can be inferred without adding geometry")
        solid = BRepBuilderAPI_MakeSolid(shell).Solid()
        if not BRepCheck_Analyzer(solid, True).IsValid() or _signed_volume(solid) <= 0:
            raise ValueError("STEP surfaces do not form a valid positive-volume solid")
        solids.append(bd.Solid(solid))
        covered_area += _surface_area(shell)
    if not solids:
        raise ValueError("STEP surfaces did not sew into a closed shell")
    input_area = _surface_area(shape.wrapped)
    if abs(covered_area - input_area) > AREA_TOLERANCE * max(input_area, 1.0):
        raise ValueError(
            "STEP contains surfaces that no closed shell covers; import it as a reference instead"
        )
    result = solids[0] if len(solids) == 1 else bd.Compound(children=solids)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    bd.export_step(result, str(output))
