"""Executable build123d part template. Units: millimetres."""
from pathlib import Path
import os

from build123d import Box, Cylinder, Pos, export_step


WIDTH = 100.0
DEPTH = 80.0
THICKNESS = 5.0
HOLE_DIAMETER = 6.0
EDGE_OFFSET = 10.0


def build():
    if min(WIDTH, DEPTH, THICKNESS, HOLE_DIAMETER, EDGE_OFFSET) <= 0:
        raise ValueError("all dimensions must be positive")
    if 2 * EDGE_OFFSET >= min(WIDTH, DEPTH):
        raise ValueError("edge offset collapses the hole pattern")
    plate = Box(WIDTH, DEPTH, THICKNESS)
    x = WIDTH / 2 - EDGE_OFFSET
    y = DEPTH / 2 - EDGE_OFFSET
    cutters = [Pos(dx, dy, 0) * Cylinder(HOLE_DIAMETER / 2, THICKNESS * 3) for dx in (-x, x) for dy in (-y, y)]
    holes = cutters[0].fuse(*cutters[1:])
    return plate - holes


if __name__ == "__main__":
    output = Path(os.environ.get("PI_CAD_OUTPUT", "part.step"))
    output.parent.mkdir(parents=True, exist_ok=True)
    export_step(build(), output)
