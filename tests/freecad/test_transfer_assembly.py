"""export_assembly: reify.assembly/1 from a linked-parts assembly document.

UPDATE_TRANSFER_GOLDEN=1 rewrites tests/fixtures/transfer/arm.assembly.json.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_assembly import Project, arm_part, base_part  # noqa: E402
from test_part_backend import HAVE_FREECAD, ROOT  # noqa: E402
from test_transfer_features import normalize  # noqa: E402

if HAVE_FREECAD:
    import Part

FIXTURE = ROOT / "tests" / "fixtures" / "transfer" / "arm.assembly.json"
ASM = "assembly/arm.FCStd"


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class TransferAssemblyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.p = Project()
        self.addCleanup(self.p.close)
        self.p.open("parts/base.FCStd", "base")
        self.p.call("parts/base.FCStd", "apply", ops=base_part())
        self.p.open("parts/link.FCStd", "link")
        self.p.call("parts/link.FCStd", "apply", ops=arm_part())
        self.p.open(ASM, "arm")

    def link_ops(self, angle: Any = 0) -> list[dict[str, Any]]:
        return [
            {"op": "param", "name": "j1_angle", "value": angle, "unit": "deg"},
            {"op": "link", "name": "arm/base", "part": "parts/base.FCStd", "body": "base"},
            {"op": "link", "name": "arm/link", "part": "parts/link.FCStd", "body": "link"},
            {"op": "joint", "name": "arm/j1", "type": "revolute", "flip": True, "value": "=j1_angle", "limits": [-90, 90],
             "parent": {"feature": "arm/base/plate", "role": "top"}, "child": {"feature": "arm/link/arm", "role": "bottom"}},
        ]

    def test_assembly_json_golden_and_reference(self) -> None:
        self.p.call(ASM, "apply", ops=self.link_ops(30))
        out = self.p.root / "transfer" / "arm.assembly.json"
        step = self.p.root / "transfer" / "arm.reference.step"
        result = self.p.call(ASM, "export-assembly", output=str(out), referenceStep=str(step))
        self.assertEqual((result["partCount"], result["occurrenceCount"], result["part"], result["path"], result["referenceStep"]), (2, 2, "arm", str(out), str(step)))
        data = result["assembly"]
        self.assertEqual(json.loads(out.read_text()), data)
        self.assertGreater(step.stat().st_size, 100)
        got = normalize(data)
        if os.environ.get("UPDATE_TRANSFER_GOLDEN"):
            FIXTURE.write_text(json.dumps(got, indent=2) + "\n", encoding="utf-8")
        self.assertEqual(got, json.loads(FIXTURE.read_text(encoding="utf-8")))
        self.assertEqual(data["schema"], "reify.assembly/1")
        parts = {p["ref"]: p for p in data["parts"]}
        self.assertEqual(sorted(parts), ["parts/base.FCStd", "parts/link.FCStd"])
        # PR #59 style `on: {feature, role}` hole sketches now export as plane + offset
        base_sketches = parts["parts/base.FCStd"]["features"]["bodies"][0]["sketches"]
        self.assertEqual([s["plane"] for s in base_sketches], [{"base": "XY", "offset": 0.0}, {"base": "XY", "offset": 6.0}])
        occurrences = {o["name"]: o for o in data["occurrences"]}
        self.assertEqual(occurrences["arm/base"]["transform"]["origin"], [0, 0, 0])
        # the joint (30 degrees, flipped) is already applied to the link occurrence
        link = occurrences["arm/link"]["transform"]
        import math

        self.assertAlmostEqual(link["origin"][2], 6.0, places=6)
        self.assertAlmostEqual(abs(link["rotation"][0][0]), math.cos(math.radians(30)), places=6)
        self.assertAlmostEqual(abs(link["rotation"][0][1]), math.sin(math.radians(30)), places=6)
        ref = data["reference"]
        self.assertEqual([v["name"] for v in ref["feature_volumes"]], ["arm/base", "arm/link"])
        self.assertAlmostEqual(ref["feature_volumes"][0]["volume_mm3"], 50 * 50 * 6 - 3.141592653589793 * 16 * 6, places=3)
        self.assertAlmostEqual(ref["volume_mm3"], sum(v["volume_mm3"] for v in ref["feature_volumes"]), places=6)
        self.assertEqual(ref["bbox"]["min"][2], 0.0)

    def test_export_features_points_to_export_assembly(self) -> None:
        self.p.call(ASM, "apply", ops=self.link_ops())
        error = self.p.error(ASM, "export_features")
        self.assertEqual(error["code"], "TRANSFER_UNSUPPORTED_OP")
        self.assertEqual((error["detail"]["op"], error["detail"]["option"]), ("assembly", "occurrence"))

    def test_read_only(self) -> None:
        self.p.call(ASM, "apply", ops=self.link_ops())
        before = Path(self.p.path(ASM)).read_bytes()
        rev = self.p.worker.sessions[self.p.path(ASM)].rev
        self.p.call(ASM, "export_assembly")
        self.assertEqual(Path(self.p.path(ASM)).read_bytes(), before)
        self.assertEqual(self.p.worker.sessions[self.p.path(ASM)].rev, rev)

    def test_bought_in_step_is_rejected_by_name(self) -> None:
        (self.p.root / "imports").mkdir()
        Part.makeBox(10, 10, 20).exportStep(self.p.path("imports/post.step"))
        self.p.call(ASM, "apply", ops=self.link_ops() + [{"op": "import_step", "name": "arm/post", "file": "imports/post.step", "position": [30, 15, 0]}])
        error = self.p.error(ASM, "export_assembly")
        self.assertEqual(error["code"], "TRANSFER_UNSUPPORTED_OP")
        self.assertEqual(error["target"], "arm/post")
        self.assertEqual((error["detail"]["op"], error["detail"]["option"]), ("import_step", "unknown_step_source"))

    def test_a_part_with_dressups_exports_inside_an_assembly(self) -> None:
        self.p.call("parts/link.FCStd", "apply", ops=[
            {"op": "fillet", "name": "link/edge_soft", "edges": {"feature": "link/arm", "role": "top_outer"}, "radius": 0.5},
        ])
        self.p.call(ASM, "apply", ops=self.link_ops())
        data = self.p.call(ASM, "export_assembly")["assembly"]
        link = next(p for p in data["parts"] if p["name"] == "link")
        self.assertEqual([f["type"] for f in link["features"]["bodies"][0]["features"]], ["pad", "hole", "fillet"])

    # ------------------------------------------------------------ import_step of a STEP that Reify wrote
    def post_step(self) -> Path:
        self.p.open("parts/post.FCStd", "post")
        self.p.call("parts/post.FCStd", "apply", ops=[
            {"op": "sketch", "name": "post/profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [10, 10]}}]},
            {"op": "pad", "name": "post/column", "sketch": "post/profile", "length": 20},
        ])
        return self.p.root / "build" / "post.step"

    def test_own_step_imports_become_occurrences_of_their_part(self) -> None:
        step = self.post_step()
        sidecar = Path(str(step) + ".source.json")
        source = json.loads(sidecar.read_text())
        self.assertEqual((source["schema"], source["fcstd"], source["body"], source["rev"], source["kind"]), ("reify.step-source/1", "parts/post.FCStd", "post", 1, "part"))
        import hashlib

        self.assertEqual(source["stepSha256"], hashlib.sha256(step.read_bytes()).hexdigest())
        self.assertEqual(source["fcstdSha256"], hashlib.sha256((self.p.root / "parts" / "post.FCStd").read_bytes()).hexdigest())
        self.p.call(ASM, "apply", ops=[
            {"op": "import_step", "name": "arm/post_1", "file": "build/post.step", "position": [30, 15, 0]},
            {"op": "import_step", "name": "arm/post_2", "file": "build/post.step", "position": [-30, 15, 0], "rotation": {"axis": [0, 0, 1], "angle": 90}},
        ])
        data = self.p.call(ASM, "export_assembly")["assembly"]
        self.assertEqual([p["ref"] for p in data["parts"]], ["parts/post.FCStd"])  # one part for both imports
        self.assertEqual(data["parts"][0]["features"]["bodies"][0]["features"][0]["name"], "post/column")
        occ = {o["name"]: o for o in data["occurrences"]}
        self.assertEqual(sorted(occ), ["arm/post_1", "arm/post_2"])
        self.assertEqual(occ["arm/post_1"]["transform"]["origin"], [30, 15, 0])
        self.assertEqual(occ["arm/post_2"]["transform"]["origin"], [-30, 15, 0])
        self.assertAlmostEqual(occ["arm/post_2"]["transform"]["rotation"][0][1], -1.0, places=6)
        self.assertEqual([v["volume_mm3"] for v in data["reference"]["feature_volumes"]], [2000.0, 2000.0])
        self.assertEqual(data["parts"][0]["features"]["reference"]["volume_mm3"], 2000.0)

    def test_links_and_own_step_imports_mix(self) -> None:
        self.post_step()
        self.p.call(ASM, "apply", ops=self.link_ops() + [{"op": "import_step", "name": "arm/post_1", "file": "build/post.step", "position": [30, 15, 0]}])
        data = self.p.call(ASM, "export_assembly")["assembly"]
        self.assertEqual(sorted(p["ref"] for p in data["parts"]), ["parts/base.FCStd", "parts/link.FCStd", "parts/post.FCStd"])
        self.assertEqual(len(data["occurrences"]), 3)

    def test_a_step_of_a_changed_part_is_stale(self) -> None:
        step = self.post_step()
        sidecar = Path(str(step) + ".source.json")
        old_step, old_sidecar = step.read_bytes(), sidecar.read_text()
        self.p.call(ASM, "apply", ops=[{"op": "import_step", "name": "arm/post_1", "file": "build/post.step"}])
        self.p.call("parts/post.FCStd", "apply", ops=[
            {"op": "sketch", "name": "post/cap_profile", "plane": "XY", "offset": 20, "shapes": [{"rect": {"center": [0, 0], "size": [4, 4]}}]},
            {"op": "pad", "name": "post/cap", "sketch": "post/cap_profile", "length": 3},
        ])
        # the part moved on but this STEP and its sidecar are the old ones (for example restored from a backup)
        step.write_bytes(old_step)
        sidecar.write_text(old_sidecar)
        error = self.p.error(ASM, "export_assembly")
        self.assertEqual(error["code"], "TRANSFER_UNSUPPORTED_OP")
        self.assertEqual((error["target"], error["detail"]["op"], error["detail"]["option"]), ("arm/post_1", "import_step", "stale_step"))
        self.assertIn("rebuild the part", error["hints"][0])

    def test_a_modified_step_or_a_missing_sidecar_is_unknown(self) -> None:
        step = self.post_step()
        self.p.call(ASM, "apply", ops=[{"op": "import_step", "name": "arm/post_1", "file": "build/post.step"}])
        sidecar = Path(str(step) + ".source.json")
        kept = sidecar.read_text()
        sidecar.unlink()
        error = self.p.error(ASM, "export_assembly")
        self.assertEqual((error["detail"]["option"], error["target"]), ("unknown_step_source", "arm/post_1"))
        sidecar.write_text(kept.replace('"stepSha256": "', '"stepSha256": "0'))
        self.assertEqual(self.p.error(ASM, "export_assembly")["detail"]["option"], "unknown_step_source")

    def test_try_does_not_leave_a_sidecar_for_its_step(self) -> None:
        self.post_step()
        scratch = self.p.root / "build" / "try.step"
        self.p.call("parts/post.FCStd", "try", output=str(scratch), ops=[
            {"op": "sketch", "name": "post/cap_profile", "plane": "XY", "offset": 20, "shapes": [{"rect": {"center": [0, 0], "size": [4, 4]}}]},
            {"op": "pad", "name": "post/cap", "sketch": "post/cap_profile", "length": 3},
        ])
        self.assertTrue(scratch.exists())
        self.assertFalse(Path(str(scratch) + ".source.json").exists())


if __name__ == "__main__":
    unittest.main()
