import copy
import unittest

import _path  # noqa: F401
import plan


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.f = _path.sample()

    def test_sample_plan_order(self):
        p = plan.build_plan(self.f)
        kinds = [(s["kind"], s["name"]) for s in p["steps"]]
        self.assertEqual(kinds, [
            ("sketch", "plate/base_profile"), ("extrude", "plate/base"),
            ("sketch", "plate/hole_sketch"), ("extrude", "plate/holes"),
            ("polar_pattern", "plate/ring"),
            ("sketch", "plate/pocket_profile"), ("extrude", "plate/pocket")])
        self.assertEqual(p["feature_names"], ["plate/base", "plate/holes", "plate/ring", "plate/pocket"])

    def test_extrude_specs(self):
        st = {s["name"]: s for s in plan.build_plan(self.f)["steps"]}
        base = st["plate/base"]
        self.assertEqual((base["operation"], base["direction_sign"], base["extent"]["distance_mm"]), ("new_body", 1, 5.0))
        self.assertEqual(base["extent"]["expr"], "=thickness")
        pocket = st["plate/pocket"]
        self.assertEqual((pocket["operation"], pocket["direction_sign"], pocket["extent"]["distance_mm"]), ("cut", -1, 2.0))
        holes = st["plate/holes"]
        self.assertEqual((holes["operation"], holes["extent"]["type"], holes["diameter_mm"]), ("cut", "all", 3.0))
        self.assertEqual(holes["positions"], [[15.0, 0.0]])
        hs = st["plate/hole_sketch"]
        self.assertEqual(hs["geometry"][0]["radius"], 1.5)  # diameter 3 overrides the sketch circle

    def test_plane_offset_and_axis(self):
        st = {s["name"]: s for s in plan.build_plan(self.f)["steps"]}
        self.assertEqual(st["plate/pocket_profile"]["plane"], {"base": "XY", "axis": "Z", "offset_mm": 5.0})
        self.assertEqual(st["plate/base_profile"]["plane"]["offset_mm"], 0.0)

    def test_xz_plane_offset_from_frame(self):
        f = copy.deepcopy(self.f)
        sk = f["bodies"][0]["sketches"][0]
        sk["frame"] = {"origin": [0, 7, 0], "u": [1, 0, 0], "v": [0, 0, 1], "n": [0, -1, 0]}
        sk["plane"] = {"base": "XZ", "offset": -7.0}
        f["bodies"][0]["features"][0]["direction"] = [0, -1, 0]
        step = plan.build_plan(f)["steps"][0]
        self.assertEqual(step["plane"], {"base": "XZ", "axis": "Y", "offset_mm": 7.0})  # world +Y offset
        self.assertEqual(plan.build_plan(f)["steps"][1]["direction_sign"], 1)

    def test_midplane_and_through_all_pocket(self):
        f = copy.deepcopy(self.f)
        f["bodies"][0]["features"][0]["midplane"] = True
        pk = f["bodies"][0]["features"][3]
        pk["extent"] = {"type": "through_all"}
        st = {s["name"]: s for s in plan.build_plan(f)["steps"]}
        self.assertTrue(st["plate/base"]["midplane"])
        self.assertEqual(st["plate/pocket"]["extent"]["type"], "all")

    def test_second_pad_joins(self):
        f = copy.deepcopy(self.f)
        feats = f["bodies"][0]["features"]
        feats.insert(1, dict(feats[0], name="plate/boss"))
        st = {s["name"]: s for s in plan.build_plan(f)["steps"]}
        self.assertEqual(st["plate/boss"]["operation"], "join")

    def test_unsupported_names_feature(self):
        f = copy.deepcopy(self.f)
        f["bodies"][0]["features"][1] = {"name": "plate/fillet1", "type": "fillet"}
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        e = cm.exception
        self.assertEqual((e.code, e.feature), ("UNSUPPORTED_OP", "plate/fillet1"))
        self.assertIn("plate/fillet1", e.message)
        self.assertEqual(e.detail["op"], "fillet")

    def test_unsupported_options_and_extents(self):
        for mut, option in (
            (lambda f: f.update(extent={"type": "through_all"}), "extent.type"),   # pad through_all
            (lambda f: f.update(taper_angle=3), "taper_angle"),
            (lambda f: f.update(extent={"type": "up_to_face"}), "extent.type"),
        ):
            f = copy.deepcopy(self.f)
            mut(f["bodies"][0]["features"][0])
            with self.assertRaises(plan.PlanError) as cm:
                plan.build_plan(f)
            self.assertEqual(cm.exception.feature, "plate/base")
            self.assertEqual(cm.exception.detail["option"], option)

    def test_hole_options_unsupported(self):
        f = copy.deepcopy(self.f)
        f["bodies"][0]["features"][1]["counterbore"] = {"diameter": {"value": 6}}
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual(cm.exception.feature, "plate/holes")

    def test_p1_can_be_disabled(self):
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(self.f, enable_p1=False)
        self.assertEqual(cm.exception.feature, "plate/holes")
        self.assertEqual(cm.exception.code, "UNSUPPORTED_OP")

    def test_unsupported_sketch_geometry(self):
        f = copy.deepcopy(self.f)
        f["bodies"][0]["sketches"][0]["geometry"].append({"id": 9, "type": "bspline"})
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual(cm.exception.feature, "plate/base")
        self.assertEqual(cm.exception.detail["option"], "geometry.bspline")

    def test_pattern_axis_limits(self):
        f = copy.deepcopy(self.f)
        ring = f["bodies"][0]["features"][2]
        ring["axis"] = {"origin": [5, 0, 0], "direction": [0, 0, 1]}
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual(cm.exception.feature, "plate/ring")
        ring["axis"] = {"origin": [0, 0, 0], "direction": [1, 1, 0]}
        with self.assertRaises(plan.PlanError):
            plan.build_plan(f)
        ring["axis"] = {"origin": [0, 0, 3], "direction": [0, 0, -1]}
        st = [s for s in plan.build_plan(f)["steps"] if s["kind"] == "polar_pattern"][0]
        self.assertEqual(st["axis"], {"name": "Z", "sign": -1})

    def test_pattern_original_must_precede(self):
        f = copy.deepcopy(self.f)
        f["bodies"][0]["features"][2]["originals"] = ["plate/pocket"]
        with self.assertRaises(plan.PlanError):
            plan.build_plan(f)

    def test_bad_direction_and_schema(self):
        f = copy.deepcopy(self.f)
        f["bodies"][0]["features"][0]["direction"] = [1, 0, 0]
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual(cm.exception.code, "EXECUTOR_FAILED")
        with self.assertRaises(plan.PlanError):
            plan.build_plan({"schema": "other"})

    def test_pocket_without_body(self):
        f = copy.deepcopy(self.f)
        feats = f["bodies"][0]["features"]
        f["bodies"][0]["features"] = [feats[3]]
        with self.assertRaises(plan.PlanError):
            plan.build_plan(f)


if __name__ == "__main__":
    unittest.main()
