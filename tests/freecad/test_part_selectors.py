"""Small selector and error-hint behaviour of the part backend (A.8 of the rollout review)."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_part_backend import HAVE_FREECAD, Harness  # noqa: E402


def ring(outer: float = 40, inner: float = 20, length: float = 10) -> list[dict[str, Any]]:
    return [
        {"op": "sketch", "name": "tire/profile", "plane": "XY", "shapes": [{"circle": {"center": [0, 0], "diameter": outer}}, {"circle": {"center": [0, 0], "diameter": inner}}]},
        {"op": "pad", "name": "tire/ring", "sketch": "tire/profile", "length": length},
    ]


def rim_edges(**extra: Any) -> dict[str, Any]:
    return {"between": [{"feature": "tire/ring", "role": "side"}, {"feature": "tire/ring", "role": "top"}], **extra}


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class SelectorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness("tire", "tire")
        self.addCleanup(self.h.close)

    def test_a_reserved_role_name_comes_with_a_concrete_rename(self) -> None:
        self.h.apply(ring())
        error = self.h.error("apply", ops=[
            {"op": "sketch", "name": "tire/floor_sketch", "on": {"feature": "tire/ring", "role": "top"}, "shapes": [{"circle": {"center": [0, 0], "diameter": 30}}]},
            {"op": "pocket", "name": "tire/floor", "sketch": "tire/floor_sketch", "depth": 2},
        ])
        self.assertEqual(error["code"], "NAME_CONFLICT")
        self.assertEqual(error["detail"]["suggested"], "tire/floor_pan")
        self.assertTrue(any("tire/floor_pan" in hint for hint in error["hints"]), error["hints"])
        self.h.apply([
            {"op": "sketch", "name": "tire/floor_sketch", "on": {"feature": "tire/ring", "role": "top"}, "shapes": [{"circle": {"center": [0, 0], "diameter": 30}}]},
            {"op": "pocket", "name": error["detail"]["suggested"], "sketch": "tire/floor_sketch", "depth": 2},
        ])

    def test_a_ring_edge_selector_without_which_is_ambiguous_and_lists_the_candidates(self) -> None:
        self.h.apply(ring())
        error = self.h.error("apply", ops=[{"op": "fillet", "name": "tire/dress", "edges": rim_edges(), "radius": 1}])
        self.assertEqual(error["code"], "TARGET_AMBIGUOUS")
        self.assertEqual(sorted(c["radius"] for c in error["detail"]["candidates"]), [10.0, 20.0])
        self.assertTrue(all("length" in c for c in error["detail"]["candidates"]))
        self.assertEqual(error["detail"]["which"], ["outer", "inner", "all"])
        self.assertTrue(any('"which": "outer"' in hint for hint in error["hints"]), error["hints"])
        self.assertTrue(error["rolledBack"])

    def test_which_outer_and_inner_pick_one_edge_of_the_ring(self) -> None:
        self.h.apply(ring())
        self.h.apply([{"op": "fillet", "name": "tire/dress", "edges": rim_edges(which="outer"), "radius": 1}])
        faces = self.h.call("query", target="tire/dress/round", what=["faces"])["faces"]
        self.assertEqual(len(faces), 1)
        self.assertGreater(self.h.body_shape().Volume, 0)

    def test_which_decides_which_edge_is_dressed(self) -> None:
        volumes = {}
        for which in ("outer", "inner", "all"):
            h = Harness("tire", "tire")
            self.addCleanup(h.close)
            h.apply(ring())
            h.apply([{"op": "chamfer", "name": "tire/dress", "edges": rim_edges(which=which), "size": 1}])
            volumes[which] = h.body_shape().Volume
        full = self.h.apply(ring()) and self.h.body_shape().Volume
        # The outer edge is longer, so a chamfer there takes more material than on the inner edge.
        self.assertGreater(full - volumes["outer"], full - volumes["inner"])
        self.assertAlmostEqual((full - volumes["outer"]) + (full - volumes["inner"]), full - volumes["all"], places=6)

    def test_radius_range_selects_by_size_and_a_miss_lists_what_exists(self) -> None:
        self.h.apply(ring())
        error = self.h.error("apply", ops=[{"op": "chamfer", "name": "tire/other", "edges": rim_edges(radius={"min": 30}), "size": 1}])
        self.assertEqual(error["code"], "TARGET_NOT_FOUND")
        self.assertEqual(sorted(c["radius"] for c in error["detail"]["candidates"]), [10.0, 20.0])
        full = self.h.body_shape().Volume
        self.h.apply([{"op": "chamfer", "name": "tire/dress", "edges": rim_edges(radius={"max": 12}), "size": 1}])
        removed = full - self.h.body_shape().Volume
        self.assertAlmostEqual(removed, 0.5 * 2 * math.pi * (10 + 1 / 3), delta=0.05, msg="a 1 mm chamfer on the radius 10 edge")

    def test_which_is_validated(self) -> None:
        self.h.apply(ring())
        for edges in (rim_edges(which="middle"), rim_edges(radius={"low": 1}), rim_edges(radius={"min": 5, "max": 1})):
            self.assertEqual(self.h.error("apply", ops=[{"op": "fillet", "name": "tire/dress", "edges": edges, "radius": 1}])["code"], "OP_SCHEMA_INVALID")

    def test_a_single_circular_edge_needs_no_which(self) -> None:
        self.h.apply(ring())
        self.h.apply([{"op": "fillet", "name": "tire/dress", "edges": {"feature": "tire/ring", "role": "top_outer"}, "radius": 1}])
        self.assertEqual(len(self.h.call("query", target="tire/dress/round", what=["faces"])["faces"]), 1)


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class DressupFailureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness("hex", "hex")
        self.addCleanup(self.h.close)
        hexagon = [[10 * math.cos(k * math.pi / 3), 10 * math.sin(k * math.pi / 3)] for k in range(6)]
        self.h.apply([
            {"op": "sketch", "name": "hex/profile", "plane": "XY", "shapes": [{"polyline": {"points": hexagon, "closed": True}}]},
            {"op": "pad", "name": "hex/prism", "sketch": "hex/profile", "length": 4},
        ])

    def test_a_chamfer_that_does_not_fit_says_how_much_room_there_is(self) -> None:
        error = self.h.error("apply", ops=[{"op": "chamfer", "name": "hex/bevel_top", "edges": {"feature": "hex/prism", "role": "top_outer"}, "size": 30}])
        self.assertEqual(error["code"], "CHAMFER_FAILED")
        self.assertTrue(error["rolledBack"])
        self.assertIn("freecadStatus", error["detail"], "the OCC text stays in the detail")
        self.assertEqual(error["detail"]["value"], 30.0)
        self.assertAlmostEqual(error["detail"]["narrowestAdjacentFaceMm"], 4.0, places=3)
        self.assertTrue(any("30 mm does not fit" in hint and "4 mm" in hint for hint in error["hints"]), error["hints"])
        self.assertTrue(any("chamfer before the pockets" in hint for hint in error["hints"]))
        self.assertTrue(any("still exists" in hint for hint in error["hints"]))

    def test_a_fillet_failure_suggests_the_chamfer_and_the_order(self) -> None:
        error = self.h.error("apply", ops=[{"op": "fillet", "name": "hex/round_top", "edges": {"feature": "hex/prism", "role": "top_outer"}, "radius": 30}])
        self.assertEqual(error["code"], "FILLET_FAILED")
        self.assertTrue(any("fillet before the pockets" in hint for hint in error["hints"]), error["hints"])
        self.assertTrue(any("chamfer" in hint for hint in error["hints"]))


if __name__ == "__main__":
    unittest.main()
