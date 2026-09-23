from __future__ import annotations

from pathlib import Path
from typing import Any
from contextlib import contextmanager
import fcntl
import json
import os
import shutil
import tempfile

import build123d as bd

from .model import run_source
from .common import sha256_file


def _copy_step_bundle(source: Path, output: Path, source_hash: str) -> tuple[str | None, str | None]:
    """Publish a STEP revision and its identity sidecars under one process lock.

    The sidecars cannot be replaced atomically with the STEP file as one
    filesystem operation. A stable advisory lock serializes all publishers;
    the old bundle is moved aside first and restored on any partial failure.
    """
    sidecars = [
        (source.with_suffix(source.suffix + ".identity.json"), output.with_suffix(output.suffix + ".identity.json"), "identity"),
        (source.with_suffix(source.suffix + ".assembly.json"), output.with_suffix(output.suffix + ".assembly.json"), "legacy"),
    ]
    with _destination_lock(output):
        bundles = []
        for source_manifest, output_manifest, kind in sidecars:
            payload = None
            if source_manifest.is_file():
                payload = source_manifest.read_bytes()
                _validate_sidecar(payload, kind, source_hash)
            bundles.append((output_manifest, kind, payload))

        temp_step = _temporary_path(output, "step")
        staged = [(target, kind, _temporary_path(target, kind), payload) for target, kind, payload in bundles if payload is not None]
        backups: dict[Path, Path] = {}
        try:
            shutil.copyfile(source, temp_step)
            shutil.copystat(source, temp_step)
            if sha256_file(source) != source_hash or sha256_file(temp_step) != source_hash:
                raise ValueError("source STEP changed during export")
            for _, _, temp, payload in staged:
                temp.write_bytes(payload)

            # Move manifests first, then STEP. A reader without the lock can
            # see an anonymous STEP briefly, but never a stale name on new bytes.
            for target in (sidecars[0][1], sidecars[1][1], output):
                if target.exists():
                    backup = _temporary_path(target, "backup")
                    os.replace(target, backup)
                    backups[target] = backup

            os.replace(temp_step, output)
            for target, _, temp, _ in staged:
                os.replace(temp, target)

            if sha256_file(source) != source_hash or sha256_file(output) != source_hash:
                raise ValueError("source or published STEP changed during export")
            hashes = []
            for target, kind, payload in bundles:
                if payload is None:
                    hashes.append(None)
                    continue
                published = target.read_bytes()
                if published != payload:
                    raise ValueError(f"published identity sidecar changed during export: {target}")
                _validate_sidecar(published, kind, source_hash)
                hashes.append(sha256_file(target))

            for backup in backups.values():
                backup.unlink(missing_ok=True)
            return hashes[0], hashes[1]
        except BaseException:
            # Fail closed if publication or rollback is interrupted. Restore
            # the previous matching bundle when possible; otherwise leave no
            # STEP/identity pair that could be mistaken for a valid revision.
            for target in (sidecars[0][1], sidecars[1][1], output):
                target.unlink(missing_ok=True)
            try:
                for target in (sidecars[0][1], sidecars[1][1], output):
                    backup = backups.get(target)
                    if backup is not None and backup.exists():
                        os.replace(backup, target)
            except BaseException as rollback_error:
                for target in (sidecars[0][1], sidecars[1][1], output):
                    target.unlink(missing_ok=True)
                raise RuntimeError(f"STEP bundle publication failed and rollback failed: {rollback_error}") from rollback_error
            raise
        finally:
            temp_step.unlink(missing_ok=True)
            for _, _, temp, _ in staged:
                temp.unlink(missing_ok=True)
            for backup in backups.values():
                backup.unlink(missing_ok=True)


@contextmanager
def _destination_lock(output: Path):
    lock_path = output.with_name(output.name + ".reify.lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _temporary_path(target: Path, purpose: str) -> Path:
    fd, name = tempfile.mkstemp(prefix=f".{target.name}.reify-{purpose}-", suffix=".tmp", dir=target.parent)
    os.close(fd)
    return Path(name)


def _validate_sidecar(payload: bytes, kind: str, source_hash: str) -> None:
    manifest = json.loads(payload.decode("utf-8"))
    declared = (manifest.get("artifact") or {}).get("sha256") if kind == "identity" else (manifest.get("artifactHash") or manifest.get("stepSha256"))
    if kind == "identity" and declared != source_hash:
        raise ValueError("source identity manifest belongs to another STEP revision")
    if declared and declared != source_hash:
        raise ValueError("source identity manifest belongs to another STEP revision")


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
    output = Path(os.path.abspath(output))
    output.parent.mkdir(parents=True, exist_ok=True)
    cwd_path = Path(cwd) if cwd else Path.cwd()
    source_path = Path(source)
    source_hash = sha256_file(source_path) if source_path.is_file() else None
    if expected_source_sha256 and source_hash != expected_source_sha256:
        raise ValueError(f"selected source revision changed: expected {expected_source_sha256}, found {source_hash or 'missing'}")
    fmt = format.lower()
    step_byte_copy = fmt in {"step", "stp"} and source_path.suffix.lower() in {".step", ".stp"}
    copied_identity_manifest_hash = None
    copied_legacy_manifest_hash = None
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
    if source_hash is not None and not step_byte_copy and sha256_file(source_path) != source_hash:
        output.unlink(missing_ok=True)
        output.with_suffix(output.suffix + ".assembly.json").unlink(missing_ok=True)
        output.with_suffix(output.suffix + ".identity.json").unlink(missing_ok=True)
        raise ValueError("selected source changed during export; output was discarded")
    # A later publisher may replace the same destination as soon as the lock
    # is released. For a byte-copy export, report the revision verified while
    # holding the publication lock rather than re-hashing a newer writer's file.
    output_hash = source_hash if step_byte_copy else sha256_file(output)
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
