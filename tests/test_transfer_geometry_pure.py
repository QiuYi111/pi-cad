"""Pure tests for reify_freecad.transfer_geometry (no FreeCAD)."""

from __future__ import annotations

import ast
import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from reify_freecad import transfer_geometry as tg  # noqa: E402


def line(i, a, b):
    return {"id": i, "type": "line", "start": list(a), "end": list(b)}


def circle(i, c, r):
    return {"id": i, "type": "circle", "center": list(c), "radius": r}


def arc(i, c, r, a0, a1):
    a, b = math.radians(a0), math.radians(a1)
    return {"id": i, "type": "arc", "center": list(c), "radius": r, "start_angle": a0, "end_angle": a1,
            "start": [c[0] + r * math.cos(a), c[1] + r * math.sin(a)], "end": [c[0] + r * math.cos(b), c[1] + r * math.sin(b)]}


def rect(first, x0, y0, x1, y1):
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return [line(first + i, pts[i], pts[(i + 1) % 4]) for i in range(4)]


class LoopTests(unittest.TestCase):
    def test_rectangle_with_unordered_lines(self):
        g = rect(0, 0, 0, 40, 30)
        g = [g[2], g[0], g[3], g[1]]
        for k, item in enumerate(g):
            item["id"] = k
        loops = tg.analyse_sketch(g)
        self.assertEqual(len(loops), 1)
        self.assertEqual(sorted(loops[0]["geometry"]), [0, 1, 2, 3])
        self.assertAlmostEqual(loops[0]["area"], 1200.0)
        self.assertEqual(loops[0]["depth"], 0)

    def test_hole_and_island_depths(self):
        g = rect(0, -20, -20, 20, 20) + [circle(4, (0, 0), 10), circle(5, (0, 0), 4)]
        loops = {l["id"]: l for l in tg.analyse_sketch(g)}
        depths = sorted(l["depth"] for l in loops.values())
        self.assertEqual(depths, [0, 1, 2])
        self.assertAlmostEqual(next(l for l in loops.values() if l["depth"] == 2)["area"], math.pi * 16)

    def test_slot_with_arcs_area(self):
        g = [line(0, (0, -2), (10, -2)), arc(1, (10, 0), 2, -90, 90), line(2, (10, 2), (0, 2)), arc(3, (0, 0), 2, 90, 270)]
        loops = tg.analyse_sketch(g)
        self.assertEqual(len(loops), 1)
        self.assertAlmostEqual(loops[0]["area"], 40 + math.pi * 4, places=9)

    def test_arc_reversed_in_chain(self):
        g = [line(0, (0, 0), (10, 0)), line(1, (10, 5), (10, 0)), arc(2, (5, 5), 5, 0, 180) | {}, line(3, (0, 5), (0, 0))]
        # arc from (10,5) ccw to (0,5); line 1 runs (10,5)->(10,0) i.e. reversed w.r.t. the walk
        loops = tg.analyse_sketch(g)
        self.assertAlmostEqual(loops[0]["area"], 50 + math.pi * 25 / 2, places=9)

    def test_open_loop_is_rejected(self):
        g = rect(0, 0, 0, 10, 10)[:3]
        with self.assertRaises(tg.LoopError) as raised:
            tg.analyse_sketch(g)
        self.assertEqual(raised.exception.reason, "open_loop")

    def test_non_strict_drops_open_chains(self):
        g = rect(0, 0, 0, 10, 10)[:3] + [circle(9, (50, 50), 2)]
        self.assertEqual(len(tg.analyse_sketch(g, strict=False)), 1)

    def test_intersecting_circles(self):
        with self.assertRaises(tg.LoopError) as raised:
            tg.analyse_sketch([circle(0, (0, 0), 5), circle(1, (6, 0), 5)])
        self.assertEqual(raised.exception.reason, "intersecting_loops")

    def test_touching_circles_and_tangent_inside(self):
        for second in (circle(1, (10, 0), 5), circle(1, (2, 0), 3)):
            with self.subTest(second=second), self.assertRaises(tg.LoopError) as raised:
                tg.analyse_sketch([circle(0, (0, 0), 5), second])
            self.assertEqual(raised.exception.reason, "touching_loops")

    def test_circle_crossing_rectangle(self):
        with self.assertRaises(tg.LoopError):
            tg.analyse_sketch(rect(0, 0, 0, 10, 10) + [circle(4, (10, 5), 3)])

    def test_loops_sharing_a_corner_touch(self):
        g = rect(0, 0, 0, 10, 10) + rect(4, 10, 10, 20, 20)
        with self.assertRaises(tg.LoopError) as raised:
            tg.analyse_sketch(g)
        self.assertEqual(raised.exception.reason, "touching_loops")

    def test_bowtie_self_intersection(self):
        g = [line(0, (0, 0), (10, 10)), line(1, (10, 10), (10, 0)), line(2, (10, 0), (0, 10)), line(3, (0, 10), (0, 0))]
        with self.assertRaises(tg.LoopError) as raised:
            tg.analyse_sketch(g)
        self.assertEqual(raised.exception.reason, "self_intersecting_loop")

    def test_separate_islands_have_depth_zero(self):
        g = [circle(0, (0, 0), 2), circle(1, (10, 0), 2)]
        self.assertEqual([l["depth"] for l in tg.analyse_sketch(g)], [0, 0])

    def test_ray_cast_with_arcs(self):
        # a D shape (half disc) containing a small circle; another circle outside the arc
        g = [line(0, (0, -10), (0, 10)), arc(1, (0, 0), 10, -90, 90), circle(2, (5, 0), 1), circle(3, (-5, 0), 1)]
        depths = {l["geometry"][0]: l["depth"] for l in tg.analyse_sketch(g)}
        self.assertEqual((depths[0], depths[2], depths[3]), (0, 1, 0))


