"""Bind externally produced semantic declarations to an exported STEP.

The FreeCAD part backend cannot import build123d, so it writes a
``declarations.json`` next to its STEP. This module turns that file into the
same ``Assembly`` a build123d model would declare, then writes the normal
identity manifest. Every consumer (``cad_resolve``, ``cad_measure``, ...) then
works on FreeCAD models unchanged.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .declaration import Assembly, reset
from .manifest import write_manifest
from .protocol import IdentityError

_CALLS = {"part", "instance", "solid", "feature", "faces", "edges", "axis", "datum"}
_PASSTHROUGH = {
    "part": ("label", "display", "selector", "expect", "owner"),
    "instance": ("part", "label", "display", "selector", "expect"),
    "solid": ("owner", "label", "display", "selector", "expect"),
    "feature": ("kind", "owner", "label", "display", "selector", "expect"),
    "faces": ("selector", "owner", "label", "display", "expect"),
    "edges": ("selector", "owner", "label", "display", "expect"),
    "axis": ("origin", "direction", "owner", "label", "display"),
    "datum": ("origin", "zAxis", "xAxis", "yAxis", "owner", "label", "display"),
}


def load_declarations(path: str | Path) -> dict[str, Any]:
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("schema") != 1 or not isinstance(document.get("entities"), list):
        raise IdentityError("bad-declaration", "declarations file must be {schema: 1, entities: [...]}")
    return document


def assembly_from_declarations(document: dict[str, Any], artifact: str | Path) -> Assembly:
    reset()
    solids: list[Any] | None = None
    # `Assembly(name)` declares a grouping root at `name`. When the document
    # already declares an entity at that path (a one-part model whose instance
    # is the assembly), the entity is the root and no grouping node is added.
    declared = {entity.get("path") for entity in document["entities"]}
    root = document.get("assembly")
    assembly = Assembly(None if root in declared else root, label=document.get("label"))
    for entity in document["entities"]:
        call = entity.get("call")
        path = entity.get("path")
        if call not in _CALLS or not isinstance(path, str):
            raise IdentityError("bad-declaration", f"unsupported declaration {entity!r}", path=path)
        kwargs = {key: entity[key] for key in _PASSTHROUGH[call] if key in entity}
        if "solidIndex" in entity and call in {"part", "instance", "solid"}:
            if solids is None:
                import build123d as bd

                solids = list(bd.import_step(Path(artifact)).solids())
            index = int(entity["solidIndex"])
            if not 0 <= index < len(solids):
                raise IdentityError("bad-declaration", f"solidIndex {index} is outside the STEP's {len(solids)} solid(s)", path=path)
            kwargs["shape"] = solids[index]
            kwargs.pop("selector", None)
        getattr(assembly, call)(path, **kwargs)
    return assembly


def bind_identity(artifact: str | Path, declarations: str | Path) -> dict[str, Any]:
    """Write ``<artifact>.identity.json``; raise IdentityError naming failed paths."""
    document = load_declarations(declarations)
    try:
        assembly = assembly_from_declarations(document, artifact)
        destination, manifest = write_manifest(
            assembly, artifact, source_files=[str(Path(declarations).resolve())]
        )
    finally:
        reset()
    return {
        "identityManifest": str(destination),
        "assembly": document.get("assembly"),
        "entityCount": len(manifest.get("entities", [])),
    }
