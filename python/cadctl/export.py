from __future__ import annotations

from pathlib import Path
from typing import Any

import build123d as bd

from .model import run_source


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
) -> dict[str, Any]:
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    cwd_path = Path(cwd) if cwd else Path.cwd()
    shape, source_info = _load_shape(source, cwd_path)
    fmt = format.lower()
    if fmt in {"step", "stp"}:
        bd.export_step(shape, str(output))
    elif fmt == "stl":
        bd.export_stl(shape, str(output))
    elif fmt in {"glb", "gltf"}:
        bd.export_gltf(shape, str(output))
    elif fmt == "brep":
        bd.export_brep(shape, str(output))
    else:
        raise ValueError(f"unsupported export format: {format}; V0 backend supports step, stl, glb, brep")
    return {
        "source": str(source),
        "format": fmt,
        "output": str(output),
        "sourceKind": source_info["kind"],
        "manifest": {
            "source": str(source),
            "format": fmt,
            "output": str(output),
        },
    }
