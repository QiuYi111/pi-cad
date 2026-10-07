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
    # ------------------------------------------------------------ P2: patterns, dimensions, material
    def hole_part(self, **hole: Any) -> None:
        self.h.apply(plate_ops())
        self.h.apply([circles("part/hole_profile", [[-10, 0]], 4, offset=5)])
        self.h.apply([{"op": "hole", "name": "part/bore", "sketch": "part/hole_profile", "diameter": 4, "type": "through_all", **hole}])

    def test_linear_pattern(self) -> None:
        self.h.apply([
            rect_sketch("part/profile", [100, 20]), {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 5},
            circles("part/hole_profile", [[-30, 0]], 4, offset=5),
            {"op": "hole", "name": "part/bore", "sketch": "part/hole_profile", "diameter": 4, "type": "through_all"},
            {"op": "linear_pattern", "name": "part/row", "features": ["part/bore"], "direction": "X", "length": 40, "count": 3},
        ])
        data = self.golden("linear_pattern")
        row = data["bodies"][0]["features"][-1]
        self.assertEqual((row["originals"], row["direction"], row["occurrences"], row["spacing"], row["length"]), (["part/bore"], [1, 0, 0], 3, {"value": 20.0}, {"value": 40.0}))

        def centres() -> list[float]:
            return sorted(round(f.CenterOfMass.x, 2) for f in self.h.body_shape().Faces if type(f.Surface).__name__ == "Cylinder")

        self.assertEqual(centres(), [-30.0, -10.0, 10.0])  # first instance + length / (n - 1) steps along direction
        self.h.apply([{"op": "set", "target": "part/row", "prop": "Reversed", "value": True}])
        row = self.features()["bodies"][0]["features"][-1]
        self.assertEqual((row["direction"], row["reversed"]), ([-1, 0, 0], True))
        self.assertLess(centres()[0], -40)  # instances now run towards -X

    def test_linear_pattern_in_a_rotated_body_and_symbolic_length(self) -> None:
        self.h.apply([
            {"op": "param", "name": "pitch", "value": 15, "unit": "mm"},
            rect_sketch("part/profile", [100, 20]), {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 5},
            circles("part/hole_profile", [[-30, 0]], 4, offset=5),
            {"op": "hole", "name": "part/bore", "sketch": "part/hole_profile", "diameter": 4, "type": "through_all"},
            {"op": "linear_pattern", "name": "part/row", "features": ["part/bore"], "direction": "Y", "length": "=pitch * 2", "count": 3},
            {"op": "placement", "target": "part", "rotation": {"axis": [0, 0, 1], "angle": 90}},
        ])
        row = self.features()["bodies"][0]["features"][-1]
        self.assertEqual(row["direction"], [-1, 0, 0])
        self.assertEqual(row["length"], {"value": 30.0, "expr": "=pitch*2"})
        self.assertEqual(row["spacing"], {"value": 15.0})

    def test_mirror(self) -> None:
        self.h.apply([
            rect_sketch("part/profile", [100, 20]), {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 5},
            circles("part/hole_profile", [[-30, 5]], 4, offset=5),
            {"op": "hole", "name": "part/bore", "sketch": "part/hole_profile", "diameter": 4, "type": "through_all"},
            {"op": "mirror", "name": "part/twin", "features": ["part/bore"], "plane": "XZ"},
        ])
        data = self.golden("mirror")
        twin = data["bodies"][0]["features"][-1]
        self.assertEqual((twin["originals"], twin["plane"]["origin"], twin["plane"]["normal"]), (["part/bore"], [0, 0, 0], [0, -1, 0]))
        self.h.apply([{"op": "placement", "target": "part", "position": [1, 2, 3], "rotation": {"axis": [0, 0, 1], "angle": 90}}])
        twin = self.features()["bodies"][0]["features"][-1]
        self.assertEqual((twin["plane"]["origin"], twin["plane"]["normal"]), ([1, 2, 3], [1, 0, 0]))

    def test_sketch_dimensions(self) -> None:
        import Sketcher
        import math

        self.h.apply([
            {"op": "param", "name": "width", "value": 40, "unit": "mm"},
            rect_sketch("part/profile", ["=width", 30]), {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 5},
            circles("part/hole_profile", [[0, 0]], 6, offset=5),
            {"op": "hole", "name": "part/bore", "sketch": "part/hole_profile", "diameter": 6, "type": "through_all"},
        ])
        profile = {d["name"]: d for d in self.features()["bodies"][0]["sketches"][0]["dimensions"]}
        self.assertEqual(profile["s0_w"], {"name": "s0_w", "kind": "distance_x", "refs": [[0, 1], [0, 2]], "value": {"value": 40.0, "expr": "=width"}})
        self.assertEqual(profile["s0_h"]["kind"], "distance_y")
        self.assertEqual(profile["s0_c_x"]["refs"], [[-1, 1], [0, 1]])
        self.assertNotIn("Coincident", json.dumps(profile))
        sketch = self.feature_obj("part/hole_profile")
        index = sketch.addGeometry(__import__("Part").LineSegment(*[__import__("FreeCAD").Vector(*v) for v in ((3, 3, 0), (6, 7, 0))]), False)
        sketch.addConstraint(Sketcher.Constraint("Distance", index, 5.0))
        sketch.renameConstraint(sketch.ConstraintCount - 1, "len")
        sketch.addConstraint(Sketcher.Constraint("Angle", index, math.atan2(4, 3)))
        sketch.renameConstraint(sketch.ConstraintCount - 1, "tilt")
        dims = {d["name"]: d for d in self.features()["bodies"][0]["sketches"][1]["dimensions"]}
        self.assertEqual(dims["len"], {"name": "len", "kind": "distance", "refs": [[index, 0]], "value": {"value": 5.0}})
        self.assertEqual(dims["tilt"]["kind"], "angle")
        self.assertAlmostEqual(dims["tilt"]["value"]["value"], 53.130102, places=5)
        self.assertEqual(next(d for d in dims.values() if d["kind"] == "diameter")["value"], {"value": 6.0})

    def test_material_only_when_density_is_declared(self) -> None:
        self.h.apply(plate_ops())
        self.assertNotIn("material", self.features())
        self.h.apply([{"op": "param", "name": "density", "value": 7.85}])
        data = self.features()
        self.assertEqual(data["material"], {"density_kg_m3": 7850.0})
        self.assertIn({"name": "density", "value": 7.85, "unit": ""}, data["parameters"])

    # ------------------------------------------------------------ P3: parameters, holes, dressups, faces
    def test_parameters_block(self) -> None:
        self.h.apply([
            {"op": "param", "name": "width", "value": 40, "unit": "mm"},
            {"op": "param", "name": "half", "value": "=width / 2", "unit": "mm"},
            {"op": "param", "name": "turn", "value": 90, "unit": "deg"},
            {"op": "param", "name": "count", "value": 3},
        ] + plate_ops())
        self.assertEqual(self.features()["parameters"], [
            {"name": "count", "value": 3.0, "unit": ""},
            {"name": "half", "value": 20.0, "unit": "mm", "expr": "=width/2"},
            {"name": "turn", "value": 90.0, "unit": "deg"},
            {"name": "width", "value": 40.0, "unit": "mm"},
        ])  # sorted by name

    def test_hole_variants(self) -> None:
        self.h.apply([rect_sketch("part/profile", [80, 30]), {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 8}])
        specs = [
            ("blind", -30, {"depth": 5}),
            ("tap", -15, {"depth": 5, "thread": "M6"}),
            ("cbore", 0, {"type": "through_all", "counterbore": {"diameter": 10, "depth": 2}}),
            ("csink", 15, {"type": "through_all", "countersink": {"diameter": 12, "angle": 90}}),
            ("flat", 30, {"depth": 4}),
        ]
        for name, x, extra in specs:
            self.h.apply([
                {"op": "sketch", "name": f"part/{name}_profile", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"circle": {"center": [x, 0], "diameter": 6}}]},
                {"op": "hole", "name": f"part/{name}", "sketch": f"part/{name}_profile", "diameter": 6, **extra},
            ])
        flat = self.feature_obj("part/flat")
        flat.DrillPoint = "Flat"
        self.h.session().recompute()
        data = self.golden("holes_p3")
        holes = {f["name"]: f for f in data["bodies"][0]["features"] if f["type"] == "hole"}
        self.assertEqual(holes["part/blind"]["extent"], {"type": "blind", "depth": {"value": 5.0}})
        self.assertEqual(holes["part/blind"]["drill_point"], {"type": "angled", "angle_deg": 118.0})
        self.assertEqual(holes["part/flat"]["drill_point"]["type"], "flat")
        self.assertEqual(holes["part/tap"]["thread"], {"standard": "ISO", "size": "M6", "pitch_mm": 1.0, "modeled": False})
        self.assertEqual(holes["part/cbore"]["counterbore"], {"diameter": {"value": 10.0}, "depth": {"value": 2.0}})
        self.assertEqual(holes["part/csink"]["countersink"], {"diameter": {"value": 12.0}, "angle_deg": 90.0})
        self.assertNotIn("drill_point", holes["part/cbore"])
        self.assertEqual(holes["part/cbore"]["extent"], {"type": "through_all"})

    def test_fillet_and_chamfer_edge_refs(self) -> None:
        self.h.apply(plate_ops() + [
            circles("part/hole_profile", [[0, 0]], 6, offset=5),
            {"op": "hole", "name": "part/bore", "sketch": "part/hole_profile", "diameter": 6, "type": "through_all"},
            {"op": "fillet", "name": "part/outer_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 1.5},
            {"op": "chamfer", "name": "part/bore_edge", "edges": {"feature": "part/bore", "role": "rim"}, "size": 0.5},
        ])
        data = self.golden("fillet_chamfer")
        fillet, chamfer = data["bodies"][0]["features"][-2:]
        self.assertEqual((fillet["type"], fillet["radius"], len(fillet["edges"])), ("fillet", {"value": 1.5}, 4))
        self.assertTrue(all(e["curve"] == "line" and e["midpoint"][2] == 5.0 for e in fillet["edges"]))
        self.assertEqual((chamfer["type"], chamfer["size"]), ("chamfer", {"value": 0.5}))
        self.assertEqual({e["curve"] for e in chamfer["edges"]}, {"circle"})
        # resolved in the state BEFORE the feature: the chamfer's edge is on the plate top at z = 5 with radius 3 (hole not yet rounded)
        circle = chamfer["edges"][0]
        self.assertEqual((circle["radius"], circle["centre"], circle["axis"]), (3.0, [0, 0, 5], circle["axis"]))

    def test_fillet_edges_in_a_rotated_body_are_world_coordinates(self) -> None:
        self.h.apply(plate_ops() + [
            {"op": "fillet", "name": "part/outer_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 1},
            {"op": "placement", "target": "part", "position": [100, 0, 0], "rotation": {"axis": [1, 0, 0], "angle": 90}},
        ])
        fillet = self.features()["bodies"][0]["features"][-1]
        # top (z = 5) maps to y = -5 after a +90 degree turn about X
        self.assertTrue(all(abs(e["midpoint"][1] + 5.0) < 1e-6 for e in fillet["edges"]), fillet["edges"])
        self.assertTrue(all(e["midpoint"][0] > 79 for e in fillet["edges"]))

    def test_ambiguous_edges_are_rejected(self) -> None:
        self.h.apply([
            rect_sketch("part/profile", [100, 100]), {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 0.005},
            {"op": "fillet", "name": "part/edge_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 0.001},
        ])
        self.unsupported("fillet", "ambiguous_edge", "part/edge_round")

    def test_dressup_variants_that_stay_unsupported(self) -> None:
        self.h.apply(plate_ops() + [{"op": "chamfer", "name": "part/edge_cut", "edges": {"feature": "part/base", "role": "top_outer"}, "size": 1}])
        self.feature_obj("part/edge_cut").ChamferType = "Two distances"
        self.h.session().recompute()
        self.unsupported("chamfer", "chamfer_type", "part/edge_cut")

    def test_sketch_on_a_planar_face_exports_as_plane_and_offset(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([
            {"op": "sketch", "name": "part/pocket_profile", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"rect": {"center": [0, 0], "size": [10, 10]}}]},
            {"op": "pocket", "name": "part/pocket", "sketch": "part/pocket_profile", "depth": 2},
        ])
        data = self.golden("sketch_on_face")
        sketch = data["bodies"][0]["sketches"][1]
        self.assertEqual((sketch["plane"], "face_ref" in sketch), ({"base": "XY", "offset": 5.0}, False))
        self.assertEqual(data["bodies"][0]["features"][1]["direction"], [0, 0, -1])

    def test_sketch_on_a_tilted_face_carries_a_face_ref(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([{"op": "chamfer", "name": "part/slope", "edges": {"between": [{"feature": "part/base", "role": "top"}, {"feature": "part/base", "role": "side.0"}]}, "size": 3}])
        self.h.apply([
            {"op": "sketch", "name": "part/dimple_profile", "on": {"feature": "part/slope", "role": "bevel"}, "shapes": [{"circle": {"center": [0, 0], "diameter": 4}}]},
            {"op": "pocket", "name": "part/dimple", "sketch": "part/dimple_profile", "depth": 1},
        ])
        data = self.golden("sketch_on_tilted_face")
        sketch = data["bodies"][0]["sketches"][1]
        self.assertIsNone(sketch["plane"])
        ref = sketch["face_ref"]
        self.assertAlmostEqual(abs(ref["normal"][0]) + abs(ref["normal"][1]) + abs(ref["normal"][2]), 2 ** 0.5, places=6)
        n = sketch["frame"]["n"]
        self.assertAlmostEqual(sum(a * b for a, b in zip(n, ref["normal"])), 1.0, places=6)  # outward normal = sketch normal
        self.assertAlmostEqual(sum((a - b) * c for a, b, c in zip(sketch["frame"]["origin"], ref["origin"], ref["normal"])), 0.0, places=6)
        pocket = data["bodies"][0]["features"][-1]
        self.assertEqual(pocket["direction"], [-c for c in n])

    def test_sketch_on_a_non_planar_face_is_unsupported(self) -> None:
        self.hole_part()
        bore = self.feature_obj("part/bore")
        wall = next(f"Face{i + 1}" for i, f in enumerate(bore.Shape.Faces) if type(f.Surface).__name__ == "Cylinder")
        self.h.apply([rect_sketch("part/on_wall", [2, 2], offset=5), {"op": "pad", "name": "part/rib", "sketch": "part/on_wall", "length": 2}])
        sketch = self.feature_obj("part/on_wall")
        sketch.MapMode = "Deactivated"
        sketch.AttachmentSupport = [(bore, [wall])]
        self.unsupported("sketch", "non_planar_face", "part/on_wall")

    def test_pad_up_to_face(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([
            {"op": "sketch", "name": "part/tower_profile", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"rect": {"center": [10, 0], "size": [10, 10]}}]},
            {"op": "pad", "name": "part/tower", "sketch": "part/tower_profile", "length": 7},
            {"op": "sketch", "name": "part/bridge_profile", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"rect": {"center": [-10, 0], "size": [10, 10]}}]},
            {"op": "pad", "name": "part/bridge", "sketch": "part/bridge_profile", "length": 1, "type": "up_to_face", "face": {"feature": "part/tower", "role": "top"}},
        ])
        data = self.golden("pad_up_to_face")
        bridge = data["bodies"][0]["features"][-1]
        self.assertEqual(bridge["direction"], [0, 0, 1])  # FreeCAD pads along +n up to the face
        self.assertEqual(bridge["extent"], {"type": "up_to_face", "face_ref": {"origin": [10, 0, 12], "normal": [0, 0, 1], "area": 100.0}})
        self.assertAlmostEqual(self.h.body_shape().BoundBox.ZMax, 12.0, places=6)

    def test_pad_up_to_a_curved_face_or_offset_is_unsupported(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([
            rect_sketch("part/tower_profile", [10, 10], center=[10, 0], offset=5), {"op": "pad", "name": "part/tower", "sketch": "part/tower_profile", "length": 7},
            rect_sketch("part/bridge_profile", [10, 10], center=[-10, 0], offset=5),
            {"op": "pad", "name": "part/bridge", "sketch": "part/bridge_profile", "length": 1, "type": "up_to_face", "face": {"feature": "part/tower", "role": "top"}},
        ])
        bridge = self.feature_obj("part/bridge")
        bridge.Offset = 1.0
        self.h.session().recompute()
        self.unsupported("pad", "offset", "part/bridge")

    # ------------------------------------------------------------ what stays unsupported
    def test_hole_options_that_stay_unsupported(self) -> None:
        for prop, value, option in [("ModelThread", True, "modeled_thread"), ("Tapered", True, "tapered"), ("Midplane", True, "midplane")]:
            with self.subTest(option=option):
                self.h.close()
                self.h = Harness()
                self.hole_part(**({"depth": 3, "thread": "M4"} if prop == "ModelThread" else {}))
                setattr(self.feature_obj("part/bore"), prop, value)
                self.unsupported("hole", option, "part/bore")

    def test_pocket_and_pad_options_that_stay_unsupported(self) -> None:
        self.h.apply(plate_ops())
        self.h.apply([rect_sketch("part/cut_profile", [4, 4], offset=5), {"op": "pocket", "name": "part/cut", "sketch": "part/cut_profile", "depth": 1}])
        cut = self.feature_obj("part/cut")
        cut.Type = "UpToFirst"
        self.unsupported("pocket", "up_to_first", "part/cut")
        cut.Type = "Length"
        cut.Midplane = True
        self.unsupported("pocket", "midplane", "part/cut")

    def test_linear_pattern_and_mirror_options_that_stay_unsupported(self) -> None:
        self.hole_part()
        self.h.apply([{"op": "linear_pattern", "name": "part/row", "features": ["part/bore"], "direction": "X", "length": 20, "count": 2}])
        self.feature_obj("part/row").Mode = "Spacing"
        self.unsupported("linear_pattern", "spacing_mode", "part/row")
        self.h.close()
        self.h = Harness()
        self.hole_part()
        self.h.apply([{"op": "mirror", "name": "part/twin", "features": ["part/bore"], "plane": "YZ"}])
        twin = self.feature_obj("part/twin")
        twin.MirrorPlane = (self.feature_obj("part/profile"), [""])
        self.unsupported("mirror", "plane", "part/twin")

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

    def test_error_shape_is_wire_compatible(self) -> None:
        self.hole_part(depth=3, thread="M4")
        self.feature_obj("part/bore").ModelThread = True
        error = self.h.error("export_features")
        self.assertEqual(set(error) & {"code", "message", "target", "detail", "rolledBack"}, {"code", "message", "target", "detail", "rolledBack"})
        self.assertEqual(set(error["detail"]), {"op", "option", "reason"})

if __name__ == "__main__":
    unittest.main()
