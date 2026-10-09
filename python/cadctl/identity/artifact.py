"""Canonical, version-bound view of one STEP artifact.

Every consumer that needs to point at real geometry goes through this module
instead of re-walking the STEP tree, so ``occ-*`` occurrence refs, ``surf-*``
face refs, and solid ordinal positions all agree with the existing probe and
mesh surfaces.

The three reference families kept here are:

``occ-<hash12>-<traversal path>``
    Same spelling and same traversal as :func:`cadctl.assembly.assembly_tree`.
``surf-<hash10>``
    Same derivation as :func:`cadctl.simulation.surface_selector.enumerate_surfaces`.
``solidIndex``
    Ordinal position inside ``shape.solids()``: an internal mapping bound to
    the artifact hash, never an outward-stable identity.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import build123d as bd
from OCP.gp import gp_XYZ

from ..assembly import _location_dict, assembly_tree_from_shape
from .protocol import IdentityError


def _hash_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _location_point(location: bd.Location, point: tuple[float, float, float]) -> tuple[float, float, float]:
    """Apply ``location`` to a point expressed in its parent frame."""
    xyz = gp_XYZ(float(point[0]), float(point[1]), float(point[2]))
    location.wrapped.Transformation().Transforms(xyz)
    return (xyz.X(), xyz.Y(), xyz.Z())


def _bbox_center(shape: Any) -> tuple[float, float, float]:
    box = shape.bounding_box()
    return (
        (float(box.min.X) + float(box.max.X)) / 2.0,
        (float(box.min.Y) + float(box.max.Y)) / 2.0,
        (float(box.min.Z) + float(box.max.Z)) / 2.0,
    )


def _bbox(shape: Any) -> list[list[float]]:
    box = shape.bounding_box()
    return [
        [round(float(box.min.X), 6), round(float(box.min.Y), 6), round(float(box.min.Z), 6)],
        [round(float(box.max.X), 6), round(float(box.max.Y), 6), round(float(box.max.Z), 6)],
    ]


def _same_placement(left: Any, right: Any) -> bool:
    """Compare STEP instance placements without using shape proximity."""
    a = left.wrapped.Location().Transformation()
    b = right.wrapped.Location().Transformation()
    return all(
        abs(a.Value(row, column) - b.Value(row, column)) <= 1e-9
        for row in range(1, 4)
        for column in range(1, 5)
    )


def _world_bounds(
    parent_world: bd.Location, bounds: list[list[float]]
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Axis-aligned world box of ``bounds`` after ``parent_world``."""
    low, high = bounds[0], bounds[1]
    corners = [
        _location_point(parent_world, (x, y, z))
        for x in (low[0], high[0])
        for y in (low[1], high[1])
        for z in (low[2], high[2])
    ]
    return (
        tuple(min(corner[axis] for corner in corners) for axis in range(3)),
        tuple(max(corner[axis] for corner in corners) for axis in range(3)),
    )


