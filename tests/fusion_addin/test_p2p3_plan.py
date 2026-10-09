import copy
import unittest

import _path  # noqa: F401
import plan


def feats(f):
    return {x["name"]: x for x in f["bodies"][0]["features"]}


class P2PlanTests(unittest.TestCase):
    def setUp(self):
        self.f = _path.fixture("fusion_p2.features.json")

    def steps(self, f=None, **kw):
        return {s["name"]: s for s in plan.build_plan(f or self.f, **kw)["steps"]}

    def test_linear_pattern(self):
        st = self.steps()["p2/row"]
        self.assertEqual((st["kind"], st["axis"], st["quantity"], st["spacing_mm"], st["length_mm"]),
                         ("linear_pattern", {"name": "X", "sign": 1}, 3, 10.0, 20.0))
        self.assertIsNone(st["spacing_fx"])  # "=20" has no unit dimension -> value fallback

    def test_linear_pattern_negative_and_errors(self):
        f = copy.deepcopy(self.f)
        feats(f)["p2/row"]["direction"] = [0, -1, 0]
        self.assertEqual(self.steps(f)["p2/row"]["axis"], {"name": "Y", "sign": -1})
        feats(f)["p2/row"]["direction"] = [1, 1, 0]
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual((cm.exception.code, cm.exception.feature), ("UNSUPPORTED_OP", "p2/row"))
        feats(f)["p2/row"]["direction"] = [1, 0, 0]
        feats(f)["p2/row"]["spacing"] = {"value": 7.0}
        with self.assertRaises(plan.PlanError):
            plan.build_plan(f)

    def test_mirror_origin_plane_and_offset(self):
        st = self.steps()["p2/mirror"]
        self.assertEqual((st["kind"], st["plane"], st["originals"]), ("mirror", {"base": "XZ", "axis": "Y", "offset_mm": 0.0}, ["p2/row"]))
        f = copy.deepcopy(self.f)
        feats(f)["p2/mirror"]["plane"] = {"origin": [7, 0, 0], "normal": [-1, 0, 0]}
        self.assertEqual(self.steps(f)["p2/mirror"]["plane"], {"base": "YZ", "axis": "X", "offset_mm": 7.0})

    def test_mirror_tilted_plane_unsupported(self):
        f = copy.deepcopy(self.f)
        feats(f)["p2/mirror"]["plane"] = {"origin": [0, 0, 0], "normal": [1, 1, 0]}
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual((cm.exception.code, cm.exception.feature), ("UNSUPPORTED_OP", "p2/mirror"))
        self.assertIn("p2/mirror", cm.exception.message)

    def test_p2_can_be_disabled(self):
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(self.f, enable_p2=False)
        self.assertEqual(cm.exception.feature, "p2/row")

    def test_pattern_of_pattern_rejected_but_mirror_of_pattern_ok(self):
        f = copy.deepcopy(self.f)
        f["bodies"][0]["features"].append({"name": "p2/row2", "type": "linear_pattern", "originals": ["p2/row"],
                                           "direction": [0, 1, 0], "length": {"value": 4}, "occurrences": 2})
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual(cm.exception.feature, "p2/row2")

    def test_sketch_dimensions_validated(self):
        f = _path.fixture("fusion_p3.features.json")
        st = self.steps(f)["p3/base_profile"]
        self.assertEqual([d["kind"] for d in st["dimensions"]], ["distance", "distance_y"])
        self.assertEqual(st["dimensions"][0]["fx"], "width")
        f["bodies"][0]["sketches"][0]["dimensions"][0]["refs"] = [[99, 0]]
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual(cm.exception.code, "EXECUTOR_FAILED")
        self.assertIn("p3/base_profile", cm.exception.message)

    def test_material(self):
        p = plan.build_plan(_path.fixture("fusion_p3.features.json"))
        self.assertEqual(p["material"], {"name": "Steel", "density_kg_m3": 7850.0})
        f = _path.fixture("fusion_p3.features.json")
        f["material"] = {"density_kg_m3": -1}
        with self.assertRaises(plan.PlanError):
            plan.build_plan(f)


