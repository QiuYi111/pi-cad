"""Section analytics tests (0.8 M4c).

A 40x30x12 box must report exact areas and exact centroidal second moments
of a 40x30 rectangle (b*h^3/12), and the interpreter must never emit a
critical-section judgment.
"""

from __future__ import annotations

import unittest
from pathlib import Path

import build123d as bd

from cadctl.sections import scan_sections

FIXTURES = Path(__file__).parent / "fixtures"


class SectionScan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        FIXTURES.mkdir(parents=True, exist_ok=True)
        with bd.BuildPart() as p:
            bd.Box(40, 30, 12)
        cls.box = FIXTURES / "section_box.step"
        bd.export_step(p.part, cls.box)

    def test_exact_area_and_moments_for_a_box(self):
        result = scan_sections(self.box, axis="z", count=3)
        self.assertEqual(result["units"], "mm")
        for section in result["sections"]:
            self.assertAlmostEqual(section["totalArea"], 40 * 30, places=6)
            face = section["faces"][0]
            self.assertEqual(face["loopCount"], 1)
            # Centroidal second moments of the 40(x) x 30(y) rectangle.
            # Iu is the moment about the u=x axis: height is the y extent,
            # so Iu = 40*30^3/12; Iv is about y with height x: 30*40^3/12.
            self.assertAlmostEqual(face["Iu"], 40 * 30**3 / 12, places=-1)
            self.assertAlmostEqual(face["Iv"], 30 * 40**3 / 12, places=-1)
            self.assertAlmostEqual(face["Iuv"], 0.0, places=3)
            principal = sorted(face["principalMoments"])
            self.assertAlmostEqual(principal[0], 40 * 30**3 / 12, places=-1)
            self.assertAlmostEqual(principal[1], 30 * 40**3 / 12, places=-1)

    def test_centroid_facts_and_bounds(self):
        result = scan_sections(self.box, axis="z", count=3)
        self.assertEqual(result["bounds"], [-6.0, 6.0])
        face = result["sections"][0]["faces"][0]
        self.assertAlmostEqual(face["centroid"]["x"], 0.0, places=6)
        self.assertAlmostEqual(face["centroid"]["y"], 0.0, places=6)

    def test_step_mode_walks_the_whole_axis(self):
        result = scan_sections(self.box, axis="x", step=3.5)
        # span is 40 -> positions at 0,3.5,...,38.5 (12 within the span,
        # the endpoint test uses <= hi + 1e-9; 42.0 exceeds it)
        self.assertEqual(result["positionCount"], 12)
        self.assertTrue(all(s["faceCount"] == 1 for s in result["sections"]))
        self.assertTrue(all(s["faceCount"] == 1 for s in result["sections"]))

    def test_single_count_gives_the_midplane(self):
        result = scan_sections(self.box, axis="z", count=1)
        self.assertEqual(len(result["sections"]), 1)
        self.assertAlmostEqual(result["sections"][0]["position"], 0.0, places=6)

    def test_validation_fails_closed(self):
        with self.assertRaises(ValueError):
            scan_sections(self.box, axis="q", count=3)
        with self.assertRaises(ValueError):
            scan_sections(self.box, axis="z")
        with self.assertRaises(ValueError):
            scan_sections(self.box, axis="z", count=3, step=1.0)
        with self.assertRaises(ValueError):
            scan_sections(self.box, axis="z", count=0)
        with self.assertRaises(ValueError):
            scan_sections(self.box, axis="z", step=-1.0)

    def test_no_judgment_vocabulary(self):
        blob = str(scan_sections(self.box, axis="z", count=2)).lower()
        blob = blob.replace("which section is critical is an engineering judgment", "")
        for word in ("failure", "failed", "bad", "verdict", "pass", "warning"):
            self.assertNotIn(word, blob)


if __name__ == "__main__":
    unittest.main()
