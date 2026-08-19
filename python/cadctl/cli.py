from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Sequence

from . import __version__
from .assembly import assembly_tree
from .capability import capabilities
from .common import emit, emit_error, sha256_file, write_json
from .doctor import doctor
from .compare import compare_geometry
from .drawing import generate_drawing, validate_drawing_spec
from .export import export_artifact
from .geometry import inspect_geometry, measure
from .model import run_source
from .presentation import run_presentation
from .provenance import FrozenInputs, spec_input_paths
from .render import VIEW_NAMES, render_views
from .section import render_section
from .simulation.api import run_simulation
from .simulation.flow_api import run_flow
from .simulation.thermal_api import run_thermal
from .simulation.topology import run_topology


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help=argparse.SUPPRESS)


def _cmd_build(args: argparse.Namespace) -> int:
    started = time.monotonic()
    source = Path(args.source)
    output = Path(args.output)
    try:
        result = run_source(source, output)
        if result.get("exitCode", 1) != 0:
            emit_error(
                "cad_build_step",
                result.get("error", "model execution failed"),
                input_hashes={"source": sha256_file(source)},
                duration_ms=int((time.monotonic() - started) * 1000),
                stderr=result.get("stderr", ""),
            )
            return 0

        emit(
            "cad_build_step",
            {
                "step": str(output),
                "sidecars": [],
                "exitCode": 0,
                "stdout": result.get("stdout", ""),
                "stderr": result.get("stderr", ""),
            },
            input_hashes={"source": sha256_file(source)},
            artifacts=[
                {"path": str(output), "kind": "step", "sha256": sha256_file(output)}
            ],
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:  # pragma: no cover - best-effort envelope
        emit_error(
            "cad_build_step",
            str(exc),
            input_hashes={"source": sha256_file(source) if source.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_inspect(args: argparse.Namespace) -> int:
    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        payload = inspect_geometry(artifact)
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
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_inspect_geometry",
            str(exc),
            input_hashes={"artifact": sha256_file(artifact) if artifact.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_render(args: argparse.Namespace) -> int:
    started = time.monotonic()
    artifact = Path(args.artifact)
    views = args.views.split(",") if args.views else None
    try:
        payload = render_views(
            artifact,
            args.out_dir,
            views=views,
            width=args.width,
            height=args.height,
            display=args.display,
            labels=args.labels,
        )
        artifacts = [
            {"path": view["path"], "kind": "visual", "sha256": sha256_file(view["path"])}
            for view in payload["views"]
        ]
        emit(
            "cad_inspect_visual",
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            artifacts=artifacts,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_inspect_visual",
            str(exc),
            input_hashes={"artifact": sha256_file(artifact) if artifact.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_measure(args: argparse.Namespace) -> int:
    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        payload = measure(artifact, args.metric, args.a, args.b)
        emit(
            "cad_measure",
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_measure",
            str(exc),
            input_hashes={"artifact": sha256_file(artifact) if artifact.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0



def _cmd_section(args: argparse.Namespace) -> int:
    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        payload = render_section(
            artifact,
            args.out_dir,
            origin=tuple(float(x) for x in args.origin.split(",")),
            normal=tuple(float(x) for x in args.normal.split(",")),
            width=args.width,
            height=args.height,
            display=args.display,
            labels=args.labels,
        )
        artifacts = [
            {"path": view["path"], "kind": "section", "sha256": sha256_file(view["path"])}
            for view in payload["views"]
        ]
        emit(
            "cad_inspect_section",
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            artifacts=artifacts,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_inspect_section",
            str(exc),
            input_hashes={"artifact": sha256_file(artifact) if artifact.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_compare(args: argparse.Namespace) -> int:
    started = time.monotonic()
    before, after = Path(args.before), Path(args.after)
    try:
        import json as _json

        transform_before = _json.loads(args.transform_before) if args.transform_before else None
        transform_after = _json.loads(args.transform_after) if args.transform_after else None
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
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_compare_geometry",
            str(exc),
            input_hashes={
                "before": sha256_file(before) if before.exists() else "",
                "after": sha256_file(after) if after.exists() else "",
            },
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_assembly_tree(args: argparse.Namespace) -> int:
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
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_assembly_tree",
            str(exc),
            input_hashes={"artifact": sha256_file(artifact) if artifact.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_export(args: argparse.Namespace) -> int:
    started = time.monotonic()
    source = Path(args.source)
    try:
        payload = export_artifact(source, args.output, args.format)
        output = Path(args.output)
        emit(
            "cad_export",
            payload,
            input_hashes={"source": sha256_file(source)},
            artifacts=[{"path": args.output, "kind": args.format, "sha256": sha256_file(output)}],
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_export",
            str(exc),
            input_hashes={"source": sha256_file(source) if source.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_capability(args: argparse.Namespace) -> int:
    started = time.monotonic()
    emit(
        "cadctl_capability",
        {"capabilities": capabilities()},
        duration_ms=int((time.monotonic() - started) * 1000),
    )
    return 0


def _load_spec(spec_path: str) -> dict:
    import json
    return json.loads(Path(spec_path).read_text(encoding="utf-8"))


def _cmd_drawing(args: argparse.Namespace) -> int:
    started = time.monotonic()
    try:
        spec = _load_spec(args.spec)
        if args.stage == "validate":
            ok, errors = validate_drawing_spec(spec)
            payload = {"status": "validated" if ok else "invalid", "errors": errors}
            emit("cad_generate_drawing", payload, input_hashes={"spec": sha256_file(args.spec)}, duration_ms=int((time.monotonic() - started) * 1000))
        else:
            payload = generate_drawing(args.spec, args.output_dir)
            artifacts = [
                {"path": p, "kind": "drawing", "sha256": sha256_file(p)}
                for p in payload["outputs"]
            ]
            emit(
                "cad_generate_drawing",
                payload,
                input_hashes={"spec": sha256_file(args.spec)},
                artifacts=artifacts,
                warnings=payload.get("warnings", []),
                duration_ms=int((time.monotonic() - started) * 1000),
            )
        return 0
    except Exception as exc:
        emit_error("cad_generate_drawing", str(exc), input_hashes={"spec": sha256_file(args.spec) if Path(args.spec).exists() else ""}, duration_ms=int((time.monotonic() - started) * 1000))
        return 0


def _cmd_simulate(args: argparse.Namespace) -> int:
    started = time.monotonic()
    try:
        input_hashes = {"spec": sha256_file(args.spec)}
        # Bind the artifact version BEFORE the solve; evidence provenance must
        # never come from a post-solve hash of a file that may have changed.
        artifact_before: str | None = None
        spec_artifact = None
        if args.stage == "run":
            spec_artifact = json.loads(Path(args.spec).read_text(encoding="utf-8")).get("artifact")
            if spec_artifact and Path(spec_artifact).exists():
                artifact_before = sha256_file(spec_artifact)
            if artifact_before:
                input_hashes["artifact"] = artifact_before
        payload = run_simulation(args.spec, args.output_dir, stage=args.stage)
        artifacts: list[dict[str, str]] = []
        if Path(args.spec).exists():
            artifacts.append({"path": args.spec, "kind": "simulation_spec", "sha256": sha256_file(args.spec)})
        if args.stage == "run":
            if (
                artifact_before
                and spec_artifact
                and Path(spec_artifact).exists()
                and sha256_file(spec_artifact) != artifact_before
            ):
                emit_error(
                    "cad_simulate",
                    "artifact changed during simulation; result discarded because the mesh and "
                    "the bound artifact version no longer match",
                    input_hashes=input_hashes,
                    duration_ms=int((time.monotonic() - started) * 1000),
                )
                return 0
            result_artifact = payload.get("artifact")
            if payload.get("status") == "solved" and result_artifact and Path(result_artifact).exists():
                artifacts.append(
                    {"path": result_artifact, "kind": "simulation", "sha256": sha256_file(result_artifact)}
                )
            for field_artifact in payload.get("fieldArtifacts") or []:
                if Path(field_artifact).exists():
                    artifacts.append(
                        {"path": field_artifact, "kind": "simulation_fields", "sha256": sha256_file(field_artifact)}
                    )
            for view in (payload.get("visualization") or {}).get("views") or []:
                view_path = view.get("path")
                if view_path and Path(view_path).exists():
                    artifacts.append(
                        {"path": view_path, "kind": "simulation_visual", "sha256": sha256_file(view_path)}
                    )
        if args.stage == "run" and payload.get("status") == "unavailable":
            emit_error(
                "cad_simulate",
                str(payload.get("reason", "simulation backend unavailable")),
                input_hashes=input_hashes,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            return 0
        emit(
            "cad_simulate",
            payload,
            input_hashes=input_hashes,
            artifacts=artifacts,
            warnings=[] if payload.get("status") == "solved" else ["simulation did not produce satisfying evidence"],
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error("cad_simulate", str(exc), input_hashes={"spec": sha256_file(args.spec) if Path(args.spec).exists() else ""}, duration_ms=int((time.monotonic() - started) * 1000))
        return 0


def _frozen_invocation_inputs(spec_path: str, stage: str) -> "FrozenInputs":
    """Freeze the invocation's inputs ONCE, before the solve.

    Provenance (which files this invocation consumed, at which hashes) is
    defined here and only verified afterwards — never re-derived from a
    post-solve re-read. Re-parsing the spec after the solve would let a
    concurrent rewrite redefine provenance instead of invalidating the run.
    """
    return FrozenInputs.freeze(
        spec_input_paths(spec_path) if stage == "run" else [("spec", spec_path)]
    )


def _simulation_result_artifacts(payload: dict) -> list[dict[str, str]]:
    artifacts: list[dict[str, str]] = []
    for key in ("artifact",):
        path = payload.get(key)
        if path and Path(path).exists():
            artifacts.append({"path": path, "kind": "simulation_result", "sha256": sha256_file(path)})
    for field_artifact in payload.get("fieldArtifacts") or []:
        if Path(field_artifact).exists():
            artifacts.append(
                {"path": field_artifact, "kind": "simulation_fields", "sha256": sha256_file(field_artifact)}
            )
    for raw in ("case.cfg", "history.csv", "vol_solution.vtu"):
        path = Path(payload.get("_workdir", "")) / raw if payload.get("_workdir") else None
        if path and path.exists():
            artifacts.append({"path": str(path), "kind": "simulation_raw", "sha256": sha256_file(path)})
    for view in (payload.get("visualization") or {}).get("views") or []:
        view_path = view.get("path")
        if view_path and Path(view_path).exists():
            artifacts.append(
                {"path": view_path, "kind": "simulation_visual", "sha256": sha256_file(view_path)}
            )
    return artifacts


def _cmd_simulate_flow(args: argparse.Namespace) -> int:
    started = time.monotonic()
    try:
        frozen = _frozen_invocation_inputs(args.spec, args.stage)
        input_hashes = frozen.hashes()
        payload = run_flow(args.spec, args.output_dir, stage=args.stage)
        if args.stage == "run":
            payload["_workdir"] = str(Path(args.output_dir).resolve())
            # Any completed run is bound to the frozen invocation inputs
            # (the backend already covers artifact/fluidDomain mid-solve).
            if payload.get("status") in {"solved", "not_converged"}:
                reason = frozen.discard_reason()
                if reason is not None:
                    emit_error(
                        "cad_simulate_flow",
                        reason,
                        input_hashes=input_hashes,
                        duration_ms=int((time.monotonic() - started) * 1000),
                    )
                    return 0
        if payload.get("status") in {"unavailable", "discarded"}:
            emit_error(
                "cad_simulate_flow",
                str(payload.get("reason", "SU2 backend unavailable")),
                input_hashes=input_hashes,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            return 0
        artifacts = _simulation_result_artifacts(payload) if args.stage == "run" else []
        input_artifacts = frozen.artifacts() if args.stage == "run" else None
        emit(
            "cad_simulate_flow",
            payload,
            input_hashes=input_hashes,
            input_artifacts=input_artifacts,
            artifacts=artifacts,
            warnings=[] if payload.get("status") in {"solved", "validated"} else ["flow simulation status=" + str(payload.get("status")) + ": " + str(payload.get("reason", "did not produce satisfying evidence"))],
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error("cad_simulate_flow", str(exc), input_hashes={"spec": sha256_file(args.spec) if Path(args.spec).exists() else ""}, duration_ms=int((time.monotonic() - started) * 1000))
        return 0


def _cmd_simulate_thermal(args: argparse.Namespace) -> int:
    started = time.monotonic()
    try:
        frozen = _frozen_invocation_inputs(args.spec, args.stage)
        input_hashes = frozen.hashes()
        payload = run_thermal(args.spec, args.output_dir, stage=args.stage)
        if args.stage == "run":
            payload["_workdir"] = str(Path(args.output_dir).resolve())
            # Any completed run is bound to the frozen invocation inputs
            # (the backend already covers artifact/fluidDomain mid-solve).
            if payload.get("status") in {"solved", "not_converged"}:
                reason = frozen.discard_reason()
                if reason is not None:
                    emit_error(
                        "cad_simulate_thermal",
                        reason,
                        input_hashes=input_hashes,
                        duration_ms=int((time.monotonic() - started) * 1000),
                    )
                    return 0
        if payload.get("status") in {"unavailable", "discarded"}:
            emit_error(
                "cad_simulate_thermal",
                str(payload.get("reason", "SU2 backend unavailable")),
                input_hashes=input_hashes,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            return 0
        artifacts = _simulation_result_artifacts(payload) if args.stage == "run" else []
        input_artifacts = frozen.artifacts() if args.stage == "run" else None
        emit(
            "cad_simulate_thermal",
            payload,
            input_hashes=input_hashes,
            input_artifacts=input_artifacts,
            artifacts=artifacts,
            warnings=[] if payload.get("status") in {"solved", "validated"} else ["thermal simulation status=" + str(payload.get("status")) + ": " + str(payload.get("reason", "did not produce satisfying evidence"))],
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error("cad_simulate_thermal", str(exc), input_hashes={"spec": sha256_file(args.spec) if Path(args.spec).exists() else ""}, duration_ms=int((time.monotonic() - started) * 1000))
        return 0


def _cmd_inspect_surfaces(args: argparse.Namespace) -> int:
    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        from .simulation.surface_selector import enumerate_surfaces, render_labeled_views

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
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_inspect_surfaces",
            str(exc),
            input_hashes={"artifact": sha256_file(artifact) if artifact.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_present(args: argparse.Namespace) -> int:
    started = time.monotonic()
    try:
        payload = run_presentation(args.spec, args.output_dir, stage=args.stage)
        artifacts = [
            {"path": p, "kind": "presentation", "sha256": sha256_file(p)}
            for p in payload.get("outputs", [])
            if Path(p).exists()
        ]
        emit(
            "cad_render_scene",
            payload,
            input_hashes={"spec": sha256_file(args.spec)},
            artifacts=artifacts,
            warnings=["presentation run is optional and may be unavailable"] if payload.get("status") in {"unavailable", "script-generated"} else [],
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error("cad_render_scene", str(exc), input_hashes={"spec": sha256_file(args.spec) if Path(args.spec).exists() else ""}, duration_ms=int((time.monotonic() - started) * 1000))
        return 0


def _cmd_doctor(args: argparse.Namespace) -> int:
    started = time.monotonic()
    payload = doctor()
    if args.json:
        print(__import__("json").dumps(payload, indent=2, sort_keys=True))
        return 0
    emit("cadctl_doctor", payload, duration_ms=int((time.monotonic() - started) * 1000))
    return 0


def _cmd_optimize(args: argparse.Namespace) -> int:
    started = time.monotonic()
    try:
        import json as _json

        spec = _json.loads(Path(args.spec).read_text(encoding="utf-8"))
        payload = run_topology(spec, args.output_dir)
        artifacts = []
        if Path(args.spec).exists():
            artifacts.append({"path": args.spec, "kind": "optimization_spec", "sha256": sha256_file(args.spec)})
        if payload.get("artifact") and Path(payload["artifact"]).exists():
            artifacts.append({"path": payload["artifact"], "kind": "optimization", "sha256": sha256_file(payload["artifact"])})
        emit("cad_optimize", payload, input_hashes={"spec": sha256_file(args.spec)}, artifacts=artifacts, duration_ms=int((time.monotonic() - started) * 1000))
        return 0
    except Exception as exc:
        emit_error("cad_optimize", str(exc), input_hashes={"spec": sha256_file(args.spec) if Path(args.spec).exists() else ""}, duration_ms=int((time.monotonic() - started) * 1000))
        return 0

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cadctl", description="Pi-CAD deterministic CAD backend (V0)")
    parser.add_argument("--version", action="version", version=f"cadctl {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("build", help="Execute a build123d source and write STEP")
    p.add_argument("--source", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=_cmd_build)

    p = sub.add_parser("inspect", help="Return STEP geometry facts")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.set_defaults(func=_cmd_inspect)

    p = sub.add_parser("render", help="Render orthographic STEP views")
    p.add_argument("--artifact", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--views", default=None, help="Comma-separated subset of " + ",".join(VIEW_NAMES))
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--display", default="solid", choices=("solid",))
    p.add_argument("--labels", action="store_true")
    p.set_defaults(func=_cmd_render)

    p = sub.add_parser("measure", help="Return one deterministic measurement")
    p.add_argument("--artifact", required=True)
    p.add_argument("--metric", required=True)
    p.add_argument("--a", required=True)
    p.add_argument("--b", default=None)
    p.set_defaults(func=_cmd_measure)

    p = sub.add_parser("section", help="Render a deterministic section view")
    p.add_argument("--artifact", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--origin", required=True)
    p.add_argument("--normal", required=True)
    p.add_argument("--display", default="solid", choices=("solid", "hidden_edges", "solid_with_hidden"))
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--labels", action="store_true")
    p.set_defaults(func=_cmd_section)

    p = sub.add_parser("compare", help="Return deterministic before/after geometry diff")
    p.add_argument("--before", required=True)
    p.add_argument("--after", required=True)
    p.add_argument("--metrics", default=None)
    p.add_argument("--transform-before", default=None)
    p.add_argument("--transform-after", default=None)
    p.add_argument("--output", default=None)
    p.set_defaults(func=_cmd_compare)

    p = sub.add_parser("assembly-tree", help="Return occurrence tree and world transforms")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output", default=None)
    p.set_defaults(func=_cmd_assembly_tree)

    p = sub.add_parser("export", help="Export STEP/STL/GLB/BREP deterministically")
    p.add_argument("--source", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--format", required=True)
    p.set_defaults(func=_cmd_export)

    p = sub.add_parser("capability", help="Report installed deterministic backend capabilities")
    p.set_defaults(func=_cmd_capability)

    p = sub.add_parser("doctor", help="Report the actual Pi-CAD execution environment")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_doctor)

    p = sub.add_parser("optimize", help="Run deterministic differentiable topology optimization")
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=True)
    p.set_defaults(func=_cmd_optimize)

    p = sub.add_parser("drawing", help="Validate or generate a spec-driven drawing")
    p.add_argument("stage", choices=("validate", "generate"))
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=False)
    p.set_defaults(func=_cmd_drawing)

    p = sub.add_parser("simulate", help="Validate or run a spec-driven simulation")
    p.add_argument("stage", choices=("validate", "run"))
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=True)
    p.set_defaults(func=_cmd_simulate)

    p = sub.add_parser("simulate-flow", help="Validate or run a spec-driven SU2 CFD case")
    p.add_argument("stage", choices=("validate", "run"))
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=True)
    p.set_defaults(func=_cmd_simulate_flow)

    p = sub.add_parser("simulate-thermal", help="Validate or run a spec-driven SU2 solid heat case")
    p.add_argument("stage", choices=("validate", "run"))
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=True)
    p.set_defaults(func=_cmd_simulate_thermal)

    p = sub.add_parser("inspect-surfaces", help="Return deterministic boundary-surface facts and surface IDs")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.add_argument("--labels", action="store_true", help="Render labeled selector views")
    p.add_argument("--out-dir", default=None, help="Directory for labeled views (requires --labels)")
    p.add_argument("--views", default=None, help="Comma-separated subset of iso,front,right,top")
    p.set_defaults(func=_cmd_inspect_surfaces)

    p = sub.add_parser("present", help="Validate, generate, or run a spec-driven presentation")
    p.add_argument("stage", choices=("validate", "generate", "run"))
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=True)
    p.set_defaults(func=_cmd_present)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print('{"ok":false,"tool":"cadctl","payload":{"error":"interrupted"}}', file=sys.stderr)
        return 130