class ArtifactModel:
    """Occurrence tree, solids, and faces of one exact STEP byte string."""

    def __init__(self, artifact: str | Path, *, shape: bd.Shape | None = None) -> None:
        self.path = Path(artifact).resolve()
        if not self.path.is_file():
            raise IdentityError("missing-artifact", f"artifact does not exist: {self.path}")
        self.artifact_hash = _hash_file(self.path)
        self.token = self.artifact_hash[:12]
        self.shape = shape if shape is not None else bd.import_step(str(self.path))
        self.face_shapes: dict[str, Any] = {}
        self.report = assembly_tree_from_shape(self.shape, self.artifact_hash)
        self.occurrences = self._walk_occurrences()
        self.solids = self._collect_solids()
        self.faces = self._collect_faces()
        self._link_occurrences_to_solids()

    # -- occurrence tree -------------------------------------------------

    def _walk_occurrences(self) -> list[dict[str, Any]]:
        shape = self.shape
        roots = list(shape.children)
        if not roots and len(shape.solids()) > 1:
            # Mirror assembly.py: a flattened STEP still has separate solids.
            roots = list(shape.solids())
        entries: list[dict[str, Any]] = []

        def visit(node: Any, parent_world: bd.Location, parent_path: str | None, path: str) -> None:
            children = list(node.children)
            world = parent_world * node.location
            center = _location_point(parent_world, _bbox_center(node))
            low, high = _world_bounds(parent_world, _bbox(node))
            entry = {
                "path": path,
                "ref": f"occ-{self.token}-{path}",
                "label": getattr(node, "label", "") or "",
                "kind": "occurrence" if children else "leaf",
                "parent": parent_path,
                "world": (round(center[0], 6), round(center[1], 6), round(center[2], 6)),
                "worldLocation": _location_dict(world),
                "bounds": [
                    [round(value, 6) for value in low],
                    [round(value, 6) for value in high],
                ],
                "solidCount": len(node.solids()),
                "solidIndices": [],
            }
            entries.append(entry)
            for index, child in enumerate(children):
                visit(child, world, path, f"{path}.{index}" if path else str(index))

        if roots:
            for index, child in enumerate(roots):
                visit(child, shape.location, "root", str(index))
        else:
            visit(shape, bd.Location(), None, "root")
        return entries

    # -- solids and faces ------------------------------------------------

    def _collect_solids(self) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for index, solid in enumerate(self.shape.solids()):
            records.append(
                {
                    "index": index,
                    "ref": f"solid-{self.token}-{index}",
                    "center": tuple(round(value, 6) for value in _bbox_center(solid)),
                    "bounds": _bbox(solid),
                    "volume": round(float(solid.volume), 9),
                    "occurrenceRefs": [],
                    "faceIds": [],
                }
            )
        return records

    def _collect_faces(self) -> list[dict[str, Any]]:
        # Reuse the probe's fact extraction and hash-bound face ID so a
        # ``surf-*`` an agent saw in cad_inspect_surfaces resolves here too.
        from ..simulation.surface_selector import _face_facts, surface_id

        solids = list(self.shape.solids())
        groups = [(f"solid-{index}", index, list(solid.faces())) for index, solid in enumerate(solids)]
        if not groups:
            groups = [("shape", None, list(self.shape.faces()))]
        records: list[dict[str, Any]] = []
        seen: dict[str, int] = {}
        for scope, solid_index, faces in groups:
            for face in faces:
                facts = _face_facts(face)
                sid = surface_id(self.artifact_hash, facts["area"], facts["bbox"], scope=scope)
                if sid in seen:
                    raise IdentityError(
                        "ambiguous-geometry",
                        f"two faces share the identifier {sid}; geometry is ambiguous",
                    )
                seen[sid] = len(records)
                facts["id"] = sid
                facts["solidIndex"] = solid_index
                facts["area"] = round(float(facts["area"]), 9)
                facts["centroid"] = [round(float(value), 9) for value in facts["centroid"]]
                records.append(facts)
                self.face_shapes[sid] = face
        return records

    def _link_occurrences_to_solids(self) -> None:
        exported_solids = list(self.shape.solids())
        for entry in self.occurrences:
            if entry["kind"] != "leaf":
                continue
            node = self._occurrence_shape(entry["path"])
            matches: list[int] = []
            for node_solid in node.solids():
                candidates = [
                    record["index"]
                    for record, exported in zip(self.solids, exported_solids)
                    if exported.wrapped.IsPartner(node_solid.wrapped)
                    and _same_placement(exported, node_solid)
                ]
                if len(candidates) != 1:
                    raise IdentityError(
                        "ambiguous-occurrence-solid",
                        f"STEP occurrence '{entry['ref']}' maps one of its solids to "
                        f"{len(candidates)} exported solids by topology and placement; "
                        "the occurrence-to-solid relationship is not unique",
                        occurrence=entry["ref"],
                        candidates=candidates,
                    )
                matches.append(candidates[0])
            if len(matches) != entry["solidCount"]:
                raise IdentityError(
                    "incomplete-occurrence-solid-map",
                    f"STEP occurrence '{entry['ref']}' declares {entry['solidCount']} "
                    f"solid(s), but its topology maps to {len(matches)} exported solids",
                    occurrence=entry["ref"],
                    expected=entry["solidCount"],
                    found=len(matches),
                )
            entry["solidIndices"] = matches
            for index in matches:
                self.solids[index]["occurrenceRefs"].append(entry["ref"])
        for solid in self.solids:
            if len(solid["occurrenceRefs"]) != 1:
                raise IdentityError(
                    "ambiguous-solid-occurrence",
                    f"exported solid '{solid['ref']}' belongs to "
                    f"{len(solid['occurrenceRefs'])} STEP leaf occurrence(s); "
                    "cannot prove a unique owner",
                    solid=solid["ref"],
                    occurrences=solid["occurrenceRefs"],
                )
        # Roll descendant solids up so an occurrence node owns its whole body.
        by_parent: dict[str, list[dict[str, Any]]] = {}
        for entry in self.occurrences:
            if entry["parent"] is not None:
                by_parent.setdefault(entry["parent"], []).append(entry)
        for entry in reversed(self.occurrences):
            if entry["kind"] != "occurrence":
                continue
            collected: list[int] = []
            for child in by_parent.get(entry["path"], []):
                for index in child["solidIndices"]:
                    if index not in collected:
                        collected.append(index)
            entry["solidIndices"] = sorted(collected)
        for face in self.faces:
            if face["solidIndex"] is not None:
                self.solids[face["solidIndex"]]["faceIds"].append(face["id"])

    def _occurrence_shape(self, path: str) -> Any:
        node = self.shape
        for component in path.split("."):
            if component == "root":
                continue
            children = list(node.children)
            if not children and node is self.shape and len(node.solids()) > 1:
                children = list(node.solids())
            index = int(component)
            if index < 0 or index >= len(children):
                raise IdentityError(
                    "missing-occurrence",
                    f"STEP occurrence path '{path}' no longer exists in the imported tree",
                    path=path,
                )
            node = children[index]
        return node

    # -- lookups ---------------------------------------------------------

    def occurrence(self, ref: str) -> dict[str, Any] | None:
        for entry in self.occurrences:
            if entry["ref"] == ref:
                return entry
        return None

    def occurrence_by_solid(self, index: int) -> str | None:
        record = self.solids[index] if 0 <= index < len(self.solids) else None
        refs = record["occurrenceRefs"] if record else []
        if len(refs) > 1:
            raise IdentityError(
                "ambiguous-solid-occurrence",
                f"solid index {index} maps to multiple STEP occurrences",
                solidIndex=index,
                occurrences=refs,
            )
        return refs[0] if refs else None

    def face(self, face_id: str) -> dict[str, Any] | None:
        for record in self.faces:
            if record["id"] == face_id:
                return record
        return None

    def shape_for_binding(self, binding: dict[str, Any]) -> Any:
        """Map one already resolved identity binding onto this imported B-Rep."""
        target = binding.get("target")
        ref = binding.get("ref")
        solid_index = binding.get("solidIndex")
        solids = list(self.shape.solids())
        if target == "solid":
            if not isinstance(solid_index, int) or not 0 <= solid_index < len(solids):
                # Current solid refs carry the index, while semantic bindings
                # always pin it in the manifest.
                try:
                    solid_index = int(str(ref).rsplit("-", 1)[1])
                except (ValueError, IndexError):
                    raise IdentityError("bad-binding", f"solid binding {ref!r} has no valid solid index")
            if not 0 <= solid_index < len(solids):
                raise IdentityError("bad-binding", f"solid binding {ref!r} is out of range")
            return solids[solid_index]
        if target == "face":
            face = self.face_shapes.get(str(ref))
            if face is None:
                raise IdentityError("bad-binding", f"face binding {ref!r} is absent from this artifact")
            return face
        if target == "edge":
            for index, solid in enumerate(solids):
                for ordinal, edge in enumerate(solid.edges()):
                    if ref == f"edge-{self.token}-{index}-{ordinal}":
                        return edge
            raise IdentityError("bad-binding", f"edge binding {ref!r} is absent from this artifact")
        if target == "instance":
            entry = self.occurrence(str(ref))
            if entry is None:
                raise IdentityError("bad-binding", f"instance binding {ref!r} is absent from this artifact")
            indices = entry["solidIndices"]
            if not indices:
                raise IdentityError("bad-binding", f"instance binding {ref!r} owns no solids")
            return solids[indices[0]] if len(indices) == 1 else bd.Compound(children=[solids[index] for index in indices])
        raise IdentityError("bad-binding", f"binding {ref!r} has unsupported geometry target {target!r}")

    def faces_of(self, solid_indices: list[int]) -> list[dict[str, Any]]:
        wanted = set(solid_indices)
        return [record for record in self.faces if record["solidIndex"] in wanted]

    def edges_of(self, solid_indices: list[int] | None) -> list[dict[str, Any]]:
        all_solids = list(self.shape.solids())
        if solid_indices is None:
            wanted = set(range(len(all_solids)))
        else:
            wanted = set(solid_indices)
        records: list[dict[str, Any]] = []
        for index in sorted(wanted):
            if index < 0 or index >= len(all_solids):
                continue
            for ordinal, edge in enumerate(all_solids[index].edges()):
                box = edge.bounding_box()
                records.append(
                    {
                        "id": f"edge-{self.token}-{index}-{ordinal}",
                        "solidIndex": index,
                        "ordinal": ordinal,
                        "type": str(edge.geom_type.name).lower(),
                        "length": round(float(edge.length), 9),
                        "centroid": [
                            round((float(box.min.X) + float(box.max.X)) / 2.0, 9),
                            round((float(box.min.Y) + float(box.max.Y)) / 2.0, 9),
                            round((float(box.min.Z) + float(box.max.Z)) / 2.0, 9),
                        ],
                        "radius": round(float(edge.radius), 9) if hasattr(edge, "radius") else None,
                    }
                )
        return records

    def occurrence_world_location(self, ref: str | None) -> dict[str, Any]:
        """World placement of one occurrence, or the artifact frame for ``None``."""
        if ref is None:
            return _location_dict(bd.Location())
        entry = self.occurrence(ref)
        if entry is None:
            raise IdentityError("unknown-owner", f"no occurrence {ref} in this artifact", ref=ref)
        return entry["worldLocation"]
