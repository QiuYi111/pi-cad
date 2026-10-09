"""DFM first layer through the real FreeCAD worker: the dfm_profile op and the lint summary.

Run with the FreeCAD environment's Python (see test_part_backend.py). Skipped without FreeCAD.
"""

from __future__ import annotations

import sys
import unittest
from system_requirements import skip_unless_system  # noqa: E402
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "freecad-part" / "e2e"))
from test_part_backend import HAVE_FREECAD, Harness, plate  # noqa: E402

PROFILE = {"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill", "material": "al6061"}


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
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


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
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


def _tap(name: str, x: float, **extra) -> list:
    return [
        {"op": "sketch", "name": f"plate/{name}_sketch", "on": {"feature": "plate/base", "role": "top"},
         "shapes": [{"circle": {"center": [x, 0], "diameter": 2.5}}]},
        {"op": "hole", "name": f"plate/{name}", "sketch": f"plate/{name}_sketch", "diameter": 2.5, "thread": "M3", "depth": 7.5, **extra},
    ]


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class DfmFeatureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness("plate", "plate")
        self.addCleanup(self.h.close)

    def full(self) -> list[dict]:
        from reify_freecad.dfm import lint

        return lint.evaluate_full(self.h.worker._ctx(self.h.session()))["issues"]

    def test_thread_depth_is_the_length_the_blind_extra_rule_reads(self) -> None:
        # M3 tap drill 7.5 mm: a 4.5 mm thread needs 4.5 + 2.5 = 7.0 mm (passes); a 6 mm thread needs 8.5 mm (warn).
        ops = [PROFILE, *plate("plate", 40, 30, 10), *_tap("short_tap", -10, thread_depth=4.5, drill_point="flat"), *_tap("long_tap", 10, thread_depth=6, drill_point="flat")]
        dfm = self.h.apply(ops)["dfm"]
        extra = [i for i in dfm["issues"] if i["rule"] == "hole.thread_blind_extra"]
        self.assertEqual([(i["target"], i["severity"], i["measured"], i["limit"]) for i in extra], [("plate/long_tap", "warn", 7.5, 8.5)])
        issues = self.full()
        self.assertEqual({i["target"] for i in issues if i["rule"] == "hole.bottom_shape"}, set(),
                         "both drill points are flat: no cone-bottom info")

    def test_a_cone_bottom_blind_hole_is_info_and_a_flat_one_is_not(self) -> None:
        ops = [PROFILE, *plate("plate", 40, 30, 10), *_tap("cone_tap", -10), *_tap("flat_tap", 10, drill_point="flat")]
        self.h.apply(ops)
        self.assertEqual([i["target"] for i in self.full() if i["rule"] == "hole.bottom_shape"], ["plate/cone_tap"])

    def test_dimension_tighter_than_class_m_is_info_on_its_requirement(self) -> None:
        # GB/T 1804-m for a 2.5 mm dimension is ±0.1 mm: ±0.02 is tighter (info); ±0.2 is looser.
        ops = [
            PROFILE, *plate("plate", 40, 30, 10), *_tap("tap", -10),
            {"op": "require", "name": "plate/tight_fit", "kind": "dimension", "target": {"target": "plate/tap", "prop": "Diameter"}, "limit": 2.5, "tolerance": 0.02},
            {"op": "require", "name": "plate/loose_fit", "kind": "dimension", "target": {"target": "plate/tap", "prop": "Diameter"}, "limit": 2.5, "tolerance": 0.2},
        ]
        self.h.apply(ops)
        general = [(i["target"], i["severity"], i["measured"], i["limit"]) for i in self.full() if i["rule"] == "tol.general"]
        self.assertEqual(general, [("plate/tight_fit", "info", 0.02, 0.1)])

    def test_a_linear_pattern_is_one_lint_target_on_its_original(self) -> None:
        ops = [
            PROFILE, *plate("plate", 40, 30, 10),
            {"op": "sketch", "name": "plate/pin_sketch", "on": {"feature": "plate/base", "role": "top"},
             "shapes": [{"circle": {"center": [-15, 0], "diameter": 1.0}}]},
            {"op": "hole", "name": "plate/pin", "sketch": "plate/pin_sketch", "diameter": 1.0, "type": "through_all"},
            {"op": "linear_pattern", "name": "plate/pin_row", "features": ["plate/pin"], "direction": "X", "length": 15, "count": 3},
        ]
        dfm = self.h.apply(ops)["dfm"]
        self.assertEqual([i["target"] for i in dfm["issues"] if i["rule"] == "hole.min_diameter"], ["plate/pin"])
        from reify_freecad.dfm.extract import extract_facts

        facts = extract_facts(self.h.worker._ctx(self.h.session()))
        pin = next(h for h in facts["holes"] if h["path"] == "plate/pin")
        self.assertEqual((pin["pattern"], pin["instances"]), ("plate/pin_row", 3))


if __name__ == "__main__":
    unittest.main()
