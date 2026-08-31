#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from build123d import import_step


def vec(value):
    return [round(float(value.X), 6), round(float(value.Y), 6), round(float(value.Z), 6)]


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: desktop-export-mesh.py model.step")
    path = Path(sys.argv[1]).resolve()
    shape = import_step(path)
    bounds = shape.bounding_box()
    diagonal = math.sqrt(bounds.size.X**2 + bounds.size.Y**2 + bounds.size.Z**2)
    tolerance = max(0.03, min(0.35, diagonal / 700))
    solids = list(shape.solids()) or [shape]
    palette = ["#d7d9dc", "#bfc5cc", "#929aa4", "#e6e7e9", "#aab3be", "#cfd4da"]
    parts = []
    for index, solid in enumerate(solids):
        vertices, triangles = solid.tessellate(tolerance, 0.12)
        parts.append({
            "name": f"Solid {index + 1}",
            "positions": [coordinate for vertex in vertices for coordinate in vec(vertex)],
            "indices": [coordinate for triangle in triangles for coordinate in triangle],
            "color": palette[index % len(palette)],
        })
    payload = {
        "source": str(path),
        "parts": parts,
        "bounds": {"min": vec(bounds.min), "max": vec(bounds.max)},
    }
    json.dump(payload, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
