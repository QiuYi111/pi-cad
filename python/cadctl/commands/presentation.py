"""Presentation commands: spec-driven presentations and the managed Blender runtime."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from ..common import emit, sha256_file
from .envelope import elapsed_ms, fail, hash_or_empty


def cmd_present(args: argparse.Namespace) -> int:
    from ..presentation import run_presentation

    started = time.monotonic()
    try:
        payload = run_presentation(args.spec, args.output_dir, stage=args.stage)
        if payload.get("status") == "discarded":
            return fail(
                "cad_render_scene",
                str(payload.get("reason", "presentation discarded")),
                started=started,
                input_hashes={"spec": hash_or_empty(args.spec)},
            )
        artifacts = [
            {"path": p, "kind": "presentation", "sha256": sha256_file(p)}
            for p in payload.get("outputs", [])
            if Path(p).exists()
        ]
        # Provenance comes FROM the frozen invocation set (spec, artifact,
        # and every reference image), never from a post-render re-hash:
        # accept/finish re-verify these hashes, so a rewritten reference
        # invalidates the evidence like any other input.
        frozen_artifacts = payload.get("inputArtifacts") or []
        if frozen_artifacts:
            input_hashes = {entry["role"]: entry["sha256"] for entry in frozen_artifacts}
            input_artifacts = frozen_artifacts
        else:
            input_hashes = {"spec": sha256_file(args.spec)}
            input_artifacts = [
                {"path": str(Path(args.spec).resolve()), "sha256": sha256_file(args.spec), "role": "spec"}
            ]
        emit(
            "cad_render_scene",
            payload,
            input_hashes=input_hashes,
            input_artifacts=input_artifacts,
            artifacts=artifacts,
            warnings=["presentation run is optional and may be unavailable"] if payload.get("status") in {"unavailable", "script-generated"} else [],
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_render_scene", str(exc), started=started, input_hashes={"spec": hash_or_empty(args.spec)})


def cmd_blender(args: argparse.Namespace) -> int:
    """Run agent-authored Blender work through the managed runtime."""
    from ..presentation import blender_binary

    binary, source = blender_binary()
    if not binary or source in {"missing", "path-fallback", "override-missing"}:
        print(
            json.dumps({
                "ok": False,
                "tool": "cadctl_blender",
                "payload": {
                    "error": "managed Blender runtime is unavailable",
                    "source": source,
                },
            }),
            file=sys.stderr,
        )
        return 2
    if args.print_path:
        print(binary)
        return 0
    command = list(args.blender_args)
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        print("cadctl blender requires Blender arguments or --print-path", file=sys.stderr)
        return 2
    lib_dir = Path(binary).parent / "lib"
    env = {**os.environ, "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS", "1")}
    if lib_dir.exists():
        env["LD_LIBRARY_PATH"] = f"{lib_dir}{os.pathsep}{env.get('LD_LIBRARY_PATH', '')}".rstrip(os.pathsep)
    return subprocess.run([binary, *command], env=env, check=False).returncode


def cmd_blender_bridge(args: argparse.Namespace) -> int:
    from ..blender_bridge import prepare_blender_bundle

    print(json.dumps(prepare_blender_bundle(args.artifact, args.output_dir, args.source), indent=2))
    return 0
