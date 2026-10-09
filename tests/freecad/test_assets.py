"""The copyable FreeCAD assets must run as shipped."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_assembly import Project  # noqa: E402
from test_part_backend import HAVE_FREECAD, ROOT, Harness  # noqa: E402

ASSETS = ROOT / "skills" / "parametric-cad-modeling" / "assets"


def ops(asset: str, name: str) -> list:
    return json.loads((ASSETS / asset / name).read_text())


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class AssetTests(unittest.TestCase):
    def test_part_asset(self) -> None:
        harness = Harness("bracket", "bracket")
        self.addCleanup(harness.close)
        result = harness.apply(ops("freecad-part", "part.ops.json"))
        self.assertEqual([item["status"] for item in result["intent"]], ["pass", "pass"])
        self.assertEqual(result["warnings"], [])
        edited = harness.apply(ops("freecad-part", "edit.ops.json"))
        self.assertEqual(edited["params"]["changed"], {"hole_d": [6.0, 8.0]})
        self.assertEqual(len(harness.call("query", target="bracket/mount_hole/wall", what=["faces"])["faces"]), 4)
        wall = harness.call("query", target="bracket/mount_hole/wall", what=["faces"])["faces"][0]
        self.assertAlmostEqual(wall["radius"], 4.0, places=3)

    def test_dfm_asset(self) -> None:
        harness = Harness("bracket", "bracket")
        self.addCleanup(harness.close)
        result = harness.apply(ops("freecad-part", "dfm.ops.json"))
        self.assertEqual(result["dfm"]["rulepack"], "quanzhou.cnc_mill")
        self.assertEqual((result["dfm"]["counts"]["error"], result["dfm"]["counts"]["warn"]), (0, 0), result["dfm"]["issues"])

    def test_assembly_asset(self) -> None:
        project = Project()
        self.addCleanup(project.close)
        project.open("parts/base.FCStd", "base")
        project.call("parts/base.FCStd", "apply", ops=ops("freecad-assembly", "base.ops.json"))
        project.open("parts/link.FCStd", "link")
        project.call("parts/link.FCStd", "apply", ops=ops("freecad-assembly", "link.ops.json"))
        project.open("assembly/arm.FCStd", "arm")
        result = project.call("assembly/arm.FCStd", "apply", ops=ops("freecad-assembly", "assembly.ops.json"))
        statuses = {item["path"]: item["status"] for item in result["intent"]}
        self.assertEqual(statuses, {"arm/j1": "pass", "arm/clearance": "pass"})
        sweep = project.call(
            "assembly/arm.FCStd", "sweep", param="arm/j1", range=[-90, 90], step=30,
            check={"kind": "clearance", "args": {"a": "arm/link", "b": "arm/base"}},
        )
        self.assertEqual(sweep["samples"], 7)


if __name__ == "__main__":
    unittest.main()
