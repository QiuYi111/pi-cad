"""Release presentation interpreter (0.8 M4b, whitepaper section 11).

Blender is a pinned optional runtime, exactly like SU2: PATH first, then
the manifest-installed runtime under .runtime/blender/<version>/, and a
fail-soft "unavailable" status when neither exists. The interpreter is a
compiler target — it consumes a canonical PresentationSpec and the
Assembly Definition (from the assembly_design record) and produces:

    hero.png  exploded.png  turntable.mp4  assembly.mp4
    presentation.blend  manifest.json

The manifest binds the subject artifact hash, spec hash, Blender version,
renderer settings, and every output sha256. Nothing here judges aesthetic
quality; directions/materials/lighting/camera are the Agent's semantic
choices carried through verbatim.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .common import sha256_file

_SPEC_KEYS = {
    "artifact",
    "directions",
    "materials",
    "lighting",
    "camera",
    "assemblyDefinition",
    "resolution",
    "fps",
    "outputs",
}

_ASSEMBLY_KEYS = {"sequence", "modules", "explodeDirections"}

# Quality presets: preview is for Agent inspection, run is the release
# render. Both are deterministic (fixed seed, fixed samples).
_STAGES = {
    "preview": {"samples": 16, "turntableFrames": 12, "assemblyFrames": 12, "label": "preview"},
    "run": {"samples": 96, "turntableFrames": 96, "assemblyFrames": 72, "label": "final"},
}


def _reject_unknown(value: Any, allowed: set[str], where: str, errors: list[str]) -> None:
    if isinstance(value, dict):
        unknown = sorted(set(value) - allowed)
        if unknown:
            errors.append(f"{where} has unknown keys {unknown}; allowed keys are {sorted(allowed)}")


def validate_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(spec, dict):
        return False, ["spec must be an object"]
    _reject_unknown(spec, _SPEC_KEYS, "spec", errors)

    artifact = spec.get("artifact")
    if not isinstance(artifact, str) or not artifact.strip():
        errors.append("artifact is required")
    elif not Path(artifact).is_file():
        errors.append(f"artifact does not exist: {artifact}")
    elif Path(artifact).suffix.lower() not in (".step", ".stp", ".glb", ".gltf"):
        errors.append("artifact must be .step/.stp/.glb/.gltf in V1")

    directions = spec.get("directions")
    if not isinstance(directions, list) or len(directions) < 2:
        errors.append("at least two reference-backed visual directions are required")
    else:
        for direction in directions:
            _reject_unknown(direction, {"name", "reference"}, "directions[]", errors)
            if not isinstance(direction, dict) or not str(direction.get("name", "")).strip():
                errors.append("directions[].name is required")
            reference = direction.get("reference") if isinstance(direction, dict) else None
            if not isinstance(reference, str) or not Path(reference).is_file():
                errors.append("directions[].reference must be an existing reference image path")

    materials = spec.get("materials")
    if not isinstance(materials, list) or not materials:
        errors.append("materials are required")
    else:
        for material in materials:
            _reject_unknown(material, {"pattern", "family"}, "materials[]", errors)

    for key in ("lighting", "camera"):
        value = spec.get(key)
        if not isinstance(value, dict) or not value:
            errors.append(f"{key} is required")
        else:
            allowed = {"key", "fill", "rim"} if key == "lighting" else {"lens", "composition"}
            _reject_unknown(value, allowed, key, errors)

    assembly = spec.get("assemblyDefinition")
    if assembly is not None:
        if not isinstance(assembly, dict):
            errors.append("assemblyDefinition must be an object")
        else:
            _reject_unknown(assembly, _ASSEMBLY_KEYS, "assemblyDefinition", errors)
            sequence = assembly.get("sequence")
            if not isinstance(sequence, list) or not sequence:
                errors.append("assemblyDefinition.sequence is required for assembly animations")
            explode = assembly.get("explodeDirections")
            if explode is not None:
                if not isinstance(explode, dict):
                    errors.append("assemblyDefinition.explodeDirections must map module -> [x,y,z]")
                else:
                    for name, vector in explode.items():
                        if not isinstance(vector, list) or len(vector) != 3 or not all(
                            isinstance(v, (int, float)) for v in vector
                        ):
                            errors.append(f"explodeDirections[{name}] must be a 3-vector")

    resolution = spec.get("resolution")
    if resolution is not None:
        _reject_unknown(resolution, {"width", "height"}, "resolution", errors)
        if not isinstance(resolution, dict) or not (
            isinstance(resolution.get("width"), int) and isinstance(resolution.get("height"), int)
        ):
            errors.append("resolution must be {width, height} integers")
        elif resolution["width"] <= 0 or resolution["height"] <= 0:
            errors.append("resolution dimensions must be positive")

    fps = spec.get("fps")
    if fps is not None and (not isinstance(fps, int) or fps <= 0):
        errors.append("fps must be a positive integer")

    outputs = spec.get("outputs")
    if outputs is not None:
        _reject_unknown(outputs, {"hero", "exploded", "turntable", "assembly"}, "outputs", errors)

    return not errors, errors


def _tessellate_step(artifact: Path, bundle_dir: Path) -> list[Path]:
    """Deterministically tessellate each world-positioned solid of a STEP
    into its own ASCII STL (fixed tolerance from the bounding sphere).

    Like SU2 meshing, this is the interpreter compiling the canonical
    artifact into the renderer's world; the STEP stays the evidence
    subject. Blender never sees the STEP directly.
    """
    import build123d as bd

    bundle_dir.mkdir(parents=True, exist_ok=True)
    shape = bd.import_step(artifact)
    solids = list(shape.solids())
    if not solids:
        raise ValueError("artifact contains no solids to present")
    all_bb = shape.bounding_box()
    diag = (all_bb.size.X + all_bb.size.Y + all_bb.size.Z) or 1.0
    tolerance = max(diag * 1e-4, 1e-4)
    angular = 0.3
    paths: list[Path] = []
    for index, solid in enumerate(solids):
        vertices, triangles = solid.tessellate(tolerance, angular)
        path = bundle_dir / f"part-{index:04d}.stl"
        lines = [f"solid pi-cad-part-{index:04d}"]
        for triangle in triangles:
            # Compute the face normal from the triangle itself.
            a, b, c = (vertices[i] for i in triangle)
            u = (b.X - a.X, b.Y - a.Y, b.Z - a.Z)
            v = (c.X - a.X, c.Y - a.Y, c.Z - a.Z)
            normal = (
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            )
            length = (normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2) ** 0.5 or 1.0
            normal = tuple(n / length for n in normal)
            lines.append(f"  facet normal {normal[0]:.6e} {normal[1]:.6e} {normal[2]:.6e}")
            lines.append("    outer loop")
            for vertex in (a, b, c):
                lines.append(f"      vertex {vertex.X:.6e} {vertex.Y:.6e} {vertex.Z:.6e}")
            lines.append("    endloop")
            lines.append("  endfacet")
        lines.append(f"endsolid pi-cad-part-{index:04d}")
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        paths.append(path)
    return paths


def blender_binary() -> tuple[str | None, str]:
    """Resolve the pinned Blender runtime: env override, PATH, then the
    manifest-installed runtime directory. Returns (path, version-label)."""
    override = os.environ.get("PI_CAD_BLENDER_BIN")
    if override:
        return (override, "pinned-override") if Path(override).exists() else (None, "override-missing")
    on_path = shutil.which("blender")
    if on_path:
        return on_path, "path"
    for runtime_dir in sorted(Path(".runtime/blender").glob("*/")) if Path(".runtime/blender").exists() else []:
        candidate = runtime_dir / "blender"
        if candidate.exists():
            return str(candidate), runtime_dir.name
    return None, "missing"


def _blender_version(binary: str) -> str:
    try:
        result = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, timeout=60,
            env={**os.environ, "OMP_NUM_THREADS": "1"},
        )
        match = re.search(r"Blender ([0-9.]+)", result.stdout or "")
        return match.group(1) if match else "unknown"
    except Exception:
        return "unknown"


def _encode_video(frames_dir: Path, output: Path, fps: int) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    command = [
        ffmpeg,
        "-y",
        "-framerate",
        str(fps),
        "-i",
        str(frames_dir / "frame_%04d.png"),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=600)
    return result.returncode == 0 and output.exists()


def run_presentation(
    spec_path: str | Path,
    output_dir: str | Path,
    stage: str = "generate",
) -> dict[str, Any]:
    spec_path = Path(spec_path)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    ok, errors = validate_spec(spec)
    if not ok:
        raise ValueError("; ".join(errors))

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    spec_hash = sha256_file(spec_path)
    artifact_path = Path(spec["artifact"]).resolve()
    subject_hash = sha256_file(artifact_path)

    if stage == "validate":
        return {"status": "validated", "spec": str(spec_path), "errors": []}

    binary, source = blender_binary()
    ffmpeg = shutil.which("ffmpeg")

    def scene_description(status: str, reason: str | None = None) -> dict[str, Any]:
        return {
            "status": status,
            "spec": str(spec_path),
            "artifact": str(artifact_path),
            "subjectArtifactHash": subject_hash,
            "renderer": "blender+cycles-cpu" if binary else "unavailable",
            "blender": {"binary": binary, "source": source},
            "semantic": {
                "directions": spec.get("directions", []),
                "materials": spec.get("materials", []),
                "lighting": spec.get("lighting", {}),
                "camera": spec.get("camera", {}),
            },
            "notes": [reason] if reason else [],
        }

    scene_path = output_dir / "scene.json"
    scene_path.write_text(json.dumps(scene_description("script-generated"), indent=2), encoding="utf-8")

    if stage == "generate":
        return {
            "status": "script-generated",
            "outputs": [str(scene_path)],
            "reason": "deterministic scene description written; run or preview executes Blender",
        }

    if stage not in ("preview", "run"):
        raise ValueError(f"unsupported stage: {stage}")

    if not binary or (stage == "run" and not ffmpeg):
        payload = {
            "status": "unavailable",
            "outputs": [str(scene_path)],
            "reason": (
                "blender is not installed; capability presentation is unavailable"
                if not binary
                else "ffmpeg is not installed; video encoding is unavailable"
            ),
            "capability": {"blender": binary, "ffmpeg": ffmpeg},
        }
        scene_path.write_text(json.dumps(scene_description("unavailable", payload["reason"]), indent=2), encoding="utf-8")
        return payload

    preset = _STAGES["preview" if stage == "preview" else "run"]
    resolution = spec.get("resolution") or {"width": 1280, "height": 960}
    fps = spec.get("fps") or 24
    outputs_requested = spec.get("outputs") or {
        "hero": True,
        "exploded": True,
        "turntable": True,
        "assembly": bool(spec.get("assemblyDefinition")),
    }
    assembly = spec.get("assemblyDefinition") or {}

    # STEP artifacts are compiled to a deterministic STL bundle first;
    # GLB artifacts import directly.
    mesh_bundle: str | None = None
    if artifact_path.suffix.lower() in (".step", ".stp"):
        mesh_bundle = str((output_dir / "mesh-bundle").resolve())
        _tessellate_step(artifact_path, Path(mesh_bundle))

    driver_args = {
        "artifact": str(artifact_path),
        "meshBundle": mesh_bundle,
        "outputDir": str(output_dir.resolve()),
        "reportPath": str((output_dir / "render-report.json").resolve()),
        "reportPath": str(output_dir / "render-report.json"),
        "samples": preset["samples"],
        "width": resolution["width"],
        "height": resolution["height"],
        "fps": fps,
        "turntableFrames": preset["turntableFrames"],
        "assemblyFrames": preset["assemblyFrames"],
        "hero": bool(outputs_requested.get("hero", True)),
        "exploded": bool(outputs_requested.get("exploded", True)),
        "turntable": bool(outputs_requested.get("turntable", True)),
        "assemblyAnimation": bool(outputs_requested.get("assembly", False)) and bool(assembly),
        "explodeDirections": assembly.get("explodeDirections", {}),
    }
    args_path = output_dir / "driver-args.json"
    args_path.write_text(json.dumps(driver_args, indent=2), encoding="utf-8")

    driver = Path(__file__).with_name("presentation_driver.py")
    started = time.monotonic()
    result = subprocess.run(
        [
            binary,
            "-b",
            "--factory-startup",
            "-noaudio",
            "-P",
            str(driver),
            "--",
            str(args_path),
        ],
        capture_output=True,
        text=True,
        timeout=1800,
        env={**os.environ, "OMP_NUM_THREADS": "1"},
    )
    (output_dir / "blender.log").write_text(
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}\nreturncode={result.returncode}\n",
        encoding="utf-8",
    )
    report_path = output_dir / "render-report.json"
    report: dict[str, Any] = {}
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception:
        pass
    if result.returncode != 0 or report.get("status") != "rendered":
        tail = "\n".join((result.stderr or result.stdout or "").splitlines()[-8:])
        reason = tail or f"blender driver produced no render report (rc={result.returncode})"
        return {
            "status": "failed",
            "outputs": [str(scene_path), str(output_dir / "blender.log")],
            "reason": f"blender driver failed (rc={result.returncode})\n{reason}",
        }
    manifest_outputs: dict[str, dict[str, str]] = {}
    for name, path in (report.get("rendered") or {}).items():
        if Path(path).exists():
            manifest_outputs[name] = {"path": str(path), "sha256": sha256_file(path)}
    videos: dict[str, str] = {}
    if stage == "run":
        if report.get("turntableFrames") and ffmpeg:
            video = output_dir / "turntable.mp4"
            if _encode_video(Path(report["turntableFrames"]), video, fps):
                manifest_outputs["turntable.mp4"] = {"path": str(video), "sha256": sha256_file(video)}
                videos["turntable"] = str(video)
        if report.get("assemblyFrames") and ffmpeg:
            video = output_dir / "assembly.mp4"
            if _encode_video(Path(report["assemblyFrames"]), video, fps):
                manifest_outputs["assembly.mp4"] = {"path": str(video), "sha256": sha256_file(video)}
                videos["assembly"] = str(video)
    for fixed in ("presentation.blend",):
        path = output_dir / fixed
        if path.exists():
            manifest_outputs[fixed] = {"path": str(path), "sha256": sha256_file(path)}

    manifest = {
        "schemaVersion": 1,
        "status": "rendered",
        "stage": stage,
        "subjectArtifactHash": subject_hash,
        "artifactPath": str(artifact_path),
        "specHash": spec_hash,
        "blenderVersion": _blender_version(binary),
        "renderer": "CYCLES",
        "rendererSettings": {
            "device": "CPU",
            "seed": 0,
            "samples": preset["samples"],
            "resolution": resolution,
            "fps": fps,
        },
        "semantic": {
            "directions": spec.get("directions", []),
            "materials": spec.get("materials", []),
            "lighting": spec.get("lighting", {}),
            "camera": spec.get("camera", {}),
        },
        "assemblyDefinition": assembly,
        "outputs": manifest_outputs,
        "durationMs": int((time.monotonic() - started) * 1000),
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    outputs = [str(scene_path), str(manifest_path)] + [
        entry["path"] for entry in manifest_outputs.values()
    ]
    return {
        "status": "rendered",
        "stage": stage,
        "subjectArtifactHash": subject_hash,
        "manifest": str(manifest_path),
        "outputs": outputs,
        "videos": videos,
        "blenderVersion": manifest["blenderVersion"],
        "objectCount": report.get("objectCount"),
    }
