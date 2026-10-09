"""Rendering commands: orthographic views, section views and spec drawings."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from ..common import emit, read_json, sha256_file
from .envelope import elapsed_ms, fail, hash_or_empty


def cmd_render(args: argparse.Namespace) -> int:
    from ..render import render_views

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
            focus=json.loads(args.focus_json) if args.focus_json else None,
            hide=json.loads(args.hide_json) if args.hide_json else None,
            explode=args.explode,
            ghost_others=args.ghost_others,
            highlight=json.loads(args.highlight_json) if args.highlight_json else None,
            annotations=json.loads(args.annotations_json) if args.annotations_json else None,
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
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_inspect_visual", str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})


def cmd_section(args: argparse.Namespace) -> int:
    from ..section import render_section

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
            duration_ms=elapsed_ms(started),
        )
        return 0
    except Exception as exc:
        return fail("cad_inspect_section", str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})


def _load_spec(spec_path: str) -> Any:
    return read_json(spec_path, normalize_paths=True)


def cmd_drawing(args: argparse.Namespace) -> int:
    from ..drawing import generate_drawing, validate_drawing_spec

    started = time.monotonic()
    try:
        spec = _load_spec(args.spec)
        if args.stage == "validate":
            ok, errors = validate_drawing_spec(spec)
            payload = {"status": "validated" if ok else "invalid", "errors": errors}
            emit("cad_generate_drawing", payload, input_hashes={"spec": sha256_file(args.spec)}, duration_ms=elapsed_ms(started))
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
                duration_ms=elapsed_ms(started),
            )
        return 0
    except Exception as exc:
        return fail("cad_generate_drawing", str(exc), started=started, input_hashes={"spec": hash_or_empty(args.spec)})
