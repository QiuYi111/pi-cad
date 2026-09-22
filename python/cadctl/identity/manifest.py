"""Build the identity manifest for one artifact, and read it back.

The manifest is written next to the STEP file as ``<name>.step.identity.json``.
It records three things that must agree for an identity to be usable:

1. the exact artifact bytes (``artifact.sha256``);
2. the build inputs that produced them (source closure hash, parameter hash);
3. the author's semantic paths and the final geometry each one binds to.

Agreement is checked at read time.  A manifest whose artifact hash no longer
matches the file on disk is rejected, so an old manifest can never masquerade
as the new model.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .. import __version__ as CADCTL_VERSION
from ..common import canonical_json_bytes, sha256_file
from .artifact import ArtifactModel
from .protocol import (
    GEOMETRIC_KINDS,
    IDENTITY_SUFFIX,
    LEGACY_SUFFIX,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    IdentityError,
    is_descendant,
)
from .selectors import evaluate


def identity_path(step_path: str | Path) -> Path:
    step = Path(step_path)
    return step.with_name(step.name + IDENTITY_SUFFIX)


def legacy_path(step_path: str | Path) -> Path:
    step = Path(step_path)
    return step.with_name(step.name + LEGACY_SUFFIX)


def load_manifest(step_path: str | Path) -> dict[str, Any] | None:
    path = identity_path(step_path)
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise IdentityError(
            "bad-manifest",
            f"identity manifest {path} is not readable JSON: {error}",
            path=str(path),
        ) from error
    if not isinstance(value, dict) or value.get("protocol") != PROTOCOL_NAME:
        raise IdentityError(
            "bad-manifest",
            f"{path} is not a {PROTOCOL_NAME} manifest",
            path=str(path),
        )
    if value.get("version") != PROTOCOL_VERSION:
        raise IdentityError(
            "unsupported-version",
            f"{path} speaks identity protocol version {value.get('version')}; "
            f"this build speaks {PROTOCOL_VERSION}",
            path=str(path),
        )
    return value


def prune_stale_manifest(artifact: str | Path) -> bool:
    """Delete an identity manifest that no longer describes ``artifact``.

    A build that writes a new STEP without declaring names must not leave the
    previous build's manifest in place: it would advertise names that no longer
    bind to anything in this model.
    """
    destination = identity_path(artifact)
    if not destination.is_file():
        return False
    try:
        value = json.loads(destination.read_text(encoding="utf-8"))
        declared = str(value.get("artifact", {}).get("sha256", ""))
    except (OSError, ValueError):
        declared = ""
    if declared and declared == sha256_file(artifact):
        return False
    destination.unlink()
    return True


def _runtime_identity() -> dict[str, str]:
    import importlib.metadata
    import platform

    try:
        build123d_version = importlib.metadata.version("build123d")
    except importlib.metadata.PackageNotFoundError:  # pragma: no cover - CI always has it
        build123d_version = "unknown"
    return {
        "cadctl": CADCTL_VERSION,
        "python": platform.python_version(),
        "build123d": build123d_version,
    }


def _source_entries(paths: list[str]) -> tuple[list[dict[str, str]], str]:
    entries: list[dict[str, str]] = []
    for raw in sorted({str(Path(path).resolve()) for path in paths}):
        path = Path(raw)
        if not path.is_file():
            continue
        entries.append({"path": raw, "sha256": sha256_file(path)})
    digest = hashlib.sha256()
    for entry in entries:
        digest.update(entry["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(entry["sha256"].encode("ascii"))
        digest.update(b"\0")
    return entries, digest.hexdigest()


def _topological(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Order declarations so an owner is always resolved before its dependents."""
    by_path = {entity["path"]: entity for entity in entities}
    ordered: list[dict[str, Any]] = []
    state: dict[str, int] = {}

    def visit(entity: dict[str, Any], trail: list[str]) -> None:
        path = entity["path"]
        if state.get(path) == 2:
            return
        if state.get(path) == 1:
            raise IdentityError(
                "cyclic-owner",
                "owner chain is cyclic: " + " -> ".join(trail + [path]),
            )
        state[path] = 1
        owner = entity.get("owner")
        if owner:
            parent = by_path.get(owner)
            if parent is None:
                raise IdentityError(
                    "unknown-owner",
                    f"'{path}' is owned by '{owner}', which this protocol does not declare",
                    path=path,
                    owner=owner,
                )
            visit(parent, trail + [path])
        state[path] = 2
        ordered.append(entity)

    for entity in entities:
        visit(entity, [])
    return ordered


