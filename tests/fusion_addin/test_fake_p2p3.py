"""P2/P3 paths of fusion_exec.py against fake_adsk (limits: see fake_adsk docstring)."""
import copy
import glob
import json
import os
import shutil
import tempfile
import unittest

import _path  # noqa: F401
import fake_adsk
import jobroot
import jobs


def refs_brep(app, features):
    """Make the fake BRep contain exactly the edges/faces the features refer to."""
    for f in features["bodies"][0]["features"]:
        for r in f.get("edges", []):
            app.brep_edges.append(fake_adsk.edge_from_ref(r))
        if f.get("extent", {}).get("face_ref"):
            app.brep_faces.append(fake_adsk.face_from_ref(f["extent"]["face_ref"]))
    for s in features["bodies"][0]["sketches"]:
        if s.get("face_ref"):
            app.brep_faces.append(fake_adsk.face_from_ref(s["face_ref"]))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fdir = jobroot.fusion_dir(self.tmp.name)
        jobroot.ensure_dirs(self.fdir)

    def tearDown(self):
        fake_adsk.uninstall()
        self.tmp.cleanup()

    def run_job(self, features=None, assembly=None, brep=True, setup=None, **fake_kw):
        fake_adsk.uninstall()
        shutil.rmtree(jobroot.outbox_dir(self.fdir, "j1"), ignore_errors=True)
        app = fake_adsk.install(**fake_kw)
        import fusion_exec
        job = {"schema": jobs.JOB_SCHEMA, "jobId": "j1", "target": "fusion",
               "output": {"native": "part.f3d", "check_step": "check.step"}, "check": True, "timeoutS": 60}
        if assembly is not None:
            job.update(kind="assembly", assembly=assembly)
        else:
            job["features"] = features
            if brep:
                refs_brep(app, features)
        if setup:
            setup(app)
        jobs.atomic_write_json(os.path.join(jobroot.inbox_dir(self.fdir), "j1.json"), job)
        res = jobs.process_job(self.fdir, "j1", fusion_exec.FusionExecutor(app), {"version": "0.1.0", "app": "Fusion fake"})
        return app, res


class P2Tests(Base):
    def test_linear_pattern_and_mirror(self):
        app, res = self.run_job(_path.fixture("fusion_p2.features.json"))
        self.assertTrue(res["ok"], res["error"])
        base, bore, row, mirror = app.features
        self.assertEqual(row.label, "rect_pattern")
        ents, axis, qty, dist, dtype = row.input.args
        self.assertEqual((axis.label, qty.value, dtype), ("X", 3, "SpacingPatternDistanceType"))
        self.assertAlmostEqual(dist.value, 1.0)  # 10 mm in cm
        self.assertEqual(ents.item(0), bore)
        self.assertEqual(mirror.label, "mirror")
        self.assertEqual(mirror.input.args[1].label, "XZ")  # origin plane, no construction plane
        self.assertEqual(len(app.planes), 1)  # only the hole sketch plane (z=5); the mirror uses the origin plane
        self.assertEqual([f.name for f in app.features], ["p2/base", "p2/bore", "p2/row", "p2/mirror"])
        self.assertEqual(res["features_built"], 4)

    def test_linear_negative_direction_and_offset_mirror(self):
        f = _path.fixture("fusion_p2.features.json")
        feats = {x["name"]: x for x in f["bodies"][0]["features"]}
        feats["p2/row"]["direction"] = [-1, 0, 0]
        feats["p2/mirror"]["plane"] = {"origin": [0, 4, 0], "normal": [0, 1, 0]}
        app, res = self.run_job(f)
        self.assertTrue(res["ok"], res["error"])
        self.assertAlmostEqual(app.features[2].input.args[3].value, -1.0)
        self.assertEqual(len(app.planes), 2)
        self.assertAlmostEqual(app.planes[1].offset_cm, 0.4 * -1)  # fake XZ normal is -Y: offset flips sign

    def test_tilted_mirror_fails_in_plan_without_fusion(self):
        f = _path.fixture("fusion_p2.features.json")
        f["bodies"][0]["features"][3]["plane"]["normal"] = [1, 1, 0]
        app, res = self.run_job(f)
        self.assertEqual((res["error"]["code"], res["error"]["feature"]), ("UNSUPPORTED_OP", "p2/mirror"))
        self.assertEqual(app.log, [])

    def test_sketch_dimensions(self):
        f = _path.fixture("fusion_p3.features.json")
        app, res = self.run_job(f)
        self.assertTrue(res["ok"], res["error"])
        # base sketch dims are recorded on the first sketch; find it through the log of features' inputs
        sketches = [s for s in app.all_sketches]
        dims = sketches[0].dims
        self.assertEqual([d.kind for d in dims], ["distance", "distance"])
        self.assertEqual(dims[0].args[2], "AlignedDimensionOrientation")
        self.assertEqual(dims[1].args[2], "VerticalDimensionOrientation")
        self.assertEqual(dims[0].parameter.expression, "width")
        self.assertIsNone(dims[1].parameter.expression)

    def test_dimension_failure_names_sketch(self):
        f = _path.fixture("fusion_p3.features.json")
        f["bodies"][0]["sketches"][0]["dimensions"].append(
            {"name": "bad", "kind": "diameter", "refs": [[0, 0]], "value": {"value": 40.0}})  # a line has no radius
        app, res = self.run_job(f)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["code"], "EXECUTOR_FAILED")
        self.assertEqual(res["error"]["step"], "dimension")
        self.assertIn("p3/base_profile", res["error"]["message"])
        self.assertEqual(res["error"]["feature"], "p3/base")
        self.assertEqual(app.log[-1], "close save=False")

    def test_rotated_axes_dimension_is_warning_not_failure(self):
        app, res = self.run_job(_path.fixture("fusion_p3.features.json"), flip_xy=True)  # y axis mirrored: still axis aligned
        self.assertTrue(res["ok"], res["error"])
        f = _path.fixture("fusion_p3.features.json")
        f["bodies"][0]["sketches"][0]["frame"].update(u=[0, 1, 0], v=[-1, 0, 0])  # canonical axes rotated 90 deg: swapped, handled
        self.assertTrue(self.run_job(f)[1]["ok"])


