from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path.cwd()
INPUTS = ROOT / ".ignored-benchmark-inputs"
REQUIRED = [
    INPUTS / "domain.step",
    INPUTS / "materials.json",
    INPUTS / "surface-mapping.json",
    INPUTS / "rev1-spec-pack" / "release-criteria.json",
]
missing = [str(path.relative_to(ROOT)) for path in REQUIRED if not path.exists()]
status = ROOT / "spec04-status.json"
if missing:
    status.write_text(json.dumps({
        "schema": 1,
        "status": "blocked_external",
        "missing": missing,
        "releaseVerdict": None,
        "note": "Authoritative inputs are required; SIMULATION_RELEASE_PASS was not generated.",
    }, indent=2), encoding="utf-8")
    raise SystemExit(42)

mapping = json.loads((INPUTS / "surface-mapping.json").read_text(encoding="utf-8"))
materials = json.loads((INPUTS / "materials.json").read_text(encoding="utf-8"))
patches = mapping.get("patches", {})
for key in ("inlet", "vent", "walls", "plugSurface"):
    if key not in patches:
        raise RuntimeError(f"surface-mapping.json patches missing {key}")
for key in ("liquid", "gas", "plugEquivalent"):
    if key not in materials:
        raise RuntimeError(f"materials.json missing {key}")

stages = [
    {"id": "stage-i-injection", "mode": "injection"},
    {"id": "stage-ii-plug-pulse", "mode": "equivalent_plug_pulse"},
    {"id": "stage-ii-relaxation", "mode": "no_flow_relaxation"},
]
levels = ["coarse", "nominal", "fine"]
robustness = ["low", "nominal", "high"]
for level in levels:
    for perturbation in robustness:
        subprocess.run([
            sys.executable,
            str(ROOT / "case_driver.py"),
            "--inputs", str(INPUTS),
            "--output", str(ROOT / "runs" / level / perturbation),
            "--mesh", level,
            "--robustness", perturbation,
        ], cwd=ROOT, check=True)
subprocess.run([
    sys.executable,
    str(ROOT / "aggregate_results.py"),
    "--runs", str(ROOT / "runs"),
    "--criteria", str(INPUTS / "rev1-spec-pack" / "release-criteria.json"),
    "--output", str(ROOT / "results"),
], cwd=ROOT, check=True)
status.write_text(json.dumps({"schema": 1, "status": "computed", "stages": stages, "meshLevels": levels, "robustness": robustness, "releaseVerdict": None}, indent=2), encoding="utf-8")
