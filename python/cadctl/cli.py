from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Sequence

from . import __version__
from .assembly import assembly_tree
from .analysis_model import run_derivation
from .interference import inspect_interference
from .sections import scan_sections
from .capability import capabilities
from .common import emit, emit_error, sha256_file, write_json
from .doctor import doctor
from .compare import compare_geometry
from .drawing import generate_drawing, validate_drawing_spec
from .export import export_artifact
from .geometry import inspect_geometry, measure
from .model import run_source
from .probe import ProbeError, run_probe
from .presentation import run_presentation
from .render import VIEW_NAMES, render_views
from .section import render_section
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


def _cmd_probe(args: argparse.Namespace) -> int:
    started = time.monotonic()
    artifact = Path(args.artifact)
    try:
        code = Path(args.code_file).read_text(encoding="utf-8")
    except OSError as exc:
        emit_error(
            "cad_probe_python",
            f"cannot read probe code: {exc}",
            input_hashes={"artifact": sha256_file(artifact) if artifact.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 1
    try:
        payload = run_probe(artifact, code)
        emit(
            "cad_probe_python",
            payload,
            input_hashes={
                "artifact": sha256_file(artifact),
                "script": sha256_file(Path(args.code_file)),
            },
            input_artifacts=[{"path": str(artifact), "role": "subject"}],
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except ProbeError as exc:
        emit_error(
            "cad_probe_python",
            str(exc),
            input_hashes={
                "artifact": sha256_file(artifact) if artifact.exists() else "",
                "script": sha256_file(Path(args.code_file)),
            },
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 1


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


def _cmd_inspect_interference(args: argparse.Namespace) -> int:
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
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_inspect_interference",
            str(exc),
            input_hashes={"artifact": sha256_file(artifact) if artifact.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_scan_sections(args: argparse.Namespace) -> int:
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
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_scan_sections",
            str(exc),
            input_hashes={"artifact": sha256_file(artifact) if artifact.exists() else ""},
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0


def _cmd_derive_analysis_model(args: argparse.Namespace) -> int:
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
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return 0
    except Exception as exc:
        emit_error(
            "cad_derive_analysis_model",
            str(exc),
            input_hashes={"spec": sha256_file(args.spec) if Path(args.spec).exists() else ""},
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
    from .common import read_json
    return read_json(spec_path, normalize_paths=True)


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
        if payload.get("status") == "discarded":
            emit_error(
                "cad_render_scene",
                str(payload.get("reason", "presentation discarded")),
                input_hashes={"spec": sha256_file(args.spec) if Path(args.spec).exists() else ""},
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            return 0
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
    p.add_argument("--labels", action=argparse.BooleanOptionalAction, default=True, help="Render view names and the world-frame triad (use --no-labels for a clean render)")
    p.set_defaults(func=_cmd_render)

    p = sub.add_parser("measure", help="Return one deterministic measurement")
    p.add_argument("--artifact", required=True)
    p.add_argument("--metric", required=True)
    p.add_argument("--a", required=True)
    p.add_argument("--b", default=None)
    p.set_defaults(func=_cmd_measure)

    p = sub.add_parser(
        "probe",
        help="Run a read-only programmable B-Rep probe: arbitrary Python computation over the subject STEP, JSON result only",
    )
    p.add_argument("--artifact", required=True)
    p.add_argument("--code-file", required=True, help="Path to the probe script (harness-managed temporary file)")
    p.set_defaults(func=_cmd_probe)

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

    p = sub.add_parser("inspect-interference", help="Return pairwise solid interference facts (penetration/contact/clearance)")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.set_defaults(func=_cmd_inspect_interference)

    p = sub.add_parser("scan-sections", help="Scan cross-section facts (area, centroid, moments) along an axis")
    p.add_argument("--artifact", required=True)
    p.add_argument("--axis", default="z", choices=("x", "y", "z"))
    p.add_argument("--count", type=int, default=None, help="Number of evenly spaced sections")
    p.add_argument("--step", type=float, default=None, help="Spacing between sections")
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.set_defaults(func=_cmd_scan_sections)

    p = sub.add_parser("derive-analysis-model", help="Create a harness-owned analysis-model derivation record (fused/bonded executed by the harness)")
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=True)
    p.set_defaults(func=_cmd_derive_analysis_model)

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

    p = sub.add_parser("inspect-surfaces", help="Return deterministic boundary-surface facts and surface IDs")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.add_argument("--labels", action="store_true", help="Render labeled selector views")
    p.add_argument("--out-dir", default=None, help="Directory for labeled views (requires --labels)")
    p.add_argument("--views", default=None, help="Comma-separated subset of iso,front,right,top")
    p.set_defaults(func=_cmd_inspect_surfaces)

    p = sub.add_parser("present", help="Validate, preview, generate, or run a spec-driven presentation")
    p.add_argument("stage", choices=("validate", "preview", "generate", "run"))
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
