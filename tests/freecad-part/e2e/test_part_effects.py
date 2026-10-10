"""Middle-feature delete, FEATURE_NO_EFFECT and interference/contact tests (FreeCAD Python)."""

from __future__ import annotations

import unittest
from system_requirements import skip_unless_system  # noqa: E402

from test_part_backend import HAVE_FREECAD, Harness, plate

if HAVE_FREECAD:
    pass


def top_pocket(name: str, x: float, depth: float = 2, size: float = 6, reversed_: bool = False) -> list[dict]:
    return [
        {"op": "sketch", "name": f"part/{name}_sk", "plane": "XY", "offset": 6, "shapes": [{"rect": {"center": [x, 0], "size": [size, size]}}]},
        {"op": "pocket", "name": f"part/{name}", "sketch": f"part/{name}_sk", "depth": depth, **({"reversed": True} if reversed_ else {})},
    ]


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class MiddleDeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness()
        self.addCleanup(self.h.close)

    def volume(self) -> float:
        return self.h.body_shape().Volume

    def test_deleting_a_middle_pocket_relinks_the_chain(self) -> None:
        self.h.apply(plate())
        self.h.apply(top_pocket("p1", -20) + top_pocket("p2", 0) + top_pocket("p3", 20))
        full = self.volume()
        self.h.apply([{"op": "delete", "target": "part/p2"}])
        fresh = Harness()
        self.addCleanup(fresh.close)
        fresh.apply(plate())
        fresh.apply(top_pocket("p1", -20) + top_pocket("p3", 20))
        self.assertAlmostEqual(self.volume(), fresh.body_shape().Volume, places=3)
        self.assertAlmostEqual(self.volume(), full + 6 * 6 * 2, places=3)
        self.assertTrue(self.h.body_shape().isValid())
        self.assertIn("part/p2_sk", [o["path"] for o in self.h.call("tree")["bodies"][0]["objects"]], "the sketch stays")

    def test_deleting_a_feature_used_by_a_pattern_names_the_pattern(self) -> None:
        self.h.apply(plate(thickness=6))
        self.h.apply(top_pocket("hole1", -20))
        self.h.apply([{"op": "linear_pattern", "name": "part/row", "features": ["part/hole1"], "direction": "X", "length": 30, "count": 3}])
        error = self.h.error("apply", ops=[{"op": "delete", "target": "part/hole1"}])
        self.assertEqual(error["code"], "HAS_DEPENDENTS")
        self.assertIn("part/row", error["detail"]["dependents"])

    def test_undo_restores_a_deleted_middle_feature(self) -> None:
        self.h.apply(plate())
        self.h.apply(top_pocket("p1", 0))
        before = self.volume()
        self.h.apply([{"op": "delete", "target": "part/p1"}])
        self.assertAlmostEqual(self.volume(), 60 * 30 * 6, places=3)
        self.h.call("undo")
        self.assertAlmostEqual(self.volume(), before, places=3)


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class NoEffectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness()
        self.addCleanup(self.h.close)
        self.h.apply(plate())

    def bottom_pocket(self, reversed_: bool) -> list[dict]:
        return [
            {"op": "sketch", "name": "part/cut_sk", "on": {"feature": "part/base", "role": "bottom"}, "shapes": [{"rect": {"center": [0, 0], "size": [10, 10]}}]},
            {"op": "pocket", "name": "part/cut", "sketch": "part/cut_sk", "depth": 2, **({"reversed": True} if reversed_ else {})},
        ]

    def test_a_pocket_cutting_outward_fails_and_reversed_fixes_it(self) -> None:
        error = self.h.error("apply", ops=self.bottom_pocket(True))
        self.assertEqual(error["code"], "FEATURE_NO_EFFECT")
        self.assertEqual(error["target"], "part/cut")
        self.assertTrue(error["rolledBack"])
        self.assertEqual(error["detail"]["volumeBefore"], error["detail"]["volumeAfter"])
        self.assertTrue(any("reversed=false" in hint for hint in error["hints"]), error["hints"])
        self.assertAlmostEqual(self.h.body_shape().Volume, 60 * 30 * 6, places=3)
        self.h.apply(self.bottom_pocket(False))
        self.assertAlmostEqual(self.h.body_shape().Volume, 60 * 30 * 6 - 10 * 10 * 2, places=3)

    def test_a_pad_inside_the_solid_adds_nothing(self) -> None:
        ops = [
            {"op": "sketch", "name": "part/inner", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [5, 5]}}]},
            {"op": "pad", "name": "part/inner_pad", "sketch": "part/inner", "length": 3},
        ]
        error = self.h.error("apply", ops=ops)
        self.assertEqual(error["code"], "FEATURE_NO_EFFECT")
        self.assertEqual(error["target"], "part/inner_pad")
        self.assertIn("volumeBefore", error["detail"])

    def test_the_first_pad_of_a_body_is_not_a_no_effect(self) -> None:
        result = self.h.apply([
            {"op": "body", "name": "other"},
            {"op": "sketch", "name": "other/sk", "plane": "XY", "body": "other", "shapes": [{"rect": {"center": [0, 0], "size": [4, 4]}}]},
            {"op": "pad", "name": "other/base", "sketch": "other/sk", "length": 2},
        ])
        self.assertIn("rev", result)

    def test_a_pattern_with_copies_outside_has_no_effect(self) -> None:
        self.h.apply(top_pocket("p1", 0))
        error = self.h.error("apply", ops=[{"op": "linear_pattern", "name": "part/row", "features": ["part/p1"], "direction": "Z", "length": 40, "count": 3}])
        self.assertIn(error["code"], {"FEATURE_NO_EFFECT", "PATTERN_FAILED"})


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class InterferenceContactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness()
        self.addCleanup(self.h.close)
        self.h.apply(plate("part", 20, 20, 10))

    def box(self, name: str, x: float, z: float = 0.0) -> list[dict]:
        return [
            {"op": "body", "name": name},
            {"op": "sketch", "name": f"{name}/sk", "plane": "XY", "body": name, "offset": z, "shapes": [{"rect": {"center": [x, 0], "size": [20, 20]}}]},
            {"op": "pad", "name": f"{name}/base", "sketch": f"{name}/sk", "length": 10},
        ]

    def check(self, **args):
        return self.h.call("check", kind="interference", args={"all": True, **args})

    def test_face_to_face_boxes_are_a_contact(self) -> None:
        self.h.apply(self.box("b", 20))
        result = self.check()
        self.assertEqual(result["interferences"], [])
        self.assertEqual(result["value"], 0.0)
        self.assertEqual(len(result["contacts"]), 1)
        self.assertAlmostEqual(result["contacts"][0]["distanceMm"], 0.0, places=6)

    def test_overlapping_boxes_are_an_interference(self) -> None:
        self.h.apply(self.box("b", 10))
        result = self.check()
        self.assertEqual(len(result["interferences"]), 1)
        self.assertAlmostEqual(result["interferences"][0]["volumeMm3"], 10 * 20 * 10, places=3)
        self.assertEqual(result["contacts"], [])

    def test_a_hairline_gap_is_a_contact_and_a_wide_gap_is_nothing(self) -> None:
        self.h.apply(self.box("b", 20.1))
        near = self.check()
        self.assertEqual(len(near["contacts"]), 1)
        self.assertAlmostEqual(near["contacts"][0]["distanceMm"], 0.1, places=4)
        self.assertEqual(self.check(contact_tol=0.05)["contacts"], [])

    def test_tangent_cylinders_are_a_contact(self) -> None:
        def cylinder(name: str, x: float) -> list[dict]:
            return [
                {"op": "body", "name": name},
                {"op": "sketch", "name": f"{name}/sk", "plane": "XY", "body": name, "shapes": [{"circle": {"center": [x, 0], "diameter": 10}}]},
                {"op": "pad", "name": f"{name}/base", "sketch": f"{name}/sk", "length": 10},
            ]
        self.h.apply(cylinder("c1", 0) + cylinder("c2", 10))
        result = self.h.call("check", kind="interference", args={"pairs": [["c1", "c2"]]})
        self.assertEqual(result["interferences"], [])
        self.assertEqual(len(result["contacts"]), 1)


if __name__ == "__main__":
    unittest.main()
