"""DFM spike E0-c: the cut diameter of a FreeCAD threaded hole, M2 to M12.

Not a test. Run it with the FreeCAD environment's Python:

    E=~/.local/share/pi-cad/runtimes/freecad/env
    PYTHONPATH=python:$E/lib $E/bin/python tests/freecad/dfm_spike_e0c.py [--json out.json]

For each size it builds a 40 x 30 x 10 mm plate with one blind hole (depth 7.5 mm)
through the real ``hole`` op with ``thread``, in two ways:

* ``diameter`` = the nominal size (what a naive agent writes);
* ``diameter`` = the 铨洲 tap drill (what the conclusion recommends).

Then it measures the cut diameter from the solid: the section at mid depth
(z = 6 mm, inside the hole) is sliced and the distances of its inner loop from
the hole axis are measured. For ``ModelThread`` = true (M3 only) the same
measurement applies to the modelled thread, which reports a minor and a major
diameter.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

import FreeCAD  # noqa: E402
import Part  # noqa: E402

from reify_freecad.core import bodies  # noqa: E402
from reify_freecad.worker import Worker  # noqa: E402

# 铨洲 v8.14 p.1 tap drill table (tables.tap_drill_mm in the rulepack).
TAP_DRILL = {"M2": 1.6, "M2.5": 2.05, "M3": 2.5, "M4": 3.3, "M5": 4.2, "M6": 5.0, "M8": 6.8, "M10": 8.5, "M12": 10.2}
NOMINAL = {"M2": 2.0, "M2.5": 2.5, "M3": 3.0, "M4": 4.0, "M5": 5.0, "M6": 6.0, "M8": 8.0, "M10": 10.0, "M12": 12.0}
PLATE = (40.0, 30.0, 10.0)
DEPTH = 7.5
MEASURE_Z = PLATE[2] - DEPTH / 2  # mid depth of the hole


def fmt(value: float) -> str:
    return f"{value:g}"


def inner_loop_radii(shape: Any, z: float) -> tuple[float, float]:
    """Min and max distance from the hole axis (0, 0) of the innermost loop of a section at z."""
    wires = shape.slice(FreeCAD.Vector(0, 0, 1), z)
    loops = [w for w in wires if w.isClosed()]
    if not loops:
        raise RuntimeError(f"no closed section at z={z}")
    inner = min(loops, key=lambda w: w.BoundBox.DiagonalLength)
    points = inner.discretize(Number=720)
    radii = [math.hypot(p.x, p.y) for p in points]
    return min(radii), max(radii)


def build(size: str, diameter: float, model_thread: bool) -> tuple[Any, float]:
    """Return (body shape, Diameter property actually stored) for one hole."""
    root = Path(tempfile.mkdtemp(prefix="reify-e0c-"))
    doc = str(root / "parts" / "e0c.FCStd")
    worker = Worker()
    try:
        def call(op: str, **args: Any) -> dict[str, Any]:
            response = worker.handle({"id": 1, "op": op, "doc": doc, "args": args, "budgetS": 120})
            if not response["ok"]:
                raise RuntimeError(f"{op} failed: {response['error']}")
            return response["result"]

        call("open", output=str(root / "build" / "e0c.step"), historyDir=str(root / ".h"), body="e0c", create=True)
        width, depth, thickness = PLATE
        call(
            "apply",
            ops=[
                {"op": "sketch", "name": "e0c/profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [width, depth]}}]},
                {"op": "pad", "name": "e0c/base", "sketch": "e0c/profile", "length": thickness},
                {"op": "sketch", "name": "e0c/hole_profile", "on": {"feature": "e0c/base", "role": "top"},
                 "shapes": [{"circle": {"center": [0, 0], "diameter": diameter}}]},
                {"op": "hole", "name": "e0c/tap", "sketch": "e0c/hole_profile", "diameter": diameter,
                 "depth": DEPTH, "thread": size},
            ],
        )
        session = worker.sessions[doc]
        hole = next(o for o in session.doc.Objects if o.TypeId == "PartDesign::Hole")
        if model_thread:
            hole.ModelThread = True
            session.recompute()
        stored = float(hole.Diameter.Value)
        body = next(b for b in bodies(session.doc) if b.Label == "e0c" or b.Name == "e0c")
        return body.Shape, stored
    finally:
        worker.cmd_close(doc, {})
        shutil.rmtree(root, ignore_errors=True)


def measure(size: str, diameter: float, model_thread: bool) -> dict[str, Any]:
    shape, stored = build(size, diameter, model_thread)
    if not shape.isValid() or len(shape.Solids) != 1:
        raise RuntimeError(f"{size}: result is not one valid solid")
    low, high = inner_loop_radii(shape, MEASURE_Z)
    return {
        "size": size,
        "model_thread": model_thread,
        "diameter_arg": fmt(diameter),
        "freecad_diameter": fmt(stored),
        "cut_min_mm": round(2 * low, 4),
        "cut_max_mm": round(2 * high, 4),
    }


def run() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for size, tap in TAP_DRILL.items():
        for label, diameter in (("tap", tap), ("nominal", NOMINAL[size])):
            row = measure(size, diameter, model_thread=False)
            row["variant"] = label
            row["tap_drill_mm"] = tap
            row["difference_mm"] = round(row["cut_min_mm"] - tap, 4)
            rows.append(row)
    row = measure("M3", TAP_DRILL["M3"], model_thread=True)
    row["variant"] = "tap, model_thread"
    row["tap_drill_mm"] = TAP_DRILL["M3"]
    row["difference_mm"] = round(row["cut_min_mm"] - TAP_DRILL["M3"], 4)
    rows.append(row)
    return rows


def markdown(rows: list[dict[str, Any]]) -> str:
    lines = [
        "| size | variant | Diameter arg (mm) | FreeCAD Diameter (mm) | measured cut min (mm) | measured cut max (mm) | 铨洲 tap drill (mm) | min - tap drill (mm) |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['size']} | {r['variant']} | {r['diameter_arg']} | {r['freecad_diameter']} | "
            f"{r['cut_min_mm']:.3f} | {r['cut_max_mm']:.3f} | {r['tap_drill_mm']} | {r['difference_mm']:+.3f} |"
        )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--json", type=Path, help="also write the rows as JSON to this path")
    args = parser.parse_args()
    rows = run()
    print(markdown(rows))
    if args.json:
        args.json.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
