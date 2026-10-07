"""export_features: canonical feature JSON from real FreeCAD parts.

Run with the FreeCAD environment's Python (see test_part_backend.py). Set
UPDATE_TRANSFER_GOLDEN=1 to rewrite tests/fixtures/transfer/*.features.json.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_part_backend import HAVE_FREECAD, ROOT, Harness  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "transfer"


def normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items() if k != "sha256"}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if isinstance(value, float):
        return round(value, 6) + 0.0
    return value


def rect_sketch(name: str, size: list, center: list | None = None, **extra: Any) -> dict[str, Any]:
    return {"op": "sketch", "name": name, "plane": "XY", "shapes": [{"rect": {"center": center or [0, 0], "size": size}}], **extra}


def circles(name: str, points: list, diameter: Any, **extra: Any) -> dict[str, Any]:
    return {"op": "sketch", "name": name, "plane": "XY", "shapes": [{"circle": {"center": p, "diameter": diameter}} for p in points], **extra}


def plate_ops(name: str = "part") -> list[dict[str, Any]]:
    return [rect_sketch(f"{name}/profile", [40, 30]), {"op": "pad", "name": f"{name}/base", "sketch": f"{name}/profile", "length": 5}]


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class TransferFeatureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness()
        self.addCleanup(self.h.close)

    # ------------------------------------------------------------ helpers
    def export(self, **args: Any) -> dict[str, Any]:
        return self.h.call("export_features", **args)

    def features(self) -> dict[str, Any]:
        return self.export()["features"]

    def golden(self, name: str) -> dict[str, Any]:
        data = self.features()
        got = normalize(data)
        path = FIXTURES / f"{name}.features.json"
        if os.environ.get("UPDATE_TRANSFER_GOLDEN"):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(got, indent=2) + "\n", encoding="utf-8")
        self.assertEqual(got, json.loads(path.read_text(encoding="utf-8")), f"golden {name}")
        return data

    def unsupported(self, op: str, option: str | None, target: str) -> dict[str, Any]:
        error = self.h.error("export_features")
        self.assertEqual(error["code"], "TRANSFER_UNSUPPORTED_OP", error)
        self.assertEqual(error["target"], target)
        self.assertEqual((error["detail"]["op"], error["detail"]["option"]), (op, option))
        self.assertTrue(error["detail"]["reason"])
        return error

    def feature_obj(self, path: str) -> Any:
        return next(o for o in self.h.session().doc.Objects if getattr(o, "ReifyPath", "") == path)

    # ------------------------------------------------------------ golden parts
    def test_plate_with_four_holes_and_a_pocket(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([
            circles("part/hole_profile", [[-15, -10], [15, -10], [15, 10], [-15, 10]], 4, offset=5),
            {"op": "hole", "name": "part/holes", "sketch": "part/hole_profile", "diameter": 4, "type": "through_all"},
            rect_sketch("part/pocket_profile", [10, 8], offset=5),
            {"op": "pocket", "name": "part/pocket", "sketch": "part/pocket_profile", "depth": 2},
        ])
        data = self.golden("plate_holes_pocket")
        body = data["bodies"][0]
        self.assertEqual([f["type"] for f in body["features"]], ["pad", "hole", "pocket"])
        self.assertEqual(body["features"][1]["direction"], [0, 0, -1])
        self.assertEqual(len(body["features"][1]["positions"]), 4)
        self.assertEqual(body["sketches"][1]["plane"], {"base": "XY", "offset": 5.0})
        ref = data["reference"]
        self.assertAlmostEqual(ref["volume_mm3"], 40 * 30 * 5 - 4 * 3.141592653589793 * 4 * 5 - 80 * 2, places=3)
        self.assertEqual([v["name"] for v in ref["feature_volumes"]], ["part/base", "part/holes", "part/pocket"])
        self.assertAlmostEqual(ref["bbox"]["max"][2], 5.0, places=6)

    def test_parameter_expressions(self) -> None:
        self.h.apply([
            {"op": "param", "name": "width", "value": 40, "unit": "mm"},
            {"op": "param", "name": "hole_d", "value": 4, "unit": "mm"},
            rect_sketch("part/profile", ["=width", 30]),
            {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": "=width/8"},
            circles("part/hole_profile", [[0, 0]], "=hole_d", offset=5),
            {"op": "hole", "name": "part/bore", "sketch": "part/hole_profile", "diameter": "=hole_d + 2 mm", "type": "through_all"},
        ])
        data = self.golden("param_expressions")
        pad, hole = data["bodies"][0]["features"]
        self.assertEqual(pad["extent"]["length"], {"value": 5.0, "expr": "=width/8"})
        self.assertEqual(hole["diameter"], {"value": 6.0, "expr": "=hole_d + 2"})

    def test_rotated_body_placement(self) -> None:
        self.h.apply(plate_ops() + [
            circles("part/hole_profile", [[10, 5]], 4, offset=5),
            {"op": "hole", "name": "part/bore", "sketch": "part/hole_profile", "diameter": 4, "type": "through_all"},
            {"op": "placement", "target": "part", "position": [10, 20, 30], "rotation": {"axis": [1, 0, 0], "angle": 90}},
        ])
        data = self.golden("rotated_body")
        sketch = data["bodies"][0]["sketches"][0]
        self.assertEqual(sketch["plane"]["base"], "XZ")
        self.assertEqual(sketch["frame"]["n"], [0, -1, 0])
        self.assertEqual(data["bodies"][0]["features"][0]["direction"], [0, -1, 0])
        self.assertEqual(data["bodies"][0]["features"][1]["direction"], [0, 1, 0])
        self.assertAlmostEqual(data["reference"]["bbox"]["min"][1], 15.0, places=5)
        self.assertAlmostEqual(data["reference"]["bbox"]["max"][1], 20.0, places=5)

    def test_island_inside_a_hole_has_depth_two(self) -> None:
        self.h.apply([
            {"op": "sketch", "name": "part/profile", "plane": "XY", "shapes": [
                {"rect": {"center": [0, 0], "size": [60, 40]}},
                {"circle": {"center": [0, 0], "diameter": 30}},
                {"circle": {"center": [0, 0], "diameter": 10}},
            ]},
            {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 4},
            rect_sketch("part/bridge_profile", [50, 4], offset=4),
            {"op": "pad", "name": "part/bridge", "sketch": "part/bridge_profile", "length": 2},
        ])
        data = self.golden("island")
        loops = data["bodies"][0]["sketches"][0]["loops"]
        self.assertEqual(sorted(l["depth"] for l in loops), [0, 1, 2])
        pi = 3.141592653589793
        self.assertAlmostEqual(data["reference"]["feature_volumes"][0]["volume_mm3"], (2400 - pi * 225 + pi * 25) * 4, places=3)

    def test_polar_pattern(self) -> None:
        self.h.apply([
            rect_sketch("part/profile", [80, 80]), {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 6},
            circles("part/hole_profile", [[20, 0]], 5, offset=6),
            {"op": "hole", "name": "part/bolt", "sketch": "part/hole_profile", "diameter": 5, "type": "through_all"},
            {"op": "polar_pattern", "name": "part/ring", "features": ["part/bolt"], "axis": "Z", "angle": 360, "count": 4},
        ])
        data = self.golden("polar_pattern")
        ring = data["bodies"][0]["features"][-1]
        self.assertEqual((ring["originals"], ring["occurrences"], ring["full_circle"]), (["part/bolt"], 4, True))
        self.assertEqual(ring["axis"], {"origin": [0, 0, 0], "direction": [0, 0, 1]})

    def test_polar_pattern_in_a_rotated_body_and_partial_angle(self) -> None:
        self.h.apply([
            rect_sketch("part/profile", [80, 80]), {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 6},
            circles("part/hole_profile", [[20, 0]], 5, offset=6),
            {"op": "hole", "name": "part/bolt", "sketch": "part/hole_profile", "diameter": 5, "type": "through_all"},
            {"op": "polar_pattern", "name": "part/ring", "features": ["part/bolt"], "axis": "Z", "angle": 90, "count": 3},
            {"op": "placement", "target": "part", "position": [5, 6, 7], "rotation": {"axis": [0, 1, 0], "angle": 90}},
        ])
        ring = self.features()["bodies"][0]["features"][-1]
        self.assertEqual(ring["axis"], {"origin": [5, 6, 7], "direction": [1, 0, 0]})
        self.assertFalse(ring["full_circle"])
        self.h.apply([{"op": "set", "target": "part/ring", "prop": "Reversed", "value": True}])
        self.assertEqual(self.features()["bodies"][0]["features"][-1]["axis"]["direction"], [-1, 0, 0])

    def test_plane_offset_is_along_the_positive_world_axis(self) -> None:
        # XZ plane: FreeCAD's normal is -Y, so a sketch offset 7 along n sits at y = -7.
        self.h.apply([
            {"op": "sketch", "name": "part/xz", "plane": "XZ", "offset": 7, "shapes": [{"rect": {"center": [0, 0], "size": [10, 10]}}]},
            {"op": "pad", "name": "part/base", "sketch": "part/xz", "length": 4},
        ])
        sketch = self.features()["bodies"][0]["sketches"][0]
        self.assertEqual((sketch["plane"], sketch["frame"]["origin"], sketch["frame"]["n"]), ({"base": "XZ", "offset": -7.0}, [0, -7, 0], [0, -1, 0]))
        # flipped normal: the body turned 180 degrees about X puts the XY sketch normal on -Z
        self.h.close()
        self.h = Harness()
        self.h.apply([
            rect_sketch("part/xy", [10, 10], offset=3), {"op": "pad", "name": "part/base", "sketch": "part/xy", "length": 4},
            {"op": "placement", "target": "part", "position": [0, 0, 20], "rotation": {"axis": [1, 0, 0], "angle": 180}},
        ])
        data = self.features()
        sketch, pad = data["bodies"][0]["sketches"][0], data["bodies"][0]["features"][0]
        self.assertEqual((sketch["plane"], sketch["frame"]["n"], pad["direction"]), ({"base": "XY", "offset": 17.0}, [0, 0, -1], [0, 0, -1]))
        self.assertTrue(all(g["type"] in ("line", "arc", "circle") for g in sketch["geometry"]))
        self.assertAlmostEqual(data["reference"]["bbox"]["min"][2], 13.0, places=6)
        self.assertAlmostEqual(data["reference"]["bbox"]["max"][2], 17.0, places=6)

    def test_several_bodies_and_arcs(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([
            {"op": "body", "name": "pin"},
            {"op": "sketch", "name": "pin/sk", "plane": "XY", "body": "pin", "offset": 5, "shapes": [{"slot": {"start": [-5, 0], "end": [5, 0], "width": 4}}]},
            {"op": "pad", "name": "pin/rib", "sketch": "pin/sk", "length": 3},
        ])
        data = self.features()
        self.assertEqual([b["name"] for b in data["bodies"]], ["part", "pin"])
        slot = data["bodies"][1]["sketches"][0]
        self.assertEqual(sorted(g["type"] for g in slot["geometry"]), ["arc", "arc", "line", "line"])
        self.assertEqual(len(slot["loops"]), 1)
        self.assertAlmostEqual(slot["loops"][0]["area"], 40 + 3.141592653589793 * 4, places=6)
        self.assertEqual(data["part"], "part")

    # ------------------------------------------------------------ verified directions
    def test_directions_match_the_cut_and_added_material(self) -> None:
        import FreeCAD as App

        for plane in ("XY", "XZ", "YZ"):
            for reverse in (False, True):
                with self.subTest(plane=plane, reversed=reverse):
                    self.h.close()
                    self.h = Harness()
                    self.h.apply([
                        rect_sketch("part/b", [100, 100], offset=-50), {"op": "pad", "name": "part/base", "sketch": "part/b", "length": 100},
                        {"op": "sketch", "name": "part/s", "plane": plane, "shapes": [{"rect": {"center": [0, 0], "size": [10, 10]}}]},
                        {"op": "sketch", "name": "part/c", "plane": plane, "shapes": [{"circle": {"center": [0, 0], "diameter": 4}}]},
                    ])
                    before = self.h.body_shape().copy()
                    self.h.apply([{"op": "pocket", "name": "part/cut", "sketch": "part/s", "depth": 5}])
                    self.feature_obj("part/cut").Reversed = reverse
                    self.h.session().recompute()
                    removed = before.cut(self.h.body_shape()).BoundBox.Center
                    entry = {f["name"]: f for f in self.features()["bodies"][0]["features"]}["part/cut"]
                    self.assertGreater(sum(c * d for c, d in zip(removed, entry["direction"])), 1.0, entry)
                    self.assertAlmostEqual(sum(abs(c) for c in entry["direction"]), 1.0, places=9)
                    self.h.apply([{"op": "hole", "name": "part/drill", "sketch": "part/c", "diameter": 4, "type": "through_all"}])
                    self.feature_obj("part/drill").Reversed = reverse
                    self.h.session().recompute()
                    before2 = self.h.body_shape()
                    self.h.apply([{"op": "set", "target": "part/drill", "prop": "Reversed", "value": not reverse}])
                    drilled = {f["name"]: f for f in self.features()["bodies"][0]["features"]}["part/drill"]
                    delta = before2.cut(self.h.body_shape()).BoundBox.Center
                    self.assertEqual(App.Vector(*drilled["direction"]).Length, 1.0)
                    self.assertGreater(sum(c * d for c, d in zip(delta, drilled["direction"])) if delta.Length > 1e-9 else 1.0, -1e-9)

    def test_pad_direction_reversed_and_midplane(self) -> None:
        self.h.apply([rect_sketch("part/s", [10, 10]), {"op": "pad", "name": "part/p", "sketch": "part/s", "length": 5}])
        feature = self.feature_obj("part/p")
        for reverse, midplane, zmin, zmax, direction in [(False, False, 0, 5, 1), (True, False, -5, 0, -1), (False, True, -2.5, 2.5, 1), (True, True, -2.5, 2.5, -1)]:
            with self.subTest(reversed=reverse, midplane=midplane):
                feature.Reversed, feature.Midplane = reverse, midplane
                self.h.session().recompute()
                box = self.h.body_shape().BoundBox
                self.assertAlmostEqual(box.ZMin, zmin, places=6)
                self.assertAlmostEqual(box.ZMax, zmax, places=6)
                pad = self.features()["bodies"][0]["features"][0]
                self.assertEqual((pad["direction"], pad["midplane"], pad["reversed"]), ([0, 0, direction], midplane, reverse))

    def test_construction_geometry_is_skipped(self) -> None:
        self.h.apply(plate_ops())
        sketch = self.feature_obj("part/profile")
        count = sketch.GeometryCount
        import FreeCAD as App
        import Part

        sketch.addGeometry(Part.Circle(App.Vector(0, 0, 0), App.Vector(0, 0, 1), 50), True)
        entry = self.features()["bodies"][0]["sketches"][0]
        self.assertEqual(len(entry["geometry"]), count)
        self.assertEqual(len(entry["loops"]), 1)

    # ------------------------------------------------------------ worker contract
    def test_result_shape_output_file_reference_step_and_read_only(self) -> None:
        self.h.apply(plate_ops())
        rev = self.h.session().rev
        before = Path(self.h.doc).read_bytes()
        log = Path(self.h.doc + ".ops.jsonl")
        log_before = log.read_bytes() if log.exists() else b""
        out = self.h.root / "transfer" / "features.json"
        step = self.h.root / "transfer" / "reference.step"
        result = self.h.call("export-features", output=str(out), referenceStep=str(step))
        self.assertEqual((result["featureCount"], result["part"], result["path"], result["referenceStep"]), (1, "part", str(out), str(step)))
        self.assertEqual(json.loads(out.read_text()), result["features"])
        self.assertGreater(step.stat().st_size, 100)
        self.assertEqual(result["features"]["schema"], "reify.features/1")
        self.assertEqual(result["features"]["source"]["doc"], "part.FCStd")
        self.assertEqual(len(result["features"]["source"]["sha256"]), 64)
        self.assertEqual(self.h.session().rev, rev)
        self.assertEqual(Path(self.h.doc).read_bytes(), before)
        self.assertEqual(log.read_bytes() if log.exists() else b"", log_before)
        self.assertNotIn("path", self.export())

    # ------------------------------------------------------------ negative cases
    def test_fillet_and_chamfer_are_unsupported(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([{"op": "fillet", "name": "part/round_top", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 1}])
        self.unsupported("fillet", None, "part/round_top")
        self.h.close()
        self.h = Harness()
        self.h.apply(plate_ops())
        self.h.apply([{"op": "chamfer", "name": "part/edge_cut", "edges": {"feature": "part/base", "role": "top_outer"}, "size": 1}])
        self.unsupported("chamfer", None, "part/edge_cut")

    def hole_part(self, **hole: Any) -> None:
        self.h.apply(plate_ops())
        self.h.apply([circles("part/hole_profile", [[-10, 0]], 4, offset=5)])
        self.h.apply([{"op": "hole", "name": "part/bore", "sketch": "part/hole_profile", "diameter": 4, **hole}])

    def test_linear_pattern_and_mirror_are_unsupported(self) -> None:
        self.hole_part(type="through_all")
        self.h.apply([{"op": "linear_pattern", "name": "part/row", "features": ["part/bore"], "direction": "X", "length": 20, "count": 2}])
        self.unsupported("linear_pattern", None, "part/row")
        self.h.close()
        self.h = Harness()
        self.hole_part(type="through_all")
        self.h.apply([{"op": "mirror", "name": "part/twin", "features": ["part/bore"], "plane": "YZ"}])
        self.unsupported("mirror", None, "part/twin")

    def test_hole_options_are_named(self) -> None:
        cases = [
            ({"depth": 3}, "blind"),
            ({"depth": 3, "thread": "M4"}, "thread"),
            ({"type": "through_all", "counterbore": {"diameter": 8, "depth": 2}}, "counterbore"),
            ({"type": "through_all", "countersink": {"diameter": 8, "angle": 90}}, "countersink"),
        ]
        for extra, option in cases:
            with self.subTest(option=option):
                self.h.close()
                self.h = Harness()
                self.hole_part(**extra)
                self.unsupported("hole", option, "part/bore")

    def test_pad_up_to_face_is_unsupported(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([
            rect_sketch("part/tower_profile", [10, 10], center=[10, 0], offset=5), {"op": "pad", "name": "part/tower", "sketch": "part/tower_profile", "length": 7},
            rect_sketch("part/bridge_profile", [10, 10], center=[-10, 0], offset=5),
            {"op": "pad", "name": "part/bridge", "sketch": "part/bridge_profile", "length": 1, "type": "up_to_face", "face": {"feature": "part/tower", "role": "top"}},
        ])
        self.unsupported("pad", "up_to_face", "part/bridge")

    def test_sketch_on_a_face_is_unsupported(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([
            {"op": "sketch", "name": "part/pocket_profile", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"rect": {"center": [0, 0], "size": [10, 10]}}]},
            {"op": "pocket", "name": "part/pocket", "sketch": "part/pocket_profile", "depth": 2},
        ])
        error = self.unsupported("sketch", "attached_to_face", "part/pocket_profile")
        self.assertIn("part/base", error["message"])

    def test_tilted_sketch_plane_is_unsupported(self) -> None:
        self.h.apply(plate_ops() + [{"op": "placement", "target": "part", "rotation": {"axis": [1, 0, 0], "angle": 30}}])
        self.unsupported("sketch", "tilted_plane", "part/profile")

    def test_intersecting_loops_are_an_invalid_sketch(self) -> None:
        import FreeCAD as App
        import Part

        self.h.apply(plate_ops())
        sketch = self.feature_obj("part/profile")
        sketch.addGeometry(Part.Circle(App.Vector(20, 0, 0), App.Vector(0, 0, 1), 4), False)  # crosses the right edge
        error = self.h.error("export_features")
        self.assertEqual(error["code"], "TRANSFER_INVALID_SKETCH")
        self.assertEqual(error["target"], "part/profile")
        self.assertEqual(error["detail"]["reason"], "intersecting_loops")

    def test_touching_and_open_loops_are_an_invalid_sketch(self) -> None:
        import FreeCAD as App
        import Part

        self.h.apply(plate_ops())
        sketch = self.feature_obj("part/profile")
        index = sketch.addGeometry(Part.Circle(App.Vector(20, 0, 0), App.Vector(0, 0, 1), 4), False)
        sketch.delGeometry(index)
        sketch.addGeometry(Part.Circle(App.Vector(24, 0, 0), App.Vector(0, 0, 1), 4), False)  # tangent to the right edge from outside
        self.assertEqual(self.h.error("export_features")["detail"]["reason"], "touching_loops")
        sketch.delGeometry(sketch.GeometryCount - 1)
        sketch.addGeometry(Part.LineSegment(App.Vector(0, 0, 0), App.Vector(5, 5, 0)), False)
        self.assertEqual(self.h.error("export_features")["detail"]["reason"], "open_loop")

    def test_unknown_document_state_errors_have_wire_shape(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([{"op": "fillet", "name": "part/round_top", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 1}])
        error = self.h.error("export_features")
        self.assertEqual(set(error) & {"code", "message", "target", "detail", "rolledBack"}, {"code", "message", "target", "detail", "rolledBack"})
        self.assertEqual(set(error["detail"]), {"op", "option", "reason"})


if __name__ == "__main__":
    unittest.main()
