from __future__ import annotations

import shutil
from typing import Any


def _module(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def capabilities() -> dict[str, Any]:
    return {
        "geometry": {
            "build123d": _module("build123d"),
            "ocp": _module("OCP"),
            "step": True,
        },
        "visual": {
            "pillow": _module("PIL"),
            "numpy": _module("numpy"),
            "views": True,
            "sections": True,
        },
        "compare": {"step_diff": True},
        "assembly": {"occurrence_tree": True},
        "export": {"step": True, "stl": True, "glb": True, "brep": True, "3mf": False, "dxf": True},
        "drawing": {
            "dxf": _module("ezdxf"),
            "svg": True,
            "pdf": False,
            "gd_and_t": "structured_text_only",
        },
        "simulation": {
            "prepare": _module("gmsh") and _module("pyvista"),
            "run": _module("gmsh") and _module("pyvista") and shutil.which("ccx") is not None,
            "calculix": shutil.which("ccx"),
        },
        "presentation": {
            "generate": True,
            "run": shutil.which("blender") is not None and shutil.which("ffmpeg") is not None,
            "blender": shutil.which("blender"),
            "ffmpeg": shutil.which("ffmpeg"),
        },
    }