class P3PlanTests(unittest.TestCase):
    def setUp(self):
        self.f = _path.fixture("fusion_p3.features.json")

    def steps(self, f=None, **kw):
        return {s["name"]: s for s in plan.build_plan(f or self.f, **kw)["steps"]}

    def test_parameters_and_fx(self):
        p = plan.build_plan(self.f)
        self.assertEqual([x["name"] for x in p["parameters"]], ["width", "thickness", "bore_d"])
        st = {s["name"]: s for s in p["steps"]}
        self.assertEqual(st["p3/base"]["extent"]["fx"], "thickness")
        bore = st["p3/bore"]
        self.assertEqual((bore["diameter_fx"], bore["extent"]["fx"]), ("bore_d", "thickness - 2 mm"))

    def test_hole_options(self):
        bore = self.steps()["p3/bore"]
        self.assertEqual((bore["kind"], bore["hole_type"], bore["extent"]["type"], bore["extent"]["distance_mm"]), ("hole", "counterbore", "distance", 3.0))
        self.assertEqual(bore["counterbore"]["diameter_mm"], 10.0)
        self.assertEqual(bore["drill_point"], {"type": "angled", "angle_deg": 118.0})
        self.assertEqual(bore["thread"]["size"], "M6")

    def test_thread_warning_and_modeled_rejected(self):
        p = plan.build_plan(self.f)
        self.assertEqual([w["field"] for w in p["warnings"]], ["thread"])
        self.assertEqual(p["warnings"][0]["feature"], "p3/bore")
        feats(self.f)["p3/bore"]["thread"]["modeled"] = True
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(self.f)
        self.assertEqual((cm.exception.code, cm.exception.feature), ("UNSUPPORTED_OP", "p3/bore"))

    def test_countersink_flat_and_bad_combos(self):
        f = copy.deepcopy(self.f)
        b = feats(f)["p3/bore"]
        b.pop("counterbore")
        b["countersink"] = {"diameter": {"value": 9.0}, "angle_deg": 90}
        b["drill_point"] = {"type": "flat"}
        st = self.steps(f)["p3/bore"]
        self.assertEqual((st["hole_type"], st["countersink"]["angle_deg"], st["drill_point"]), ("countersink", 90.0, {"type": "flat", "angle_deg": None}))
        b["counterbore"] = {"diameter": {"value": 9.0}, "depth": {"value": 1.0}}
        with self.assertRaises(plan.PlanError):
            plan.build_plan(f)
        b.pop("counterbore")
        b["extent"] = {"type": "through_all"}
        with self.assertRaises(plan.PlanError):   # drill point on a through hole
            plan.build_plan(f)

    def test_fillet_chamfer_and_validation(self):
        st = self.steps()
        self.assertEqual((st["p3/round"]["kind"], len(st["p3/round"]["edges"]), st["p3/round"]["size_mm"]), ("fillet", 2, 1.0))
        self.assertEqual(st["p3/edge"]["kind"], "chamfer")
        f = copy.deepcopy(self.f)
        feats(f)["p3/round"]["edges"][0]["curve"] = "spline"
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual(cm.exception.feature, "p3/round")
        f = copy.deepcopy(self.f)
        feats(f)["p3/round"].pop("radius")
        with self.assertRaises(plan.PlanError):
            plan.build_plan(f)

    def test_p3_disabled(self):
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(self.f, enable_p3=False)
        self.assertEqual(cm.exception.code, "UNSUPPORTED_OP")

    def test_up_to_face(self):
        boss = self.steps()["p3/boss"]
        self.assertEqual(boss["extent"]["type"], "to_face")
        self.assertEqual(boss["extent"]["face_ref"]["area"], 100.0)
        self.assertEqual(boss["direction"], [0.0, 0.0, 1.0])
        self.assertEqual(boss["operation"], "join")
        f = copy.deepcopy(self.f)
        feats(f)["p3/boss"]["midplane"] = True
        with self.assertRaises(plan.PlanError):
            plan.build_plan(f)
        feats(f)["p3/boss"]["midplane"] = False
        feats(f)["p3/boss"]["extent"]["face_ref"]["area"] = 0
        with self.assertRaises(plan.PlanError):
            plan.build_plan(f)

    def test_tilted_sketch_needs_face_ref(self):
        f = _path.fixture("sketch_on_tilted_face.features.json")
        st = [s for s in plan.build_plan(f)["steps"] if s["kind"] == "sketch" and "face_ref" in s["plane"]]
        self.assertEqual(len(st), 1)
        for s in f["bodies"][0]["sketches"]:
            s.pop("face_ref", None)
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_plan(f)
        self.assertEqual(cm.exception.code, "EXECUTOR_FAILED")

    def test_expression_fallback_warning_has_contract_shape(self):
        f = copy.deepcopy(self.f)
        feats(f)["p3/base"]["extent"]["length"]["expr"] = "=sqrt(thickness)"
        p = plan.build_plan(f)
        w = [x for x in p["warnings"] if x["field"] == "extent.length"][0]
        self.assertEqual((w["feature"], w["expr"]), ("p3/base", "=sqrt(thickness)"))
        self.assertTrue(w["reason"])
        base = [s for s in p["steps"] if s["name"] == "p3/base"][0]
        self.assertIsNone(base["extent"]["fx"])
        self.assertEqual(base["extent"]["distance_mm"], 5.0)