class PlaneTests(unittest.TestCase):
    def test_bases_and_offsets(self):
        cases = [
            ({"origin": [1, 2, 3], "u": [1, 0, 0], "v": [0, 1, 0], "n": [0, 0, 1]}, "XY", 3),
            ({"origin": [1, 2, 3], "u": [1, 0, 0], "v": [0, 0, 1], "n": [0, -1, 0]}, "XZ", 2),
            ({"origin": [1, 2, 3], "u": [0, 1, 0], "v": [0, 0, 1], "n": [1, 0, 0]}, "YZ", 1),
            ({"origin": [0, 0, -7], "u": [0, 1, 0], "v": [1, 0, 0], "n": [0, 0, -1]}, "XY", -7),
        ]
        for frame, base, offset in cases:
            with self.subTest(base=base):
                self.assertEqual(tg.detect_plane(frame), {"base": base, "offset": offset})

    def test_tilted_is_rejected(self):
        s = math.sqrt(0.5)
        self.assertIsNone(tg.detect_plane({"origin": [0, 0, 0], "u": [1, 0, 0], "v": [0, s, s], "n": [0, -s, s]}))


class ExpressionTests(unittest.TestCase):
    def test_cleanup(self):
        cases = [
            ("Params.width / 2", "mm", "=width/2"),
            ("Params.width / 10 + 1 mm", "mm", "=width/10 + 1"),
            ("Params.width - 3 mm", "mm", "=width - 3"),
            ("Params.ang * 4", "deg", "=ang*4"),
            ("(Params.a + 2 mm) * 3", "mm", "=(a + 2)*3"),
            ("Params.a + 2 cm", "mm", "=a + 2 cm"),
            ("Params.a * 2 mm", None, "=a*2 mm"),
            ("Params.hole_d", "mm", "=hole_d"),
            ("1 * Params.width", "mm", "=width"),
            ("1 * 0 mm + -0.5 * Params.width", "mm", "=-0.5*width"),
            ("2 * Params.a + 1 * Params.b", "mm", "=2*a + b"),
        ]
        for text, unit, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(tg.clean_expression(text, unit), expected)


class PurityTests(unittest.TestCase):
    def test_no_freecad_import(self):
        tree = ast.parse((ROOT / "python" / "reify_freecad" / "transfer_geometry.py").read_text())
        names = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        names |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        self.assertFalse(names & {"FreeCAD", "Part", "Sketcher", "App"})


if __name__ == "__main__":
    unittest.main()
