"""Interference interpreter tests (0.8 M3).

Three fixtures cover the three states: overlapping boxes (penetration),
face-touching boxes (contact), separated boxes (clearance). The
interpreter must report facts with exact volumes/distances and never a
pass/fail judgment.
"""

from __future__ import annotations

import unittest
from pathlib import Path

import build123d as bd

from cadctl.interference import inspect_interference

FIXTURES = Path(__file__).parent / "fixtures"


def _box(size: float = 20.0, **align) -> bd.Part:
    align_args = align or {
        "align": (bd.Align.CENTER, bd.Align.CENTER, bd.Align.CENTER)
    }
    with bd.BuildPart() as p:
        bd.Box(size, size, size, **align_args)
    return p.part


def _write(compound: bd.Compound, name: str) -> Path:
    path = FIXTURES / name
    bd.export_step(compound, path)
    return path


class InterferenceFacts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        FIXTURES.mkdir(parents=True, exist_ok=True)
        a = _box()
        b = _box()
        cls.penetration = _write(
            bd.Compound([a, b.moved(bd.Location((10, 0, 0)))]), "interference_penetration.step"
        )
        cls.contact = _write(
            bd.Compound(
                [
                    _box(align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)),
                    _box(align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MAX)),
                ]
            ),
            "interference_contact.step",
        )
        cls.clearance = _write(
            bd.Compound([a, b.moved(bd.Location((45, 0, 0)))]), "interference_clearance.step"
        )

    def test_penetration_reports_exact_common_volume(self):
        result = inspect_interference(self.penetration)
        self.assertEqual(result["partCount"], 2)
        self.assertEqual(result["pairCount"], 1)
        pair = result["pairs"][0]
        self.assertEqual(pair["classification"], "penetration")
        # 10 mm overlap of two 20 mm boxes -> 10*20*20.
        self.assertAlmostEqual(pair["intersectionVolume"], 4000.0, places=3)
        self.assertEqual(pair["minDistance"], 0.0)

    def test_intentional_contact_is_contact_not_failure(self):
        result = inspect_interference(self.contact)
        pair = result["pairs"][0]
        self.assertEqual(pair["classification"], "contact")
        self.assertAlmostEqual(pair["intersectionVolume"], 0.0, places=6)
        self.assertLessEqual(pair["minDistance"], result["tolerances"]["distanceTolerance"])

    def test_clearance_reports_exact_gap(self):
        result = inspect_interference(self.clearance)
        pair = result["pairs"][0]
        self.assertEqual(pair["classification"], "clearance")
        self.assertAlmostEqual(pair["minDistance"], 25.0, places=3)
        self.assertAlmostEqual(pair["intersectionVolume"], 0.0, places=9)

    def test_no_judgment_vocabulary(self):
        for path in (self.penetration, self.contact, self.clearance):
            blob = str(inspect_interference(path))
            for word in ("fail", "bad", "error", "invalid", "ok"):
                self.assertNotIn(word, blob.lower())

    def test_single_part_has_no_pairs(self):
        single = _write(bd.Compound([_box()]), "interference_single.step")
        result = inspect_interference(single)
        self.assertEqual(result["partCount"], 1)
        self.assertEqual(result["pairCount"], 0)
        self.assertEqual(result["summary"], {"penetration": 0, "contact": 0, "clearance": 0})

    def test_three_parts_pairwise(self):
        a = _box()
        assembly = bd.Compound(
            [
                a,
                _box().moved(bd.Location((10, 0, 0))),
                _box().moved(bd.Location((100, 0, 0))),
            ]
        )
        path = _write(assembly, "interference_three.step")
        result = inspect_interference(path)
        self.assertEqual(result["pairCount"], 3)
        # boxes at x=0 and x=10 overlap; box at x=100 clears both.
        classifications = sorted(p["classification"] for p in result["pairs"])
        self.assertEqual(classifications, ["clearance", "clearance", "penetration"])


if __name__ == "__main__":
    unittest.main()