class AssemblyPlanTests(unittest.TestCase):
    def setUp(self):
        self.a = _path.fixture("fusion_assembly.json")

    def test_plan(self):
        p = plan.build_assembly_plan(self.a)
        self.assertEqual([o["name"] for o in p["occurrences"]], ["asm/plate_1", "asm/p2_1", "asm/p2_2"])
        self.assertEqual(p["occurrences"][1]["transform"]["origin"], [100.0, 0.0, 10.0])
        self.assertEqual(len(p["occurrences"][1]["plan"]["steps"]), 6)
        self.assertEqual(p["feature_names"], ["asm/plate_1", "asm/p2_1", "asm/p2_2"])
        # sample_plate declares parameters -> not bound in assemblies, once per part
        self.assertEqual([w["field"] for w in p["warnings"] if w["field"] == "parameters"], ["parameters"])
        self.assertEqual(p["occurrences"][0]["plan"]["parameters"], [])

    def test_bad_inputs(self):
        for mut in (lambda a: a.update(schema="x"),
                    lambda a: a["occurrences"][0].update(part="nope"),
                    lambda a: a["occurrences"][1].update(name="asm/plate_1"),
                    lambda a: a["occurrences"][0]["transform"].update(rotation=[[2, 0, 0], [0, 1, 0], [0, 0, 1]]),
                    lambda a: a["occurrences"][0]["transform"].update(rotation=[[-1, 0, 0], [0, 1, 0], [0, 0, 1]]),
                    lambda a: a.update(occurrences=[])):
            import copy as c
            a = c.deepcopy(self.a)
            mut(a)
            with self.assertRaises(plan.PlanError):
                plan.build_assembly_plan(a)

    def test_part_error_names_feature(self):
        a = copy.deepcopy(self.a)
        a["parts"][1]["features"]["bodies"][0]["features"].append({"name": "p2/x", "type": "shell"})
        with self.assertRaises(plan.PlanError) as cm:
            plan.build_assembly_plan(a)
        self.assertEqual((cm.exception.code, cm.exception.feature), ("UNSUPPORTED_OP", "p2/x"))


if __name__ == "__main__":
    unittest.main()
