from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any


def validate_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not spec.get("artifact"):
        errors.append("artifact is required")
    if not spec.get("solver"):
        errors.append("solver is required")
    if not spec.get("analysis"):
        errors.append("analysis is required")
    for section in ("materials", "loads", "constraints", "mesh"):
        if not spec.get(section):
            errors.append(f"{section} is required")
    return not errors, errors


def solver_available() -> bool:
    try:
        import gmsh  # noqa: F401
        import pyvista  # noqa: F401
    except Exception:
        return False
    return shutil.which("ccx") is not None


def run_simulation(spec_path: str | Path, output_dir: str | Path, stage: str = "run") -> dict[str, Any]:
    spec_path = Path(spec_path)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    ok, errors = validate_spec(spec)
    if not ok:
        raise ValueError("; ".join(errors))
    if stage == "validate":
        return {"status": "validated", "spec": str(spec_path), "errors": []}

    available = solver_available()
    if not available:
        return {
            "status": "unavailable",
            "spec": str(spec_path),
            "reason": "gmsh/pyvista/CalculiX backend is not installed; capability simulation.run is unavailable",
            "capability": {
                "gmsh": bool(shutil.which("ccx") or False),
                "ccx": shutil.which("ccx"),
            },
        }
    # The deterministic backend intentionally does not invent a substitute
    # solver here. A real solver integration stays behind the same spec.
    raise RuntimeError("solver present but integration not bundled in this build")