class P3Tests(Base):
    def test_full_p3_end_to_end(self):
        app, res = self.run_job(_path.fixture("fusion_p3.features.json"))
        self.assertTrue(res["ok"], res["error"])
        self.assertEqual([f.name for f in app.features], ["p3/base", "p3/bore", "p3/round", "p3/edge", "p3/boss"])
        self.assertEqual([p[0] for p in app.design.params], ["width", "thickness", "bore_d"])
        self.assertAlmostEqual(app.design.params[0][1].value, 4.0)  # 40 mm in cm
        self.assertEqual(app.design.params[0][2], "mm")
        base, bore, rnd, chamfer, boss = app.features
        self.assertEqual(base.input.extent[1].text, "thickness")           # expression bound
        self.assertEqual(bore.input.kind, "counterbore")
        self.assertEqual(bore.input.args[0].text, "bore_d")
        self.assertAlmostEqual(bore.input.args[1].value, 1.0)               # cb diameter 10 mm
        self.assertEqual(bore.input.extent[1].text, "thickness - 2 mm")
        self.assertIs(bore.input.isDefaultDirection, True)                  # removes against +n
        self.assertAlmostEqual(bore.input.tipAngle.value, 118 * 3.141592653589793 / 180)
        self.assertEqual((rnd.label, rnd.input.sets[0][0].count, rnd.input.sets[0][1].value), ("fillet", 2, 0.1))
        self.assertEqual(chamfer.label, "chamfer")
        self.assertEqual(boss.input.extent[0], "to_face")
        self.assertEqual(boss.input.extent[2].z, 1.0)                       # direction hint
        self.assertEqual([w["field"] for w in res["warnings"]], ["thread"])
        self.assertEqual(app.design.material.name, "Steel")
        self.assertAlmostEqual(app.design.density_prop.value, 7.85e-3)
        self.assertEqual(res["features_built"], 5)

    def test_fx_rejected_by_fusion_falls_back_to_value(self):
        def setup(app):
            import fake_adsk as fa
            orig = fa.ExtrudeInput.setOneSideExtent

            def picky(self, edef, direction, taper=None):
                if getattr(edef.distance, "text", None):
                    raise RuntimeError("expression not allowed")
                return orig(self, edef, direction, taper)
            fa.ExtrudeInput.setOneSideExtent = picky
            self.addCleanup(setattr, fa.ExtrudeInput, "setOneSideExtent", orig)
        app, res = self.run_job(_path.fixture("fusion_p3.features.json"), setup=setup)
        self.assertTrue(res["ok"], res["error"])
        self.assertAlmostEqual(app.features[0].input.extent[1], 0.5)
        self.assertIn("expression", [w["field"] for w in res["warnings"]])

    def test_no_parameters_when_grammar_fails(self):
        f = _path.fixture("fusion_p3.features.json")
        f["bodies"][0]["features"][0]["extent"]["length"]["expr"] = "=thickness^2"
        app, res = self.run_job(f)
        self.assertTrue(res["ok"], res["error"])
        self.assertAlmostEqual(app.features[0].input.extent[1], 0.5)
        w = [w for w in res["warnings"] if w["field"] == "extent.length"][0]
        self.assertEqual(w["feature"], "p3/base")

    def test_edge_ref_zero_and_several(self):
        f = _path.fixture("fusion_p3.features.json")
        app, res = self.run_job(f, brep=False, setup=lambda a: refs_brep(a, f) or a.brep_edges.pop(0))
        self.assertEqual((res["error"]["step"], res["error"]["feature"]), ("edge_ref", "p3/round"))
        self.assertIn("no edge", res["error"]["message"])

        def dup(a):
            refs_brep(a, f)
            a.brep_edges.append(a.brep_edges[0])
        app, res = self.run_job(f, brep=False, setup=dup)
        self.assertEqual(res["error"]["step"], "edge_ref")
        self.assertIn("2 edges", res["error"]["message"])
        self.assertEqual(app.log[-1], "close save=False")

    def test_face_ref_missing(self):
        f = _path.fixture("fusion_p3.features.json")
        app, res = self.run_job(f, brep=False, setup=lambda a: [a.brep_edges.append(fake_adsk.edge_from_ref(r))
                                                                 for x in f["bodies"][0]["features"] for r in x.get("edges", [])])
        self.assertEqual((res["error"]["step"], res["error"]["feature"]), ("face_ref", "p3/boss"))

    def test_sketch_on_tilted_face(self):
        f = _path.fixture("sketch_on_tilted_face.features.json")
        app, res = self.run_job(f)
        self.assertTrue(res["ok"], res["error"])
        tilted = [s for s in app.all_sketches if isinstance(s.plane, fake_adsk.Face)]
        self.assertEqual(len(tilted), 1)

    def test_material_failure_is_warning(self):
        f = _path.fixture("fusion_p3.features.json")
        app, res = self.run_job(f, setup=lambda a: setattr(a, "materialLibraries", fake_adsk._Coll([])))
        self.assertTrue(res["ok"], res["error"])
        self.assertIn("material", [w["field"] for w in res["warnings"]])


