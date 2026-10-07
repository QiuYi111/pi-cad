"""End-to-end run of fusion_exec.py against fake_adsk (see its docstring for the limits)."""
import json
import os
import tempfile
import unittest

import _path  # noqa: F401
import fake_adsk
import jobroot
import jobs

INFO = {"version": "0.1.0", "app": "Fusion fake"}


class FakeExecTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fdir = jobroot.fusion_dir(self.tmp.name)
        jobroot.ensure_dirs(self.fdir)

    def tearDown(self):
        fake_adsk.uninstall()
        self.tmp.cleanup()

    def run_job(self, features=None, **fake_kw):
        app = fake_adsk.install(**fake_kw)
        import fusion_exec
        job = {"schema": jobs.JOB_SCHEMA, "jobId": "j1", "target": "fusion", "features": features or _path.sample(),
               "output": {"native": "part.f3d", "check_step": "check.step"}, "check": True, "timeoutS": 60}
        jobs.atomic_write_json(os.path.join(jobroot.inbox_dir(self.fdir), "j1.json"), job)
        res = jobs.process_job(self.fdir, "j1", fusion_exec.FusionExecutor(app), INFO)
        return app, res

    def test_end_to_end(self):
        app, res = self.run_job()
        self.assertTrue(res["ok"], res["error"])
        self.assertEqual(res["features_built"], 4)
        self.assertEqual([v["name"] for v in res["feature_volumes"]], ["plate/base", "plate/holes", "plate/ring", "plate/pocket"])
        self.assertEqual(res["feature_volumes"][0]["volume_mm3"], 500.0)  # 0.5 cm3 -> mm3
        log = app.log
        self.assertEqual(log[0], "documents.add orient=ZUpModelingOrientation")
        self.assertEqual(app.preferences.generalPreferences.defaultModelingOrientation, "Y")  # restored
        self.assertEqual(log[-1], "close save=False")
        self.assertLess(log.index("export f3d"), log.index("export step"))
        self.assertLess(log.index("export step"), log.index("close save=False"))
        self.assertEqual(app.design.designType, "ParametricDesignType")
        out = jobroot.outbox_dir(self.fdir, "j1")
        self.assertTrue(os.path.isfile(os.path.join(out, "part.f3d")))
        self.assertTrue(os.path.isfile(os.path.join(out, "check.step")))
        self.assertEqual(json.load(open(os.path.join(out, "result.json")))["ok"], True)

    def test_even_odd_selection_and_units(self):
        app, res = self.run_job()
        base, holes, ring, pocket = app.features
        self.assertEqual(base.input.profiles.count, 2)  # plate region + island, not the hole disc
        self.assertEqual(base.input.op, "NewBodyFeatureOperation")
        self.assertEqual(base.input.extent[0:2], ("one_side", 0.5))  # 5 mm -> 0.5 cm
        self.assertEqual(base.input.extent[2], "PositiveExtentDirection")
        self.assertEqual(holes.input.kind, "simple")
        self.assertEqual(holes.input.extent, ("all", "NegativeExtentDirection"))
        self.assertAlmostEqual(holes.input.args[0].value, 0.3)  # 3 mm
        self.assertEqual(len(holes.input.positions), 1)
        self.assertEqual(ring.input.quantity.value, 2)
        self.assertAlmostEqual(ring.input.totalAngle.value, 2 * 3.141592653589793)
        self.assertEqual(ring.input.axis.label, "Z")
        self.assertEqual(pocket.input.extent[0:2], ("one_side", 0.2))
        self.assertEqual(pocket.input.extent[2], "NegativeExtentDirection")
        self.assertEqual([f.name for f in app.features], ["plate/base", "plate/holes", "plate/ring", "plate/pocket"])
        self.assertAlmostEqual(app.planes[0].offset_cm, 0.5)  # pocket plane z=5 mm

    def test_flipped_fusion_plane_handled(self):
        app, res = self.run_job(flip_xy=True)
        self.assertTrue(res["ok"], res["error"])
        base, holes, ring, pocket = app.features
        # Fusion XY normal is -Z here: canonical +Z is the NEGATIVE Fusion direction.
        self.assertEqual(base.input.extent[2], "NegativeExtentDirection")
        self.assertEqual(pocket.input.extent[2], "PositiveExtentDirection")
        self.assertAlmostEqual(app.planes[0].offset_cm, -0.5)  # offset flips with the plane normal
        self.assertEqual(base.input.profiles.count, 2)  # mirrored sketch still selects the same regions

    def test_name_rejection_falls_back(self):
        app, res = self.run_job(reject_slash=True)
        self.assertTrue(res["ok"], res["error"])
        self.assertEqual(app.features[0].name, "plate_base")
        self.assertIn("WARN name", open(os.path.join(jobroot.outbox_dir(self.fdir, "j1"), "log.txt")).read())

    def test_export_failure_still_closes_without_saving(self):
        app, res = self.run_job(fail_step=True)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["step"], "export")
        self.assertEqual(app.log[-1], "close save=False")

    def test_midplane_and_through_all(self):
        f = _path.sample()
        f["bodies"][0]["features"][0]["midplane"] = True
        f["bodies"][0]["features"][3]["extent"] = {"type": "through_all"}
        app, res = self.run_job(f)
        self.assertTrue(res["ok"], res["error"])
        self.assertEqual(app.features[0].input.extent, ("symmetric", 0.5, True))
        self.assertEqual(app.features[3].input.extent[0], "all")

    def test_unsupported_feature_never_opens_document(self):
        f = _path.sample()
        f["bodies"][0]["features"].append({"name": "plate/fillet", "type": "shell"})
        app, res = self.run_job(f)
        self.assertEqual(res["error"]["code"], "UNSUPPORTED_OP")
        self.assertEqual(res["error"]["feature"], "plate/fillet")
        self.assertEqual(app.log, [])  # plan errors happen before any Fusion call


if __name__ == "__main__":
    unittest.main()
