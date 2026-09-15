from __future__ import annotations

"""Deterministically sew closed STEP surfaces; never invent missing material."""

from pathlib import Path

import build123d as bd
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.TopAbs import TopAbs_ShapeEnum
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

from .geometry import _shell_is_closed, _signed_volume


def solidify_closed_step(source: str | Path, output: str | Path) -> None:
    shape = bd.import_step(source)
    if shape.solids():
        raise ValueError("STEP already contains solids; solidify is only for surface-only files")
    faces = shape.faces()
    if not faces:
        raise ValueError("STEP contains no faces to sew")
    sewing = BRepBuilderAPI_Sewing()
    sewing.SetTolerance(1e-5)
    for face in faces:
        sewing.Add(face.wrapped)
    sewing.Perform()
    sewed = sewing.SewedShape()
    explorer = TopExp_Explorer(sewed, TopAbs_ShapeEnum.TopAbs_SHELL)
    solids = []
    while explorer.More():
        shell = TopoDS.Shell_s(explorer.Current())
        if not _shell_is_closed(shell):
            raise ValueError("STEP surfaces are open; no solid can be inferred without adding geometry")
        solid = BRepBuilderAPI_MakeSolid(shell).Solid()
        if not BRepCheck_Analyzer(solid, True).IsValid() or _signed_volume(solid) <= 0:
            raise ValueError("STEP surfaces do not form a valid positive-volume solid")
        solids.append(bd.Solid(solid))
        explorer.Next()
    if not solids:
        raise ValueError("STEP surfaces did not sew into a closed shell")
    result = solids[0] if len(solids) == 1 else bd.Compound(children=solids)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    bd.export_step(result, str(output))
