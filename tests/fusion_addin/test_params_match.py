import math
import unittest

import _path  # noqa: F401
import edgematch
import facematch
import params


class ExprTests(unittest.TestCase):
    P = {"width": (40.0, (1, 0)), "angle": (30.0, (0, 1)), "n": (3.0, (0, 0))}

    def an(self, e):
        return params.analyze(e, self.P)

    def test_ok(self):
        v, d, s = self.an("=width/2")
        self.assertEqual((v, d, s), (20.0, (1, 0), "width / 2"))
        self.assertEqual(self.an("=(width + 5 mm) * 2")[:2], (90.0, (1, 0)))
        self.assertEqual(self.an("-0.5*width")[0], -20.0)
        self.assertEqual(self.an("angle + 15 deg")[:2], (45.0, (0, 1)))
        self.assertEqual(self.an("width*n")[0], 120.0)

    def test_bare_number_adopts_unit(self):
        v, d, s = self.an("width + 2")
        self.assertEqual((v, d, s), (42.0, (1, 0), "width + 2 mm"))

    def test_outside_grammar(self):
        for bad in ("width ^ 2", "sin(width)", "width + ", "5 inch", "foo + 1", "width width", "(width", "", "width / 0", "width + angle", "width ** 2"):
            with self.assertRaises(params.ExprError, msg=bad):
                self.an(bad)

    def test_binder_scalar(self):
        b = params.Binder([{"name": "width", "value": 40.0, "unit": "mm"}])
        self.assertEqual(b.scalar({"value": 20.0, "expr": "=width/2"}, "length", "f", "x"), (20.0, "=width/2", "width / 2"))
        # wrong value -> fallback + warning
        self.assertEqual(b.scalar({"value": 21.0, "expr": "=width/2"}, "length", "f", "x")[2], None)
        # wrong dimension -> fallback + warning
        self.assertEqual(b.scalar({"value": 40.0, "expr": "=width"}, "angle", "f", "ang")[2], None)
        self.assertEqual(len(b.warnings), 2)
        self.assertEqual(set(b.warnings[0]), {"feature", "field", "expr", "reason"})
        self.assertEqual(b.warnings[0]["feature"], "f")
        self.assertEqual(b.scalar({"value": 5.0}, "length", "f", "x"), (5.0, None, None))
        self.assertEqual(b.scalar(7, None, "f", "x"), (7.0, None, None))

    def test_binder_bind_off_and_bad_params(self):
        b = params.Binder([{"name": "width", "value": 40.0, "unit": "mm"}], bind=False)
        self.assertEqual(b.scalar({"value": 40.0, "expr": "=width"}, "length", "f", "x")[2], None)
        self.assertEqual(b.warnings, [])
        b = params.Binder([{"name": "bad name", "value": 1, "unit": "mm"}, {"name": "sin", "value": 1, "unit": ""},
                           {"name": "ok", "value": 1, "unit": "furlong"}])
        self.assertEqual(b.plan, [])
        self.assertEqual(len(b.warnings), 3)

    def test_parameter_expression(self):
        b = params.Binder([{"name": "a", "value": 10.0, "unit": "mm"}, {"name": "b", "value": 5.0, "unit": "mm", "expr": "=a/2"}])
        self.assertEqual([p["fx"] for p in b.plan], [None, "a / 2"])


