"""DFM geometry layer through the real Worker: the ``dfm`` command, the geometry state and the built-in fallback.

Run with the FreeCAD environment's Python, as in test_dfm_e2e.py:

    E=~/.local/share/pi-cad/runtimes/freecad/env
    PYTHONPATH=python:$E/lib PI_CAD_FREECAD_PYTHON=$E/bin/python $E/bin/python -m unittest tests/dfm/e2e/test_dfm_geometry.py -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from system_requirements import skip_unless_system  # noqa: E402
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "tests" / "fixtures" / "dfm" / "good_plate"
sys.path.insert(0, str(Path(__file__).resolve().parent))

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "freecad-part" / "e2e"))
from test_part_backend import HAVE_FREECAD, Harness, plate  # noqa: E402

PROFILE_OP = "dfm_profile"
CHANGE = [{"op": "set", "target": "part/slot_pocket", "prop": "Length", "value": 2.5}]


def good_plate_ops() -> list[dict[str, Any]]:
    return json.loads((FIXTURE / "part.ops.json").read_text(encoding="utf-8"))


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class DfmCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.saved_asi = os.environ.pop("PI_CAD_ASI_BIN", None)
        self.h = Harness(name="good_plate")
        self.addCleanup(self.h.close)
        self.addCleanup(self._restore_asi)
        self.h.apply(good_plate_ops())

    def _restore_asi(self) -> None:
        os.environ.pop("PI_CAD_ASI_BIN", None)
        if self.saved_asi is not None:
            os.environ["PI_CAD_ASI_BIN"] = self.saved_asi

    def test_dfm_on_good_plate_has_no_error_and_writes_the_report(self) -> None:
        report = self.h.call("dfm")
        self.assertEqual(report["counts"]["error"], 0, report["issues"])
        self.assertEqual(report["counts"]["warn"], 0, report["issues"])
        path = Path(report["report_path"])
        self.assertTrue(path.is_file(), path)
        self.assertEqual(path.parent.name, "dfm")
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["rev"], report["rev"])
        self.assertIn(report["analyzer"], ("analysis_situs", "builtin"))
        self.assertIn("rulepack", report)
        self.assertIn("highlight", report)
        self.assertIn("annotations", report)

    def test_geometry_is_fresh_for_a_try_and_stale_after_a_committed_change(self) -> None:
        before = self.h.call("apply", ops=[{"op": "set", "target": "part/slot_pocket", "prop": "Length", "value": 3}])
        self.assertEqual(before["dfm"]["geometry"]["state"], "none")
        self.h.call("dfm")
        tried = self.h.call("try", ops=CHANGE, output=str(self.h.root / "try.step"))
        self.assertEqual(tried["dfm"]["geometry"]["state"], "fresh")
        applied = self.h.call("apply", ops=CHANGE)
        self.assertEqual(applied["dfm"]["geometry"]["state"], "stale", "a committed apply makes a new revision")
        self.assertEqual(applied["dfm"]["geometry"]["last_rev"], before["rev"])

    def test_dfm_without_a_profile_is_an_error(self) -> None:
        h = Harness(name="no_profile")
        self.addCleanup(h.close)
        h.apply(plate("part", 40, 30, 5))
        error = h.error("dfm")
        self.assertEqual(error["code"], "OP_SCHEMA_INVALID")
        self.assertIn("set a dfm_profile first", error["message"])

    def test_without_reify_asi_the_report_is_builtin_and_skips_what_needs_it(self) -> None:
        os.environ["PI_CAD_ASI_BIN"] = "/nonexistent/reify-asi"
        report = self.h.call("dfm")
        self.assertEqual(report["analyzer"], "builtin")
        skipped = {c["rule"]: c["reason"] for c in report["coverage"] if c["status"] == "skipped"}
        self.assertEqual(skipped.get("surface.multi_face"), "analysis_situs_unavailable")
        self.assertEqual(report["counts"]["error"], 0, report["issues"])


def scoop_ops() -> list[dict[str, Any]]:
    """A 40 x 30 x 5 plate with a cylindrical scoop cut across the top and another across the bottom."""
    return [
        {"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill", "material": "al6061"},
        {"op": "sketch", "name": "part/profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [40, 30]}}]},
        {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 5},
        {"op": "sketch", "name": "part/top_scoop", "plane": "XZ", "offset": 15,
         "shapes": [{"circle": {"center": [0, 7.5], "diameter": 8}}]},
        {"op": "pocket", "name": "part/top_scoop_cut", "sketch": "part/top_scoop", "depth": 40},
        {"op": "sketch", "name": "part/bottom_scoop", "plane": "XZ", "offset": 15,
         "shapes": [{"circle": {"center": [0, -2.5], "diameter": 8}}]},
        {"op": "pocket", "name": "part/bottom_scoop_cut", "sketch": "part/bottom_scoop", "depth": 40},
    ]


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class CurvedBothSidesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.saved_asi = os.environ.pop("PI_CAD_ASI_BIN", None)
        self.addCleanup(self._restore_asi)

    def _restore_asi(self) -> None:
        os.environ.pop("PI_CAD_ASI_BIN", None)
        if self.saved_asi is not None:
            os.environ["PI_CAD_ASI_BIN"] = self.saved_asi

    def _curved_both_sides(self, report: dict[str, Any]) -> list[dict[str, Any]]:
        return [i for i in report["issues"] if i["rule"] == "surface.double_side_curved"]

    def test_scoops_on_both_faces_fire_the_rule(self) -> None:
        h = Harness(name="scoop")
        self.addCleanup(h.close)
        h.apply(scoop_ops())
        report = h.call("dfm")
        hits = self._curved_both_sides(report)
        self.assertEqual(len(hits), 1, report["issues"])
        self.assertEqual(hits[0]["severity"], "error")
        self.assertEqual(hits[0]["layer"], "geometry")

    def test_outer_edge_fillets_on_both_faces_do_not_fire_the_rule(self) -> None:
        h = Harness(name="double_fillet")
        self.addCleanup(h.close)
        h.apply(json.loads((ROOT / "tests" / "fixtures" / "dfm" / "double_fillet" / "part.ops.json").read_text(encoding="utf-8")))
        report = h.call("dfm")
        self.assertEqual(self._curved_both_sides(report), [], report["issues"])
        self.assertTrue(any(i["rule"] == "edge.double_side_fillet" for i in report["issues"]), report["issues"])


if __name__ == "__main__":
    unittest.main()
