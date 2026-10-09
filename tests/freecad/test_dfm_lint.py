"""DFM first layer through the real FreeCAD worker: the dfm_profile op and the lint summary.

Run with the FreeCAD environment's Python (see test_part_backend.py). Skipped without FreeCAD.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_part_backend import HAVE_FREECAD, Harness, plate  # noqa: E402

PROFILE = {"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill", "material": "al6061"}


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class DfmProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness("plate", "plate")
        self.addCleanup(self.h.close)

    def test_profile_is_set_and_cleared(self) -> None:
        dfm = self.h.apply([PROFILE])["dfm"]
        self.assertEqual((dfm["rulepack"], dfm["material"], dfm["layer"]), ("quanzhou.cnc_mill", "al6061", "lint"))
        self.assertEqual(dfm["geometry"], {"state": "none", "last_rev": None})
        self.assertIsNone(self.h.apply([{"op": "dfm_profile", "rulepack": None}])["dfm"])

    def test_unknown_rulepack_material_and_missing_material_are_refused(self) -> None:
        error = self.h.error("apply", ops=[{"op": "dfm_profile", "rulepack": "no.such_pack", "material": "al6061"}])
        self.assertEqual(error["code"], "DFM_RULEPACK_UNKNOWN")
        self.assertIn("quanzhou.cnc_mill", error["hints"])
        error = self.h.error("apply", ops=[{"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill", "material": "unobtainium"}])
        self.assertEqual(error["code"], "DFM_MATERIAL_UNKNOWN")
        error = self.h.error("apply", ops=[{"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill"}])
        self.assertEqual(error["code"], "OP_SCHEMA_INVALID")

    def test_profile_survives_save_and_reopen(self) -> None:
        self.h.apply([PROFILE, *plate("plate", 40, 30, 5)])
        self.h.worker.cmd_close(self.h.doc, {})
        self.h.call("open", output=str(self.h.step), historyDir=str(self.h.root / ".history"), body="plate", create=False)
        self.assertTrue(Path(self.h.doc).exists())
        dfm = self.h.apply([{"op": "param", "name": "unused", "value": 1}])["dfm"]
        self.assertEqual((dfm["rulepack"], dfm["material"]), ("quanzhou.cnc_mill", "al6061"))

    def test_document_without_profile_has_no_dfm(self) -> None:
        self.assertIsNone(self.h.apply(plate("plate", 40, 30, 5))["dfm"])

    def test_profile_material_sets_the_mass_density(self) -> None:
        self.h.apply([PROFILE, *plate("plate", 40, 30, 5)])
        self.assertEqual(self.h.call("check", kind="mass")["densityGPerCm3"], 2.7)
        self.h.apply([{"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill", "material": "steel_45"}])
        self.assertEqual(self.h.call("check", kind="mass")["densityGPerCm3"], 7.85)


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class DfmHoleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness("plate", "plate")
        self.addCleanup(self.h.close)

    def test_a_one_millimetre_hole_reports_min_diameter_on_the_hole_path(self) -> None:
        ops = [
            PROFILE,
            *plate("plate", 40, 30, 5),
            {"op": "sketch", "name": "plate/tiny_sketch", "on": {"feature": "plate/base", "role": "top"},
             "shapes": [{"circle": {"center": [0, 0], "diameter": 1.0}}]},
            {"op": "hole", "name": "plate/tiny_hole", "sketch": "plate/tiny_sketch", "diameter": 1.0, "depth": 3},
        ]
        dfm = self.h.apply(ops)["dfm"]
        self.assertGreaterEqual(dfm["counts"]["error"], 1)
        found = [issue for issue in dfm["issues"] if issue["rule"] == "hole.min_diameter"]
        self.assertEqual([(i["severity"], i["target"]) for i in found], [("error", "plate/tiny_hole")])
        self.assertEqual((found[0]["measured"], found[0]["limit"], found[0]["unit"]), (1.0, 1.2, "mm"))
        self.assertEqual(found[0]["source"], "铨洲智造 v8.14 p.1")


if __name__ == "__main__":
    unittest.main()
