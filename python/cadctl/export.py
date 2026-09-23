from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import os
import shutil

import build123d as bd

from .model import run_source
from .common import sha256_file


def _copy_step_bundle(source: Path, output: Path, source_hash: str) -> tuple[str | None, str | None]:
    """Copy a STEP revision byte for byte and publish its matching identity sidecars."""
    sidecars = [
        (source.with_suffix(source.suffix + ".identity.json"), output.with_suffix(output.suffix + ".identity.json"), "identity"),
        (source.with_suffix(source.suffix + ".assembly.json"), output.with_suffix(output.suffix + ".assembly.json"), "legacy"),
    ]
    bundles = []
    for source_manifest, output_manifest, kind in sidecars:
        manifest_bytes = None
        if source_manifest.is_file():
            manifest = json.loads(source_manifest.read_text(encoding="utf-8"))
            declared = (manifest.get("artifact") or {}).get("sha256") if kind == "identity" else (manifest.get("artifactHash") or manifest.get("stepSha256"))
            if declared and declared != source_hash:
                raise ValueError("source identity manifest belongs to another STEP revision")
            manifest_bytes = source_manifest.read_bytes()
        bundles.append((output_manifest, manifest_bytes))
    token = f".{os.getpid()}.tmp"
    temp_step = output.with_name(output.name + token)
    temps = [(target, target.with_name(target.name + token), payload) for target, payload in bundles]
    try:
        shutil.copyfile(source, temp_step)
        if sha256_file(source) != source_hash or sha256_file(temp_step) != source_hash:
            raise ValueError("source STEP changed during export")
        for _, temp, payload in temps:
            if payload is not None:
                temp.write_bytes(payload)
        for target, _, _ in temps:
            target.unlink(missing_ok=True)
        os.replace(temp_step, output)
        hashes = []
        for target, temp, payload in temps:
            if payload is not None:
                os.replace(temp, target)
                hashes.append(sha256_file(target))
            else:
                hashes.append(None)
        return hashes[0], hashes[1]
    finally:
        temp_step.unlink(missing_ok=True)
        for _, temp, _ in temps:
            temp.unlink(missing_ok=True)


def _load_shape(source: str | Path, cwd: Path | None = None) -> tuple[bd.Shape, dict[str, Any]]:
    source = Path(source)
    suffix = source.suffix.lower()
    if suffix in {".step", ".stp"}:
        return bd.import_step(source), {"kind": "step", "exitCode": 0}
    if suffix == ".py":
        cwd = cwd or source.parent
        tmp_step = cwd / "build" / ".cadctl-export-input.step"
        result = run_source(source, tmp_step, cwd=cwd)
        if result.get("exitCode", 1) != 0:
            raise RuntimeError(result.get("error", "source execution failed"))
        return bd.import_step(tmp_step), {"kind": "source", "exitCode": 0}
    raise ValueError("source must be a .py build123d source or .step/.stp artifact")


def export_artifact(
    source: str | Path,
    output: str | Path,
    format: str,
    cwd: str | Path | None = None,
    expected_source_sha256: str | None = None,
) -> dict[str, Any]:
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    cwd_path = Path(cwd) if cwd else Path.cwd()
    source_path = Path(source)
    source_hash = sha256_file(source_path) if source_path.is_file() else None
    if expected_source_sha256 and source_hash != expected_source_sha256:
        raise ValueError(f"selected source revision changed: expected {expected_source_sha256}, found {source_hash or 'missing'}")
    copied_identity_manifest_hash = None
    copied_legacy_manifest_hash = None
    fmt = format.lower()
    if fmt in {"step", "stp"} and source_path.suffix.lower() in {".step", ".stp"}:
        if source_hash is None:
            raise FileNotFoundError(source_path)
        if source_path.resolve() != output.resolve():
            copied_identity_manifest_hash, copied_legacy_manifest_hash = _copy_step_bundle(source_path, output, source_hash)
        else:
            identity_manifest = output.with_suffix(output.suffix + ".identity.json")
            legacy_manifest = output.with_suffix(output.suffix + ".assembly.json")
            copied_identity_manifest_hash = sha256_file(identity_manifest) if identity_manifest.is_file() else None
            copied_legacy_manifest_hash = sha256_file(legacy_manifest) if legacy_manifest.is_file() else None
        source_info = {"kind": "step", "exitCode": 0, "byteCopy": True}
    elif fmt in {"step", "stp"}:
        shape, source_info = _load_shape(source, cwd_path)
        bd.export_step(shape, str(output))
    elif fmt == "stl":
        shape, source_info = _load_shape(source, cwd_path)
        bd.export_stl(shape, str(output))
    elif fmt in {"glb", "gltf"}:
        shape, source_info = _load_shape(source, cwd_path)
        bd.export_gltf(shape, str(output))
    elif fmt == "brep":
        shape, source_info = _load_shape(source, cwd_path)
        bd.export_brep(shape, str(output))
    else:
        raise ValueError(f"unsupported export format: {format}; V0 backend supports step, stl, glb, brep")
    if source_hash is not None and sha256_file(source_path) != source_hash:
        output.unlink(missing_ok=True)
        output.with_suffix(output.suffix + ".assembly.json").unlink(missing_ok=True)
        output.with_suffix(output.suffix + ".identity.json").unlink(missing_ok=True)
        raise ValueError("selected source changed during export; output was discarded")
    output_hash = sha256_file(output)
    return {
        "source": str(source),
        "sourceSha256": source_hash,
        "expectedSourceSha256": expected_source_sha256,
        "format": fmt,
        "output": str(output),
        "outputSha256": output_hash,
        "identityManifest": str(output.with_suffix(output.suffix + ".identity.json")) if copied_identity_manifest_hash else (str(output.with_suffix(output.suffix + ".assembly.json")) if copied_legacy_manifest_hash else None),
        "identityManifestSha256": copied_identity_manifest_hash,
        "legacyIdentityManifestSha256": copied_legacy_manifest_hash,
        "sourceKind": source_info["kind"],
        "manifest": {
            "source": str(source),
            "format": fmt,
            "output": str(output),
        },
    }
