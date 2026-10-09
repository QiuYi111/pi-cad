"""cadctl command-line entry point: argument parsing and dispatch.

Handlers live in ``cadctl.commands`` (one module per area). Each handler prints
its own JSON envelope and returns the exit code.
"""

from __future__ import annotations

import argparse
import subprocess  # noqa: F401 - tests patch cadctl.cli.subprocess.run for the blender passthrough
import sys
from typing import Sequence

from . import __version__
from .commands import build, env, identity, inspection, presentation, probe, render, simulation


VIEW_NAMES = ("iso", "front", "back", "left", "right", "top", "bottom", "iso_opposite")


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help=argparse.SUPPRESS)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cadctl", description="Pi-CAD deterministic CAD backend (V0)")
    parser.add_argument("--version", action="version", version=f"cadctl {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("build", help="Execute a build123d source and write STEP")
    p.add_argument("--source", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--force", action="store_true")
    p.add_argument("--parameters-json")
    p.add_argument("--solidify", action="store_true", help="sew only closed STEP surfaces into valid solids")
    p.set_defaults(func=build.cmd_build)

    p = sub.add_parser("inspect", help="Return STEP geometry facts")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.add_argument("--validation", choices=("auto", "fast", "full"), default="auto")
    p.set_defaults(func=inspection.cmd_inspect)

    p = sub.add_parser("mesh", help="Return a compact desktop preview mesh")
    p.add_argument("--artifact", required=True)
    p.set_defaults(func=inspection.cmd_mesh)

    p = sub.add_parser("bind-identity", help="Bind a declarations.json (e.g. from the FreeCAD backend) to a STEP and write its identity manifest")
    p.add_argument("--artifact", required=True)
    p.add_argument("--declarations", required=True)
    p.set_defaults(func=identity.cmd_bind_identity)

    p = sub.add_parser("render", help="Render orthographic STEP views")
    p.add_argument("--artifact", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--views", default=None, help="Comma-separated subset of " + ",".join(VIEW_NAMES))
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--display", default="solid", choices=("solid", "solid_with_edges", "hidden_edges", "wireframe"))
    p.add_argument("--focus-json", default=None, help="JSON array of occurrence refs or unique aliases")
    p.add_argument("--hide-json", default=None, help="JSON array of occurrence refs or unique aliases")
    p.add_argument("--highlight-json", default=None, help='JSON array of face fingerprints to colour orange, e.g. [{"type":"PLANE","c":[0,0,1],"a":12.3,"n":[0,0,1]}]')
    p.add_argument("--annotations-json", default=None, help='JSON array of [{"text": "name", "at": [x, y, z]}] labels (max 8 per view)')
    p.add_argument("--explode", type=float, default=0.0, help="Exploded-view distance, 0..5")
    p.add_argument("--ghost-others", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--labels", action=argparse.BooleanOptionalAction, default=True, help="Render view names and the world-frame triad (use --no-labels for a clean render)")
    p.set_defaults(func=render.cmd_render)

    p = sub.add_parser("measure", help="Return one deterministic measurement")
    p.add_argument("--artifact", required=True)
    p.add_argument("--metric", required=True)
    p.add_argument("--a", required=True)
    p.add_argument("--b", default=None)
    p.set_defaults(func=inspection.cmd_measure)

    p = sub.add_parser(
        "probe",
        help="Run arbitrary Python on a disposable STEP copy; return a JSON result without changing the candidate",
    )
    p.add_argument("--artifact", required=True)
    p.add_argument("--code-file", required=True, help="Path to the probe script (harness-managed temporary file)")
    p.add_argument("--params-json", default="{}", help="Structured JSON parameters passed to the Python scope")
    p.set_defaults(func=probe.cmd_probe)

    p = sub.add_parser("section", help="Render a deterministic section view")
    p.add_argument("--artifact", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--origin", required=True)
    p.add_argument("--normal", required=True)
    p.add_argument("--display", default="solid", choices=("solid", "hidden_edges", "solid_with_hidden"))
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--labels", action="store_true")
    p.set_defaults(func=render.cmd_section)

    p = sub.add_parser("compare", help="Return deterministic before/after geometry diff")
    p.add_argument("--before", required=True)
    p.add_argument("--after", required=True)
    p.add_argument("--metrics", default=None)
    p.add_argument("--transform-before", default=None)
    p.add_argument("--transform-after", default=None)
    p.add_argument("--output", default=None)
    p.set_defaults(func=inspection.cmd_compare)

    p = sub.add_parser("assembly-tree", help="Return occurrence tree and world transforms")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output", default=None)
    p.set_defaults(func=inspection.cmd_assembly_tree)

    p = sub.add_parser(
        "identity",
        help="List, resolve, or verify the declared names of one artifact",
    )
    p.add_argument("stage", choices=("list", "resolve", "verify"))
    p.add_argument("--artifact", required=True)
    p.add_argument("--target", default=None, help="Semantic path or current-artifact ref (resolve)")
    p.add_argument("--kind", default=None, help="Restrict to one entity kind")
    p.add_argument("--owner", default=None, help="Restrict to one owner semantic path")
    p.add_argument("--expect", default=None, help="one, many, or an exact count")
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.set_defaults(func=identity.cmd_identity)

    p = sub.add_parser("inspect-interference", help="Return pairwise solid interference facts (penetration/contact/clearance)")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.set_defaults(func=inspection.cmd_inspect_interference)

    p = sub.add_parser("scan-sections", help="Scan cross-section facts (area, centroid, moments) along an axis")
    p.add_argument("--artifact", required=True)
    p.add_argument("--axis", default="z", choices=("x", "y", "z"))
    p.add_argument("--count", type=int, default=None, help="Number of evenly spaced sections")
    p.add_argument("--step", type=float, default=None, help="Spacing between sections")
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.set_defaults(func=inspection.cmd_scan_sections)

    p = sub.add_parser("derive-analysis-model", help="Create a harness-owned analysis-model derivation record (fused/bonded executed by the harness)")
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=True)
    p.set_defaults(func=simulation.cmd_derive_analysis_model)

    p = sub.add_parser("export", help="Export STEP/STL/GLB/BREP deterministically")
    p.add_argument("--source", required=True)
    p.add_argument("--source-sha256", default=None)
    p.add_argument("--output", required=True)
    p.add_argument("--format", required=True)
    p.set_defaults(func=build.cmd_export)

    p = sub.add_parser("capability", help="Report installed deterministic backend capabilities")
    p.set_defaults(func=env.cmd_capability)

    p = sub.add_parser("doctor", help="Report the actual Pi-CAD execution environment")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=env.cmd_doctor)

    p = sub.add_parser("blender", help="Run the pinned managed Blender binary")
    p.add_argument("--print-path", action="store_true", help="Print the managed Blender path and exit")
    p.add_argument("blender_args", nargs=argparse.REMAINDER)
    p.set_defaults(func=presentation.cmd_blender)

    p = sub.add_parser("blender-bridge", help="Tessellate STEP into a labeled Blender import bundle")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--source", default=None)
    p.set_defaults(func=presentation.cmd_blender_bridge)

    p = sub.add_parser("optimize", help="Run deterministic differentiable topology optimization")
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=True)
    p.set_defaults(func=simulation.cmd_optimize)

    p = sub.add_parser("drawing", help="Validate or generate a spec-driven drawing")
    p.add_argument("stage", choices=("validate", "generate"))
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=False)
    p.set_defaults(func=render.cmd_drawing)

    p = sub.add_parser("inspect-surfaces", help="Return deterministic boundary-surface facts and surface IDs")
    p.add_argument("--artifact", required=True)
    p.add_argument("--output", default=None, help="Also write the JSON payload to this path")
    p.add_argument("--labels", action="store_true", help="Render labeled selector views")
    p.add_argument("--out-dir", default=None, help="Directory for labeled views (requires --labels)")
    p.add_argument("--views", default=None, help="Comma-separated subset of iso,front,right,top")
    p.set_defaults(func=inspection.cmd_inspect_surfaces)

    p = sub.add_parser("present", help="Validate, preview, generate, or run a spec-driven presentation")
    p.add_argument("stage", choices=("validate", "preview", "generate", "run"))
    p.add_argument("--spec", required=True)
    p.add_argument("--output-dir", required=True)
    p.set_defaults(func=presentation.cmd_present)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print('{"ok":false,"tool":"cadctl","payload":{"error":"interrupted"}}', file=sys.stderr)
        return 130
