from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from cadctl.presentation import _tessellate_step


artifact = Path(sys.argv[1]).resolve()
blender = shutil.which("blender")
if not blender:
    raise RuntimeError("Blender is required for the RES-406 identity bridge smoke")
step_hash = hashlib.sha256(artifact.read_bytes()).hexdigest()
expected_occurrences = {"arm/bracket_left", "arm/bracket_right", "arm/pin_a", "arm/pin_b"}

with tempfile.TemporaryDirectory(prefix="res406-blender-bridge-") as directory:
    root = Path(directory)
    bundle = root / "mesh-bundle"
    _tessellate_step(artifact, bundle)
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    occurrences = {str(item["occurrenceId"]) for item in manifest["parts"]}
    if manifest["stepSha256"] != step_hash or not manifest["identityBound"]:
        raise AssertionError(f"Viewer manifest does not bind the current STEP: {manifest}")
    if not expected_occurrences.issubset(occurrences):
        raise AssertionError(f"Viewer manifest lost named instances: {occurrences}")

    report = root / "bridge-report.json"
    args = root / "bridge-args.json"
    args.write_text(json.dumps({
        "operation": "bridge-inspect",
        "artifact": str(artifact),
        "meshBundle": str(bundle),
        "reportPath": str(report),
    }), encoding="utf-8")
    result = subprocess.run([
        blender, "--background", "--factory-startup", "-P",
        str(Path(__file__).resolve().parents[1] / "python" / "cadctl" / "presentation_driver.py"),
        "--", str(args),
    ], capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f"Blender import failed ({result.returncode}): {result.stderr[-4000:]}")
    bridge = json.loads(report.read_text(encoding="utf-8"))["bridge"]
    bridge_occurrences = {str(item["occurrenceId"]) for item in bridge["objects"]}
    if bridge["stepSha256"] != step_hash or not expected_occurrences.issubset(bridge_occurrences):
        raise AssertionError(f"Blender bridge identity does not match the current STEP: {bridge}")
    print(json.dumps({
        "stepSha256": step_hash,
        "identityManifestSha256": manifest["identityManifestSha256"],
        "occurrences": sorted(bridge_occurrences),
        "objectCount": bridge["objectCount"],
    }))