class EdgeTests(unittest.TestCase):
    def cands(self):
        return [
            {"curve": "line", "midpoint": [0, -15, 5], "length": 40.0, "start": [-20, -15, 5], "end": [20, -15, 5]},
            {"curve": "line", "midpoint": [0, 15, 5], "length": 40.0, "start": [20, 15, 5], "end": [-20, 15, 5]},
            {"curve": "circle", "midpoint": [13, 0, 5], "length": 18.85, "centre": [10, 0, 5], "radius": 3.0, "axis": [0, 0, -1]},
            {"curve": "arc", "midpoint": [13, 0, 5], "length": 18.85},
        ]

    def test_unique_match(self):
        ref = {"curve": "line", "midpoint": [0, 15, 5], "length": 40.0, "start": [-20, 15, 5], "end": [20, 15, 5]}
        self.assertEqual(edgematch.match_edge(ref, self.cands(), 100.0), 1)  # start/end order does not matter

    def test_curve_type_distinguishes(self):
        ref = {"curve": "circle", "midpoint": [13, 0, 5], "length": 18.85, "centre": [10, 0, 5], "radius": 3.0, "axis": [0, 0, 1]}
        self.assertEqual(edgematch.match_edge(ref, self.cands(), 100.0), 2)  # axis sign ignored
        ref["curve"] = "arc"
        self.assertEqual(edgematch.match_edge(ref, self.cands(), 100.0), 3)

    def test_zero_matches(self):
        with self.assertRaises(edgematch.EdgeMatchError):
            edgematch.match_edge({"curve": "line", "midpoint": [0, 0, 0], "length": 40.0}, self.cands(), 100.0)
        with self.assertRaises(edgematch.EdgeMatchError):  # length off
            edgematch.match_edge({"curve": "line", "midpoint": [0, 15, 5], "length": 41.0}, self.cands(), 100.0)

    def test_several_matches(self):
        c = self.cands() + [dict(self.cands()[1])]
        with self.assertRaises(edgematch.EdgeMatchError) as cm:
            edgematch.match_edge({"curve": "line", "midpoint": [0, 15, 5], "length": 40.0}, c, 100.0)
        self.assertIn("2 edges", str(cm.exception))

    def test_tolerance_scales_with_diagonal(self):
        ref = {"curve": "line", "midpoint": [0, 15, 5.005], "length": 40.0}
        self.assertEqual(edgematch.match_edge(ref, self.cands(), 100.0), 1)   # tol 0.01
        with self.assertRaises(edgematch.EdgeMatchError):
            edgematch.match_edge(ref, self.cands(), 10.0)                      # tol 0.001

    def test_malformed(self):
        for bad in ({"curve": "spline", "midpoint": [0, 0, 0], "length": 1}, {"curve": "line", "midpoint": [0, 0], "length": 1},
                    {"curve": "line", "midpoint": [0, 0, 0], "length": 0}, None):
            with self.assertRaises(edgematch.EdgeMatchError):
                edgematch.match_edge(bad, self.cands(), 100.0)


class FaceTests(unittest.TestCase):
    def cands(self):
        return [
            {"origin": [0, 0, 12], "normal": [0, 0, -1], "area": 100.0},
            {"origin": [3, 3, 5], "normal": [0, 0, 1], "area": 1200.0},
            {"origin": [0, -13.5, 3.5], "normal": [0, -0.707107, 0.707107], "area": 169.7056},
            {"origin": [0, 0, 0], "normal": [0, 0, 1], "area": 1200.0},
        ]

    def test_match(self):
        ref = {"origin": [0, 0, 12], "normal": [0, 0, 1], "area": 100.0}
        self.assertEqual(facematch.match_face(ref, self.cands(), 50.0), 0)   # either sign
        ref = {"origin": [0, -13.5, 3.5], "normal": [0, -0.707107, 0.707107], "area": 169.705627}
        self.assertEqual(facematch.match_face(ref, self.cands(), 50.0), 2)

    def test_plane_containment_and_area(self):
        self.assertEqual(facematch.match_face({"origin": [9, 9, 5], "normal": [0, 0, 1], "area": 1200.0}, self.cands(), 50.0), 1)
        with self.assertRaises(facematch.FaceMatchError):
            facematch.match_face({"origin": [0, 0, 6], "normal": [0, 0, 1], "area": 1200.0}, self.cands(), 50.0)
        with self.assertRaises(facematch.FaceMatchError):
            facematch.match_face({"origin": [0, 0, 5], "normal": [0, 0, 1], "area": 1300.0}, self.cands(), 50.0)

    def test_several_and_malformed(self):
        c = self.cands()
        c[3]["origin"] = [0, 0, 5]
        with self.assertRaises(facematch.FaceMatchError) as cm:
            facematch.match_face({"origin": [0, 0, 5], "normal": [0, 0, 1], "area": 1200.0}, c, 50.0)
        self.assertIn("2 planar faces", str(cm.exception))
        with self.assertRaises(facematch.FaceMatchError):
            facematch.match_face({"origin": [0, 0, 5], "normal": [0, 0, 0], "area": 1.0}, c, 50.0)


if __name__ == "__main__":
    unittest.main()
