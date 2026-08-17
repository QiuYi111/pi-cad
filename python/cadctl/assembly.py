from __future__ import annotations

from pathlib import Path
from typing import Any

import build123d as bd


def _location_dict(loc: bd.Location) -> dict[str, Any]:
    return {
        "position": [round(float(v), 6) for v in (loc.position.X, loc.position.Y, loc.position.Z)],
        "orientation": [round(float(v), 6) for v in (loc.orientation.X, loc.orientation.Y, loc.orientation.Z)],
        "xAxis": [round(float(v), 6) for v in (loc.x_axis.direction.X, loc.x_axis.direction.Y, loc.x_axis.direction.Z)],
        "yAxis": [round(float(v), 6) for v in (loc.y_axis.direction.X, loc.y_axis.direction.Y, loc.y_axis.direction.Z)],
        "zAxis": [round(float(v), 6) for v in (loc.z_axis.direction.X, loc.z_axis.direction.Y, loc.z_axis.direction.Z)],
    }


def _walk(node: bd.Shape, parent_world: bd.Location, parent: str | None, path: str) -> dict[str, Any]:
    local = node.location
    world = parent_world * local
    children = list(node.children)
    entry: dict[str, Any] = {
        "label": getattr(node, "label", "") or "",
        "path": path,
        "parent": parent,
        "kind": "occurrence" if children else "leaf",
        "local": _location_dict(local),
        "world": _location_dict(world),
        "leafCount": len(node.solids()) if children else 1,
        "sourceFile": None,
        "children": [_walk(child, world, path, f"{path}.{index}" if path else str(index)) for index, child in enumerate(children)],
    }
    return entry


def assembly_tree(artifact: str | Path) -> dict[str, Any]:
    artifact = Path(artifact)
    shape = bd.import_step(artifact)
    roots = list(shape.children)
    if roots:
        root = shape
        tree = _walk(root, bd.Location(), None, "root")
        # The importer gives the root compound no useful occurrence semantics.
        # Expose its children as top-level occurrences but keep the root for
        # deterministic traversal comparisons.
        tree["children"] = [
            _walk(child, root.location, "root", str(index)) for index, child in enumerate(roots)
        ]
    else:
        tree = _walk(shape, bd.Location(), None, "root")

    leaves: list[dict[str, Any]] = []
    if not tree.get("children"):
        tree["label"] = getattr(shape, "label", "") or "root"
        tree["kind"] = "leaf"
        tree["leafCount"] = max(len(shape.solids()), 1)

    def collect(node: dict[str, Any], parent_label: str | None) -> None:
        if node["kind"] == "leaf":
            leaves.append(
                {
                    "label": node["label"],
                    "path": node["path"],
                    "parent": parent_label,
                    "world": node["world"],
                }
            )
        for child in node.get("children", []):
            collect(child, node["label"] or parent_label)

    for child in tree.get("children") or [tree]:
        collect(child, None)

    return {
        "units": "mm",
        "root": tree,
        "occurrences": leaves,
        "leafCount": len(leaves),
        "labels": sorted({leaf["label"] for leaf in leaves if leaf["label"]}),
    }
