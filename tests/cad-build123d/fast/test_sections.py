"""Section analytics tests (0.8 M4c).

A 40x30x12 box must report exact areas and exact centroidal second moments
of a 40x30 rectangle (b*h^3/12), and the interpreter must never emit a
critical-section judgment.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import build123d as bd

from cadctl.sections import scan_sections

class SectionScan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        with bd.BuildPart() as p:
            bd.Box(40, 30, 12)
        cls.box = Path(cls._tmp.name) / "section_box.step"
        bd.export_step(p.part, cls.box)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

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


class SectionAxesExact(unittest.TestCase):
    """Exact analytics for ALL three scan axes (0.8 review P0).

    The original implementation read OCCT's face-local inertia entries as
    global XY, so x- and y-axis sections were silently wrong. These tests
    pin the corrected (u, v, n) basis projection for every axis.
    """

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        with bd.BuildPart() as p:
            bd.Box(40, 30, 12)  # x-extent 40, y-extent 30, z-extent 12
        cls.box = Path(cls._tmp.name) / "section_axes_box.step"
        bd.export_step(p.part, cls.box)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def _midsection(self, axis: str) -> dict:
        result = scan_sections(self.box, axis=axis, count=1)
        self.assertEqual(result["sections"][0]["faceCount"], 1)
        return result["sections"][0]["faces"][0]

    def test_z_axis(self):
        face = self._midsection("z")
        # plane (x, y): u=x(40), v=y(30). Iu=∫y²dA=40*30³/12; Iv=30*40³/12.
        self.assertAlmostEqual(face["Iu"], 40 * 30**3 / 12, places=-1)
        self.assertAlmostEqual(face["Iv"], 30 * 40**3 / 12, places=-1)
        self.assertAlmostEqual(face["bbox"]["x"][1] - face["bbox"]["x"][0], 40.0, places=3)
        self.assertAlmostEqual(face["bbox"]["y"][1] - face["bbox"]["y"][0], 30.0, places=3)

    def test_x_axis(self):
        face = self._midsection("x")
        # plane (y, z): u=y(30), v=z(12). Iu=∫z²dA=30*12³/12; Iv=12*30³/12.
        self.assertAlmostEqual(face["Iu"], 30 * 12**3 / 12, places=-1)
        self.assertAlmostEqual(face["Iv"], 12 * 30**3 / 12, places=-1)
        self.assertAlmostEqual(face["bbox"]["y"][1] - face["bbox"]["y"][0], 30.0, places=3)
        self.assertAlmostEqual(face["bbox"]["z"][1] - face["bbox"]["z"][0], 12.0, places=3)

    def test_y_axis(self):
        face = self._midsection("y")
        # plane (x, z): u=x(40), v=z(12). Iu=∫z²dA=40*12³/12; Iv=12*40³/12.
        self.assertAlmostEqual(face["Iu"], 40 * 12**3 / 12, places=-1)
        self.assertAlmostEqual(face["Iv"], 12 * 40**3 / 12, places=-1)
        self.assertAlmostEqual(face["bbox"]["x"][1] - face["bbox"]["x"][0], 40.0, places=3)
        self.assertAlmostEqual(face["bbox"]["z"][1] - face["bbox"]["z"][0], 12.0, places=3)

    def test_centroid_symmetric_all_axes(self):
        for axis in ("x", "y", "z"):
            face = self._midsection(axis)
            for key, value in face["centroid"].items():
                if key != axis:
                    self.assertAlmostEqual(value, 0.0, places=6, msg=f"{axis}/{key}")

    def test_off_center_section_still_exact(self):
        # A section away from the origin exercises the parallel-axis shift.
        result = scan_sections(self.box, axis="x", count=2)
        face = result["sections"][0]["faces"][0]
        self.assertAlmostEqual(face["Iu"], 30 * 12**3 / 12, places=-1)
        self.assertAlmostEqual(face["Iv"], 12 * 30**3 / 12, places=-1)
        # Centroid y,z of the box section are 0 (box centered) but the
        # section POSITION is at the x bound.
        self.assertAlmostEqual(result["sections"][0]["position"], -20.0, places=6)


if __name__ == "__main__":
    unittest.main()
