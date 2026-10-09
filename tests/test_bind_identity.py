from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_cadctl_backend import run_cadctl  # noqa: E402

import build123d as bd  # noqa: E402


def _declarations(radius: float = 3.0) -> dict:
    return {
        "schema": 1,
        "assembly": "bracket",
        "entities": [
            {"call": "instance", "path": "bracket", "label": "bracket", "solidIndex": 0},
            {
                "call": "feature", "path": "bracket/mount_hole", "owner": "bracket", "kind": "hole",
                "selector": {"entity": "face", "type": "cylinder", "radius": radius,
                             "axisDirection": [0, 0, 1], "axisPoint": [10, 0, 0], "tolerance": 1e-4},
            },
            {
                "call": "faces", "path": "bracket/mount_hole/wall", "owner": "bracket/mount_hole",
                "selector": {"type": "cylinder", "radius": radius}, "expect": "one",
            },
        ],
    }


class BindIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.step = self.dir / "bracket.step"
        bd.export_step(bd.Box(40, 20, 10) - bd.Pos(10, 0, 0) * bd.Cylinder(3, 10), str(self.step))

    def _bind(self, declarations: dict) -> dict:
        path = self.dir / "bracket.step.declarations.json"
        path.write_text(json.dumps(declarations), encoding="utf-8")
        return run_cadctl("bind-identity", "--artifact", str(self.step), "--declarations", str(path), cwd=self.dir)

    def test_binding_writes_a_manifest_that_resolves_the_declared_path(self) -> None:
        envelope = self._bind(_declarations())
        self.assertTrue(envelope["ok"], envelope)
        manifest = self.dir / "bracket.step.identity.json"
        self.assertTrue(manifest.is_file())
        resolved = run_cadctl("identity", "resolve", "--artifact", str(self.step), "--target", "bracket/mount_hole", cwd=self.dir)
        self.assertTrue(resolved["ok"], resolved)

    def test_wrong_declaration_fails_with_a_structured_error(self) -> None:
        envelope = self._bind(_declarations(radius=7.0))
        self.assertFalse(envelope["ok"])
        self.assertEqual(envelope["payload"]["code"], "IDENTITY_BIND_FAILED")
        self.assertEqual(envelope["payload"]["paths"], ["bracket/mount_hole"])

    def test_axis_point_and_bbox_center_name_curved_faces_without_a_parametric_centroid(self) -> None:
        by_center = _declarations()
        by_center["entities"][1]["selector"] = {
            "entity": "face", "type": "cylinder", "radius": 3.0, "bboxCenter": [10, 0, 0], "tolerance": 1e-3,
        }
        self.assertTrue(self._bind(by_center)["ok"])
        # The same hole axis one millimetre away matches nothing: the selector is bounded, not nearest-match.
        off_axis = _declarations()
        off_axis["entities"][1]["selector"]["axisPoint"] = [11, 0, 0]
        failed = self._bind(off_axis)
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["payload"]["code"], "IDENTITY_BIND_FAILED")
        # axisPoint is the distance from the axis line, so any point along the axis matches.
        along = _declarations()
        along["entities"][1]["selector"]["axisPoint"] = [10, 0, 123]
        self.assertTrue(self._bind(along)["ok"])


if __name__ == "__main__":
    unittest.main()
