from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Sequence

from . import __version__
from .common import emit, emit_error, sha256_file, write_json
from .geometry import inspect_geometry, measure
from .model import run_source
from .render import VIEW_NAMES, render_views


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

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print('{"ok":false,"tool":"cadctl","payload":{"error":"interrupted"}}', file=sys.stderr)
        return 130