def _check_cardinality(record: dict[str, Any], matches: list[dict[str, Any]]) -> None:
    expect = record["expect"]
    low = int(expect["min"])
    high = expect["max"]
    found = len(matches)
    if found < low or (high is not None and found > high):
        wants = "exactly" if high == low else "at least" if high is None else "between"
        detail = (
            f"{record['kind']} '{record['path']}' expected "
            f"{wants} {expect['label']} geometry match(es) but found {found}"
        )
        if found == 0:
            detail += "; the selector matched nothing, so the object was deleted or moved"
        else:
            detail += (
                "; the selector is ambiguous, so narrow it with type, centroid, or radius "
                "instead of accepting the first match"
            )
        raise IdentityError(
            "cardinality",
            detail,
            path=record["path"],
            kind=record["kind"],
            expected=expect,
            found=found,
        )


def _resolve_geometric(
    model: ArtifactModel,
    record: dict[str, Any],
    owner_solids: list[int] | None,
) -> list[dict[str, Any]]:
    selector = record.get("selector")
    if selector is None:
        return []
    if owner_solids is not None and not owner_solids:
        raise IdentityError(
            "unknown-owner",
            f"'{record['path']}' is owned by '{record['owner']}', which binds no geometry",
            path=record["path"],
            owner=record["owner"],
        )
    matches = evaluate(model, selector, owner_solids)
    _check_cardinality(record, matches)
    bindings: list[dict[str, Any]] = []
    for match in matches:
        binding = {
            "target": match["kind"],
            "ref": match["ref"],
            "solidIndex": match["solidIndex"],
        }
        facts = match["facts"]
        if match["kind"] == "solid":
            binding["facts"] = {
                "center": list(facts["center"]),
                "bounds": facts["bounds"],
                "volume": facts["volume"],
            }
        elif match["kind"] == "face":
            binding["facts"] = {
                "type": facts["type"],
                "area": facts["area"],
                "centroid": facts["centroid"],
                "bbox": facts["bbox"],
            }
        else:
            binding["facts"] = {
                "type": facts["type"],
                "length": facts["length"],
                "centroid": facts["centroid"],
            }
        bindings.append(binding)
    return bindings


def _binding_solids(bindings: list[dict[str, Any]]) -> list[int]:
    indices: list[int] = []
    for binding in bindings:
        index = binding.get("solidIndex")
        if isinstance(index, int) and index not in indices:
            indices.append(index)
    return sorted(indices)


def build_manifest(
    assembly: Any,
    artifact: str | Path,
    *,
    source_files: list[str] | None = None,
    parameters: dict[str, Any] | None = None,
    artifact_model: ArtifactModel | None = None,
) -> dict[str, Any]:
    """Bind every declared path to final geometry and return the manifest."""
    model = artifact_model or ArtifactModel(artifact)
    ordered = _topological(assembly.entities)
    resolved: dict[str, dict[str, Any]] = {}
    refs: dict[str, str] = {}
    entities: list[dict[str, Any]] = []

    for record in ordered:
        entry = {
            "path": record["path"],
            "kind": record["kind"],
            "owner": record["owner"],
            "label": record["label"],
            "display": record["display"],
            "coordinate": record["coordinate"],
        }
        if record.get("featureKind"):
            entry["featureKind"] = record["featureKind"]
            entry["target"] = record.get("target")
        if record["kind"] == "assembly":
            # The root of the declaration is a grouping node by definition.
            entry["bindings"] = []
            entry["solidIndices"] = []
            entry["container"] = True
        elif record["kind"] in ("axis", "datum"):
            entry.update(_resolve_frame(model, record, resolved))
        elif record["kind"] in GEOMETRIC_KINDS:
            if record.get("selector") is None:
                # No rule to find geometry: a grouping node. It owns whatever
                # its descendants bind, filled in after every child resolves.
                entry["bindings"] = []
                entry["solidIndices"] = []
                entry["container"] = True
            else:
                owner_solids: list[int] | None = None
                if record["owner"] is not None:
                    owner_entry = resolved[record["owner"]]
                    owner_solids = _binding_solids(owner_entry.get("bindings", []))
                    if owner_entry.get("container"):
                        owner_solids = None
                bindings = _resolve_geometric(model, record, owner_solids)
                entry["bindings"] = bindings
                entry["solidIndices"] = _binding_solids(bindings)
                for binding in bindings:
                    refs.setdefault(binding["ref"], record["path"])
        resolved[record["path"]] = entry
        entities.append(entry)

    for entry in entities:
        if not entry.get("container"):
            continue
        collected: list[dict[str, Any]] = []
        seen: set[str] = set()
        for other in entities:
            if other is entry or not other.get("owner"):
                continue
            if not is_descendant(entry["path"], other["path"]):
                continue
            for binding in other.get("bindings", []):
                if binding["ref"] in seen:
                    continue
                seen.add(binding["ref"])
                collected.append(binding)
        entry["bindings"] = collected
        entry["solidIndices"] = _binding_solids(collected)
        for binding in collected:
            refs.setdefault(binding["ref"], entry["path"])

    sources, closure = _source_entries(source_files or [])
    parameters = parameters or {}
    return {
        "protocol": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "artifact": {
            "path": str(model.path),
            "sha256": model.artifact_hash,
            "units": "mm",
        },
        "build": {
            "runtime": _runtime_identity(),
            "sourceFiles": sources,
            "sourceClosureHash": closure,
            "parameters": parameters,
            "parametersHash": hashlib.sha256(canonical_json_bytes(parameters)).hexdigest(),
        },
        "entities": entities,
        "refs": refs,
        "counts": _counts(entities),
    }


