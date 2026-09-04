from __future__ import annotations

import hashlib
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


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _walk(
    node: bd.Shape,
    parent_world: bd.Location,
    parent: str | None,
    path: str,
    artifact_token: str,
) -> dict[str, Any]:
    local = node.location
    world = parent_world * local
    children = list(node.children)
    entry: dict[str, Any] = {
        "label": getattr(node, "label", "") or "",
        "path": path,
        "ref": f"occ-{artifact_token}-{path}",
        "parent": parent,
        "kind": "occurrence" if children else "leaf",
        "local": _location_dict(local),
        "world": _location_dict(world),
        "leafCount": len(node.solids()) if children else 1,
        "sourceFile": None,
        "children": [
            _walk(child, world, path, f"{path}.{index}" if path else str(index), artifact_token)
            for index, child in enumerate(children)
        ],
    }
    return entry


def assembly_tree_from_shape(shape: bd.Shape, artifact_hash: str) -> dict[str, Any]:
    """Build occurrence facts without importing the same artifact twice."""
    artifact_token = artifact_hash[:12]
    roots = list(shape.children)
    if not roots and len(shape.solids()) > 1:
        # Some STEP writers flatten an assembly into one compound with no
        # imported child tree. Its solids are still separate occurrences.
        roots = list(shape.solids())
    if roots:
        root = shape
        tree = _walk(root, bd.Location(), None, "root", artifact_token)
        # The importer gives the root compound no useful occurrence semantics.
        # Expose its children as top-level occurrences but keep the root for
        # deterministic traversal comparisons.
        tree["children"] = [
            _walk(child, root.location, "root", str(index), artifact_token)
            for index, child in enumerate(roots)
        ]
        tree["kind"] = "occurrence"
        tree["leafCount"] = sum(max(len(child.solids()), 1) for child in roots)
    else:
        tree = _walk(shape, bd.Location(), None, "root", artifact_token)

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
                    "ref": node["ref"],
                    "parent": parent_label,
                    "world": node["world"],
                    "solidIndex": len(leaves),
                }
            )
        for child in node.get("children", []):
            collect(child, node["label"] or parent_label)

    for child in tree.get("children") or [tree]:
        collect(child, None)

    grouped: dict[str, list[dict[str, Any]]] = {}
    for index, leaf in enumerate(leaves):
        label = str(leaf.get("label") or "").strip() or f"solid-{index + 1}"
        leaf["label"] = label
        grouped.setdefault(label, []).append(leaf)

    aliases: dict[str, str] = {}
    ambiguous: dict[str, list[str]] = {}
    authored = set(grouped)
    for label, matches in grouped.items():
        if len(matches) == 1:
            aliases[label] = matches[0]["ref"]
            matches[0]["alias"] = label
            continue
        numbered: list[str] = []
        next_index = 1
        for match in matches:
            while f"{label}_{next_index}" in authored or f"{label}_{next_index}" in aliases:
                next_index += 1
            alias = f"{label}_{next_index}"
            next_index += 1
            aliases[alias] = match["ref"]
            match["alias"] = alias
            numbered.append(alias)
        ambiguous[label] = numbered

    return {
        "units": "mm",
        "artifactHash": artifact_hash,
        "root": tree,
        "occurrences": leaves,
        "leafCount": len(leaves),
        "labels": sorted({leaf["label"] for leaf in leaves if leaf["label"]}),
        "aliases": aliases,
        "ambiguousLabels": ambiguous,
    }


def assembly_tree(artifact: str | Path) -> dict[str, Any]:
    artifact = Path(artifact)
    artifact_hash = _hash_file(artifact)
    return assembly_tree_from_shape(bd.import_step(artifact), artifact_hash)
