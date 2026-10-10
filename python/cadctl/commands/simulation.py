"""Simulation-side commands: analysis-model derivation and topology optimization."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from ..common import emit, sha256_file
from .envelope import elapsed_ms, fail, hash_or_empty


def cmd_derive_analysis_model(args: argparse.Namespace) -> int:
    from ..analysis_model import run_derivation

    started = time.monotonic()
    try:
        record = run_derivation(args.spec, args.output_dir)
        emit(
            "cad_derive_analysis_model",
            record,
            input_hashes={"spec": sha256_file(args.spec), "source": record["sourceHash"]},
            input_artifacts=[
                {"path": str(Path(args.spec).resolve()), "sha256": sha256_file(args.spec), "role": "spec"},
                {"path": record["source"], "sha256": record["sourceHash"], "role": "source"},
            ],
            artifacts=[
                {"path": record["output"], "kind": "analysis_model", "sha256": record["outputHash"]},
                {"path": record["recordPath"], "kind": "derivation_record", "sha256": sha256_file(record["recordPath"])},
            ],
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_derive_analysis_model", str(exc), started=started, input_hashes={"spec": hash_or_empty(args.spec)})


def cmd_optimize(args: argparse.Namespace) -> int:
    from ..simulation.topology import run_topology

    started = time.monotonic()
    try:
        spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
        payload = run_topology(spec, args.output_dir)
        artifacts = []
        if Path(args.spec).exists():
            artifacts.append({"path": args.spec, "kind": "optimization_spec", "sha256": sha256_file(args.spec)})
        if payload.get("artifact") and Path(payload["artifact"]).exists():
            artifacts.append({"path": payload["artifact"], "kind": "optimization", "sha256": sha256_file(payload["artifact"])})
        emit("cad_optimize", payload, input_hashes={"spec": sha256_file(args.spec)}, artifacts=artifacts, duration_ms=elapsed_ms(started))
        return 0
    except Exception as exc:
        return fail("cad_optimize", str(exc), started=started, input_hashes={"spec": hash_or_empty(args.spec)})
