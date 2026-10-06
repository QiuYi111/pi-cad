from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from cadctl.fingerprints import match_faces, shape_fingerprints  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "face-fingerprints"


class FaceFingerprintTests(unittest.TestCase):
    def test_shared_vectors(self) -> None:
        files = sorted(FIXTURES.glob("*.json"))
        self.assertGreaterEqual(len(files), 5)
        for path in files:
            case = json.loads(path.read_text(encoding="utf-8"))
            with self.subTest(case=path.name):
                result = match_faces(case["before"], case["after"], case["diagonal"])
                self.assertEqual(result, case["expected"])

    def test_box_with_hole_fingerprints(self) -> None:
        import build123d as bd

        part = bd.Box(40, 20, 10) - bd.Cylinder(3, 10)
        prints, truncated = shape_fingerprints(part)
        self.assertFalse(truncated)
        self.assertEqual(len(prints), 7)
        kinds = sorted(item["type"] for item in prints)
        self.assertEqual(kinds, ["CYLINDER"] + ["PLANE"] * 6)
        cylinder = next(item for item in prints if item["type"] == "CYLINDER")
        self.assertAlmostEqual(cylinder["r"], 3.0, places=3)
        self.assertAlmostEqual(abs(cylinder["ax"][2]), 1.0, places=3)

    def test_widening_a_hole_changes_only_the_wall_and_faces_it_touches(self) -> None:
        import build123d as bd

        before, _ = shape_fingerprints(bd.Box(40, 20, 10) - bd.Cylinder(3, 10))
        after, _ = shape_fingerprints(bd.Box(40, 20, 10) - bd.Cylinder(4, 10))
        result = match_faces(before, after, 50.0)
        changed = [before[i]["type"] for i in result["unmatchedBefore"]]
        self.assertIn("CYLINDER", changed)
        self.assertIn(("CYLINDER"), [after[j]["type"] for j in result["unmatchedAfter"]])
        # Top and bottom faces lose area, so they change too; side faces do not.
        self.assertEqual(len(result["pairs"]), 4)


if __name__ == "__main__":
    unittest.main()
