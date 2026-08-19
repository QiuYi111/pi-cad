from __future__ import annotations

import importlib
import json
import shutil
import sys
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


def doctor() -> dict[str, Any]:
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
            "simulation": _torch_fem_status(),
            "thermalFluid": _thermal_fluid_status(),
            "differentiableOptimization": _optimization_status(),
            "assembly": {"status": "ready"},
            "export": {"status": "ready"},
        },
    }


def doctor_json() -> str:
    return json.dumps(doctor(), indent=2, sort_keys=True)
