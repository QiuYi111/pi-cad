"""Thin, provenance-bound CAD to Blender mesh bridge."""
from __future__ import annotations
import json
from pathlib import Path
from .common import sha256_file
from .presentation import _tessellate_step

def prepare_blender_bundle(artifact: str | Path, output_dir: str | Path, source: str | Path | None = None) -> dict:
    artifact_path = Path(artifact).resolve()
    if artifact_path.suffix.lower() not in {".step", ".stp"}:
        raise ValueError("Blender bridge requires an authoritative STEP artifact")
    if not artifact_path.is_file():
        raise FileNotFoundError(artifact_path)
    bundle = Path(output_dir).resolve()
    meshes = _tessellate_step(artifact_path, bundle)
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    provenance = {
        "schema": 1, "artifact": str(artifact_path), "artifactSha256": sha256_file(artifact_path),
        "source": str(Path(source).resolve()) if source else None,
        "sourceSha256": sha256_file(source) if source else None,
        "meshManifest": str(manifest_path), "parts": manifest["parts"],
    }
    provenance_path = bundle / "provenance.json"
    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    return {"bundle": str(bundle), "manifest": str(manifest_path), "provenance": str(provenance_path), "meshes": [str(path) for path in meshes]}