class AssemblyTests(Base):
    def test_assembly(self):
        app, res = self.run_job(assembly=_path.fixture("fusion_assembly.json"))
        self.assertTrue(res["ok"], res["error"])
        self.assertEqual(len(app.occurrences), 3)
        self.assertEqual([o.component.name for o in app.occurrences], ["asm/plate_1", "asm/p2_1", "asm/p2_2"])
        m = app.occurrences[1].transform
        self.assertEqual((m.origin.x, m.origin.y, m.origin.z), (10.0, 0.0, 1.0))  # cm
        self.assertEqual([(a.x, a.y, a.z) for a in m.axes], [(0, 1, 0), (-1, 0, 0), (0, 0, 1)])  # columns of R
        self.assertEqual([v["name"] for v in res["feature_volumes"]], ["asm/plate_1", "asm/p2_1", "asm/p2_2"])
        self.assertEqual(res["feature_volumes"][0]["volume_mm3"], 0.5 * 4 * 1000)  # 4 features in the plate component
        self.assertEqual(res["feature_volumes"][1]["volume_mm3"], 0.5 * 4 * 1000)
        self.assertEqual(res["features_built"], 12)
        self.assertEqual(app.design.params, [])
        self.assertEqual(app.log[-1], "close save=False")
        self.assertIn("parameters", [w["field"] for w in res["warnings"]])
        out = jobroot.outbox_dir(self.fdir, "j1")
        self.assertTrue(os.path.isfile(os.path.join(out, "part.f3d")))
        self.assertTrue(os.path.isfile(os.path.join(out, "check.step")))
        # patterns act inside their own component
        self.assertEqual(len(app.occurrences[1].component.feature_list), 4)

    def test_assembly_unsupported_part_feature_before_fusion(self):
        a = _path.fixture("fusion_assembly.json")
        a["parts"][1]["features"]["bodies"][0]["features"].append({"name": "p2/x", "type": "shell"})
        app, res = self.run_job(assembly=a)
        self.assertEqual((res["error"]["code"], res["error"]["feature"]), ("UNSUPPORTED_OP", "p2/x"))
        self.assertEqual(app.log, [])


class GoldenTests(Base):
    """Every canonical fixture other agents add must plan, and run on the fake when its BRep is the refs."""

    def test_all_fixtures(self):
        files = sorted(glob.glob(os.path.join(_path.FIXTURES, "*.features.json")))
        if not files:
            self.skipTest("no canonical fixtures present")
        for path in files:
            with self.subTest(os.path.basename(path)):
                with open(path) as fh:
                    feats = json.load(fh)
                app, res = self.run_job(copy.deepcopy(feats))
                self.assertTrue(res["ok"], (os.path.basename(path), res["error"]))
                n = len(feats["bodies"][0]["features"])
                self.assertEqual(res["features_built"], n)
                self.assertEqual([v["name"] for v in res["feature_volumes"]], [f["name"] for f in feats["bodies"][0]["features"]])
                for w in res["warnings"]:
                    self.assertEqual(set(w), {"feature", "field", "expr", "reason"})


if __name__ == "__main__":
    unittest.main()
