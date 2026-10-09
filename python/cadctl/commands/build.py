"""``cadctl build`` and ``cadctl export``: STEP production and export."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from ..common import emit, sha256_file
from .envelope import elapsed_ms, fail, hash_or_empty


def cmd_build(args: argparse.Namespace) -> int:
    from ..build_cache import (
        canonical_parameters_hash,
        current_manifest,
        exclusive_build,
        make_manifest,
        write_manifest,
    )
    from ..model import run_source

    started = time.monotonic()
    source = Path(args.source)
    output = Path(args.output)
    try:
        parameters = json.loads(args.parameters_json) if args.parameters_json else None
        if parameters is not None and not isinstance(parameters, dict):
            raise TypeError("--parameters-json must contain an object")
        input_hashes = {"source": sha256_file(source)}
        parameters_hash = canonical_parameters_hash({"solidify": True} if args.solidify else parameters)
        if parameters is not None:
            input_hashes["parameters"] = parameters_hash
        with exclusive_build(Path.cwd(), output):
            cached = None if args.force else current_manifest(
                Path.cwd(), output, parameters_hash=parameters_hash
            )
            if cached is not None:
                input_hashes["sourceClosure"] = cached["sourceClosureHash"]
                input_artifacts = [
                    {"path": item["path"], "role": f"source:{index}", "sha256": sha256_file(item["path"])}
                    for index, item in enumerate(cached["dependencies"])
                ]
                emit(
                    "cad_build_step",
                    {
                        "step": str(output),
                        "sidecars": [],
                        "exitCode": 0,
                        "stdout": "",
                        "stderr": "",
                        "cache": "hit",
                        "sourceFiles": [item["path"] for item in cached["dependencies"]],
                    },
                    input_hashes=input_hashes,
                    input_artifacts=input_artifacts,
                    artifacts=[{"path": str(output), "kind": "step", "sha256": cached["outputHash"]}],
                    duration_ms=elapsed_ms(started),
                )
                return 0

            if source.suffix.lower() in {".step", ".stp"}:
                if parameters is not None:
                    raise ValueError("STEP import does not accept model parameters")
                if source.resolve() == output.resolve():
                    raise ValueError("STEP import output must differ from its source")
                output.parent.mkdir(parents=True, exist_ok=True)
                if args.solidify:
                    from ..step_repair import solidify_closed_step

                    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".step", delete=False) as temporary:
                        temporary_path = Path(temporary.name)
                    try:
                        solidify_closed_step(source, temporary_path)
                        os.replace(temporary_path, output)
                    finally:
                        temporary_path.unlink(missing_ok=True)
                else:
                    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".step", delete=False) as temporary:
                        temporary_path = Path(temporary.name)
                        try:
                            with source.open("rb") as original:
                                shutil.copyfileobj(original, temporary)
                        except BaseException:
                            temporary_path.unlink(missing_ok=True)
                            raise
                    os.replace(temporary_path, output)
                result = {"exitCode": 0, "sourceFiles": [str(source.resolve())], "stdout": "", "stderr": ""}
            else:
                if args.solidify:
                    raise ValueError("--solidify requires a .step or .stp source")
                result = run_source(source, output, parameters=parameters)
            if result.get("exitCode", 1) != 0:
                return fail(
                    "cad_build_step",
                    result.get("error", "model execution failed"),
                    started=started,
                    input_hashes=input_hashes,
                    stderr=result.get("stderr", ""),
                )

            from ..identity import (
                IdentityError,
                prune_stale_manifest,
                write_manifest as write_identity_manifest,
            )

            artifacts: list[dict[str, str]] = []
            if result.get("identity") is not None:
                try:
                    identity_file, _ = write_identity_manifest(
                        result["identity"],
                        output,
                        source_files=result.get("sourceFiles") or [str(source.resolve())],
                        parameters=parameters,
                    )
                except IdentityError as error:
                    return fail(
                        "cad_build_step",
                        error.message,
                        started=started,
                        input_hashes=input_hashes,
                        stderr=result.get("stderr", ""),
                    )
                artifacts.append(
                    {
                        "path": str(identity_file),
                        "kind": "identity",
                        "sha256": sha256_file(identity_file),
                    }
                )
            else:
                # No declaration this build: drop a manifest that described an
                # earlier artifact so it cannot masquerade as this model.
                prune_stale_manifest(output)

            manifest = make_manifest(
                source_files=result.get("sourceFiles") or [str(source.resolve())],
                root=Path.cwd(),
                output=output,
                parameters_hash=parameters_hash,
            )
            write_manifest(Path.cwd(), output, manifest)
            input_hashes["sourceClosure"] = manifest["sourceClosureHash"]
            input_artifacts = [
                {"path": item["path"], "role": f"source:{index}", "sha256": sha256_file(item["path"])}
                for index, item in enumerate(manifest["dependencies"])
            ]
            emit(
                "cad_build_step",
                {
                    "step": str(output),
                    "sidecars": [artifact["path"] for artifact in artifacts],
                    "exitCode": 0,
                    "stdout": result.get("stdout", ""),
                    "stderr": result.get("stderr", ""),
                    "cache": "miss",
                    "sourceFiles": result.get("sourceFiles", []),
                },
                input_hashes=input_hashes,
                input_artifacts=input_artifacts,
                artifacts=[
                    {"path": str(output), "kind": "step", "sha256": manifest["outputHash"]}
                ]
                + artifacts,
                duration_ms=elapsed_ms(started),
            )
        return 0
    except Exception as exc:  # pragma: no cover - best-effort envelope
        return fail(
            "cad_build_step",
            str(exc),
            started=started,
            input_hashes={"source": hash_or_empty(source)},
        )


def cmd_export(args: argparse.Namespace) -> int:
    from ..export import export_artifact

    started = time.monotonic()
    source = Path(args.source)
    try:
        payload = export_artifact(source, args.output, args.format, expected_source_sha256=args.source_sha256)
        artifacts = [{"path": args.output, "kind": args.format, "sha256": payload["outputSha256"]}]
        if payload.get("identityManifest") and payload.get("identityManifestSha256"):
            artifacts.append({"path": payload["identityManifest"], "kind": "assembly_identity_manifest", "sha256": payload["identityManifestSha256"]})
        emit(
            "cad_export",
            payload,
            input_hashes={"source": payload["sourceSha256"]},
            artifacts=artifacts,
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_export", str(exc), started=started, input_hashes={"source": hash_or_empty(source)})