def _resolve_frame(
    model: ArtifactModel,
    record: dict[str, Any],
    resolved: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Local and world placement of a declared axis or datum."""
    owner = record["owner"]
    if owner is not None:
        owner_entry = resolved[owner]
        world_location = model.occurrence_world_location(_owner_occurrence(model, owner_entry))
    else:
        world_location = model.occurrence_world_location(None)
    origin = record["origin"]
    if record["coordinate"] == "local" and owner is not None:
        world_origin = _transform_point(world_location, origin)
    else:
        world_origin = list(origin)
    payload: dict[str, Any] = {
        "local": {"origin": list(origin), "direction": record.get("direction"), "axes": record.get("axes")},
        "coordinate": record["coordinate"],
    }
    if record["kind"] == "axis":
        direction = record["direction"]
        world_direction = (
            _transform_direction(world_location, direction)
            if record["coordinate"] == "local" and owner is not None
            else list(direction)
        )
        payload["world"] = {"origin": world_origin, "direction": world_direction}
    else:
        axes = record.get("axes") or {}
        world_axes = {
            key: (_transform_direction(world_location, value) if record["coordinate"] == "local" and owner is not None else list(value))
            for key, value in axes.items()
        }
        payload["world"] = {"origin": world_origin, "axes": world_axes}
    return payload


def _owner_occurrence(model: ArtifactModel, owner_entry: dict[str, Any]) -> str | None:
    for binding in owner_entry.get("bindings", []):
        ref = binding.get("ref")
        if isinstance(ref, str) and ref.startswith("occ-"):
            return ref
    indices = owner_entry.get("solidIndices") or []
    if indices:
        ref = model.occurrence_by_solid(indices[0])
        if ref:
            return ref
    return None


def _transform_point(location: dict[str, Any], point: list[float]) -> list[float]:
    from OCP.gp import gp_XYZ

    trsf = _location_from_dict(location)
    xyz = gp_XYZ(float(point[0]), float(point[1]), float(point[2]))
    trsf.Transforms(xyz)
    return [round(xyz.X(), 9), round(xyz.Y(), 9), round(xyz.Z(), 9)]


def _transform_direction(location: dict[str, Any], direction: list[float]) -> list[float]:
    trsf = _location_from_dict(location)
    matrix = trsf.VectorialPart()
    values = [
        matrix.Value(1, 1) * float(direction[0]) + matrix.Value(1, 2) * float(direction[1]) + matrix.Value(1, 3) * float(direction[2]),
        matrix.Value(2, 1) * float(direction[0]) + matrix.Value(2, 2) * float(direction[1]) + matrix.Value(2, 3) * float(direction[2]),
        matrix.Value(3, 1) * float(direction[0]) + matrix.Value(3, 2) * float(direction[1]) + matrix.Value(3, 3) * float(direction[2]),
    ]
    return [round(value, 9) for value in values]


def _location_from_dict(location: dict[str, Any]) -> Any:
    """Rebuild the rigid transform that :func:`cadctl.assembly._location_dict` described.

    Rotation columns are the location's own x/y/z axes and the translation is
    its position, which is exactly how the occurrence was placed.  Building the
    transform explicitly avoids relying on ``gp_Trsf.SetTransformation``'s
    from/to-system convention.
    """
    from OCP.gp import gp_Trsf

    x_axis = [float(value) for value in location["xAxis"]]
    y_axis = [float(value) for value in location["yAxis"]]
    z_axis = [float(value) for value in location["zAxis"]]
    position = [float(value) for value in location["position"]]
    trsf = gp_Trsf()
    trsf.SetValues(
        x_axis[0], y_axis[0], z_axis[0], position[0],
        x_axis[1], y_axis[1], z_axis[1], position[1],
        x_axis[2], y_axis[2], z_axis[2], position[2],
    )
    return trsf


def _counts(entities: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entity in entities:
        counts[entity["kind"]] = counts.get(entity["kind"], 0) + 1
    return counts


def write_manifest(
    assembly: Any,
    artifact: str | Path,
    *,
    source_files: list[str] | None = None,
    parameters: dict[str, Any] | None = None,
) -> tuple[Path, dict[str, Any]]:
    manifest = build_manifest(
        assembly,
        artifact,
        source_files=source_files,
        parameters=parameters,
    )
    destination = identity_path(artifact)
    fd, raw = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    temp = Path(raw)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)
    # A legacy manifest has no artifact binding, so keeping it next to the new
    # STEP would let an unbound name set masquerade as this model's identities.
    stale = legacy_path(artifact)
    if stale.is_file():
        stale.unlink()
    return destination, manifest
