from __future__ import annotations

import importlib
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from . import __version__


def _module(name: str) -> bool:
    try:
        importlib.import_module(name)
        return True
    except Exception:
        return False


def _torch_fem_status() -> dict[str, Any]:
    if not _module("torch"):
        return {"status": "unavailable", "backend": None}
    try:
        from .simulation._torchfem_import import import_torchfem
        from .simulation.torch_fem_backend import resolve_device

        import_torchfem()
        info = resolve_device("auto")
        return {
            "status": "ready",
            "backend": "torch-fem",
            "devices": {
                "cpu": True,
                "cuda": info.cudaAvailable,
                "cupy": info.cupyAvailable,
                "mps": False,
                "mpsHardware": info.mpsAvailable,
            },
            "requestedDevice": info.requested,
            "actualDevice": info.actual,
            "dtype": info.dtype,
            "fallbackReason": info.fallbackReason,
        }
    except Exception as exc:
        return {"status": "error", "backend": "torch-fem", "error": str(exc)}


def _optimization_status() -> dict[str, Any]:
    sim = _torch_fem_status()
    nlopt = _module("nlopt")
    return {
        "status": "ready" if sim.get("status") == "ready" and nlopt else "unavailable",
        "modes": ["topology"] if sim.get("status") == "ready" and nlopt else [],
        "nlopt": nlopt,
    }


def _thermal_fluid_status() -> dict[str, Any]:
    try:
        from .simulation.su2_backend import su2_status

        status = su2_status()
    except Exception as exc:
        return {"status": "error", "backend": "su2", "error": str(exc)}
    gmsh_ready = _module("gmsh") and _module("pyvista")
    if status.get("status") == "ready" and not gmsh_ready:
        status = {
            "status": "unavailable",
            "backend": "su2",
            "reason": "SU2 is present but gmsh/pyvista meshing support is missing",
        }
    if status.get("status") == "ready":
        status["modes"] = [
            "compressible_euler",
            "compressible_rans",
            "incompressible_ns",
            "incompressible_rans",
            "solid_heat",
        ]
    return status


def _presentation_status() -> dict[str, Any]:
    """Blender+FFmpeg presentation capability (optional, fail-soft)."""
    import shutil as _shutil

    from .presentation import blender_binary

    binary, source = blender_binary()
    ffmpeg = _shutil.which("ffmpeg")
    if binary and ffmpeg:
        return {"status": "ready", "blender": source, "ffmpeg": ffmpeg}
    missing = []
    if not binary:
        missing.append("blender")
    if not ffmpeg:
        missing.append("ffmpeg")
    return {"status": "unavailable", "missing": missing, "blender": source}


def _managed_runtime_catalog() -> dict[str, Any]:
    registry_path = Path(__file__).resolve().parents[2] / "assets" / "simulation-runtimes.json"
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        if registry.get("schema") != 2 or not isinstance(registry.get("runtimes"), list):
            raise ValueError("expected runtime registry schema 2")
        runtimes = [
            {
                "backend": item["backend"],
                "runtime": item["runtime"],
                "kind": item["kind"],
                "accelerator": item.get("accelerator", "none"),
                "developmentOnly": bool(item.get("developmentOnly", False)),
            }
            for item in registry["runtimes"]
        ]
        return {
            "status": "configured",
            "registrySchema": 2,
            "runtimes": runtimes,
            "note": "availability is verified by the managed launcher against immutable /opt roots",
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc), "registry": str(registry_path)}


def doctor() -> dict[str, Any]:
    managed = _managed_runtime_catalog()
    return {
        "package": "pi-cad",
        "packageVersion": __version__,
        "python": sys.executable,
        "capabilities": {
            "geometry": {
                "status": "ready" if _module("build123d") and _module("OCP") else "unavailable",
            },
            "visual": {
                "status": "ready" if _module("PIL") and _module("numpy") else "unavailable",
            },
            "drawing": {
                "status": "ready" if _module("ezdxf") else "unavailable",
            },
            "simulation": managed,
            "thermalFluid": managed,
            "differentiableOptimization": {
                "status": "managed",
                "backend": "torch-fem",
                "runtime": "torch-fem-0.9-cu126",
                "fallback": "forbidden",
            },
            "assembly": {"status": "ready"},
            "export": {"status": "ready"},
            "presentation": _presentation_status(),
        },
        "hostDevelopmentPython": {
            "simulation": _torch_fem_status(),
            "thermalFluid": _thermal_fluid_status(),
            "optimization": _optimization_status(),
            "note": "diagnostic only; public simulation and optimization never execute in this host environment",
        },
    }


def doctor_json() -> str:
    return json.dumps(doctor(), indent=2, sort_keys=True)
