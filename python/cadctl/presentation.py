from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any


def validate_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not spec.get("artifact"):
        errors.append("artifact is required")
    if not spec.get("directions") or len(spec.get("directions", [])) < 2:
        errors.append("at least two reference-backed visual directions are required")
    if not spec.get("materials"):
        errors.append("materials are required")
    if not spec.get("lighting"):
        errors.append("lighting is required")
    if not spec.get("camera"):
        errors.append("camera is required")
    return not errors, errors


def run_presentation(spec_path: str | Path, output_dir: str | Path, stage: str = "generate") -> dict[str, Any]:
    spec_path = Path(spec_path)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    ok, errors = validate_spec(spec)
    if not ok:
        raise ValueError("; ".join(errors))
    if stage == "validate":
        return {"status": "validated", "spec": str(spec_path), "errors": []}

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    scene_path = output_dir / "scene.json"
    scene_path.write_text(
        json.dumps(
            {
                "status": "script-generated",
                "spec": str(spec_path),
                "renderer": "blender-4.5-lts",
                "notes": "Deterministic scene script. Run requires Blender and FFmpeg; generated without them.",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    if stage == "generate":
        return {
            "status": "script-generated",
            "outputs": [str(scene_path)],
            "reason": "Blender run is optional and unavailable when blender/ffmpeg are not installed",
        }
    if not (shutil.which("blender") and shutil.which("ffmpeg")):
        return {
            "status": "unavailable",
            "outputs": [str(scene_path)],
            "reason": "blender/ffmpeg are not installed; capability presentation.run is unavailable",
            "capability": {"blender": shutil.which("blender"), "ffmpeg": shutil.which("ffmpeg")},
        }
    raise RuntimeError("blender present but integration not bundled in this build")
