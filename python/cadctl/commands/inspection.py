"""Geometry inspection commands: facts, mesh, measure, compare, sections, surfaces."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from ..common import emit, sha256_file, write_json
from .envelope import elapsed_ms, fail, hash_or_empty


def cmd_inspect(args: argparse.Namespace) -> int:
    from ..geometry import inspect_geometry

    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        payload = inspect_geometry(artifact, validation=args.validation)
        artifacts = []
        if args.output:
            out = Path(args.output)
            write_json(out, payload)
            artifacts.append({"path": str(out), "kind": "geometry", "sha256": sha256_file(out)})
        emit(
            "cad_inspect_geometry",
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            artifacts=artifacts,
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_inspect_geometry", str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})


def cmd_mesh(args: argparse.Namespace) -> int:
    from ..mesh import mesh_document

    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        emit(
            "cad_mesh_document",
            mesh_document(artifact),
            input_hashes={"artifact": sha256_file(artifact)},
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_mesh_document", str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})


def cmd_measure(args: argparse.Namespace) -> int:
    from ..geometry import measure

    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        payload = measure(artifact, args.metric, args.a, args.b)
        emit(
            "cad_measure",
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_measure", str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})


def cmd_compare(args: argparse.Namespace) -> int:
    import json

    from ..compare import compare_geometry

    started = time.monotonic()
    before, after = Path(args.before), Path(args.after)
    try:
        transform_before = json.loads(args.transform_before) if args.transform_before else None
        transform_after = json.loads(args.transform_after) if args.transform_after else None
        payload = compare_geometry(
            before,
            after,
            transform_before=transform_before,
            transform_after=transform_after,
            metrics=args.metrics.split(",") if args.metrics else None,
            diff_output=args.output,
        )
        artifacts = []
        if args.output and Path(args.output).exists():
            artifacts.append({"path": args.output, "kind": "compare", "sha256": sha256_file(args.output)})
        emit(
            "cad_compare_geometry",
            payload,
            input_hashes={
                "before": sha256_file(before),
                "after": sha256_file(after),
            },
            artifacts=artifacts,
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail(
            "cad_compare_geometry",
            str(exc),
            started=started,
            input_hashes={
                "before": hash_or_empty(before),
                "after": hash_or_empty(after),
            },
        )


def cmd_assembly_tree(args: argparse.Namespace) -> int:
    from ..assembly import assembly_tree

    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        payload = assembly_tree(artifact)
        artifacts = []
        if args.output:
            write_json(args.output, payload)
            artifacts.append({"path": args.output, "kind": "assembly_tree", "sha256": sha256_file(args.output)})
        emit(
            "cad_assembly_tree",
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            artifacts=artifacts,
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_assembly_tree", str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})


def cmd_inspect_interference(args: argparse.Namespace) -> int:
    from ..interference import inspect_interference

    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        payload = inspect_interference(artifact)
        artifacts = []
        if args.output:
            write_json(args.output, payload)
            artifacts.append({"path": args.output, "kind": "interference", "sha256": sha256_file(args.output)})
        emit(
            "cad_inspect_interference",
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            input_artifacts=[{"path": str(artifact), "sha256": sha256_file(artifact), "role": "artifact"}],
            artifacts=artifacts,
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_inspect_interference", str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})


def cmd_scan_sections(args: argparse.Namespace) -> int:
    from ..sections import scan_sections

    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        count = args.count if args.count is not None else None
        step = args.step if args.step is not None else None
        payload = scan_sections(artifact, axis=args.axis, count=count, step=step)
        artifacts = []
        if args.output:
            write_json(args.output, payload)
            artifacts.append({"path": args.output, "kind": "sections", "sha256": sha256_file(args.output)})
        emit(
            "cad_scan_sections",
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            input_artifacts=[{"path": str(artifact.resolve()), "sha256": sha256_file(artifact), "role": "artifact"}],
            artifacts=artifacts,
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_scan_sections", str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})


def cmd_inspect_surfaces(args: argparse.Namespace) -> int:
    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        from ..shape_facts import enumerate_surfaces
        from ..simulation.surface_selector import render_labeled_views

        payload = enumerate_surfaces(artifact)
        artifacts: list[dict[str, str]] = []
        if args.output:
            out = Path(args.output)
            write_json(out, payload)
            artifacts.append({"path": str(out), "kind": "surfaces", "sha256": sha256_file(out)})
        if args.labels:
            out_dir = Path(args.out_dir) if args.out_dir else (out.parent / "views" if args.output else Path.cwd() / "surface-views")
            views = render_labeled_views(
                artifact,
                out_dir,
                payload["surfaces"],
                views=args.views.split(",") if args.views else None,
            )
            payload["views"] = views
            for view in views:
                artifacts.append({"path": view["path"], "kind": "surfaces_visual", "sha256": sha256_file(view["path"])})
        emit(
            "cad_inspect_surfaces",
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            artifacts=artifacts,
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_inspect_surfaces", str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})
