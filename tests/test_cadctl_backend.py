from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "plate.py"


def run_cadctl(*args: str, cwd: Path) -> dict:
    env = os.environ.copy()
    root = Path(__file__).resolve().parents[1]
    env["PYTHONPATH"] = os.pathsep.join(
        str(p) for p in (root / "python", root / ".python" / "site-packages") if p.exists()
    ) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    proc = subprocess.run(
        [sys.executable, "-m", "cadctl", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr)
    return json.loads(proc.stdout)


class CadctlBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name)
        self.build = self.cwd / "build"
        self.evidence = self.cwd / "evidence"
        self.build.mkdir()
        self.evidence.mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _build_plate(self) -> dict:
        return run_cadctl(
            "build",
            "--source",
            str(FIXTURE),
            "--output",
            str(self.build / "plate.step"),
            cwd=self.cwd,
        )

    def test_build_produces_enveloped_step(self) -> None:
        envelope = self._build_plate()
        self.assertTrue(envelope["ok"])
        step = self.build / "plate.step"
        self.assertTrue(step.exists())
        self.assertEqual(envelope["tool"], "cad_build_step")
        self.assertEqual(envelope["artifacts"][0]["kind"], "step")
        self.assertEqual(envelope["artifacts"][0]["sha256"], envelope["outputHashes"][str(step)])

    def test_inspect_geometry_matches_plate(self) -> None:
        self._build_plate()
        envelope = run_cadctl(
            "inspect",
            "--artifact",
            str(self.build / "plate.step"),
            "--output",
            str(self.evidence / "geometry.json"),
            cwd=self.cwd,
        )
        self.assertTrue(envelope["ok"])
        payload = envelope["payload"]
        self.assertEqual(payload["bbox"]["x"], 100.0)
        self.assertEqual(payload["bbox"]["y"], 80.0)
        self.assertEqual(payload["bbox"]["z"], 5.0)
        self.assertEqual(payload["solidCount"], 1)
        self.assertEqual(len(payload["cylinders"]), 4)
        self.assertAlmostEqual(payload["volume"], 40000 - 4 * 3.141592653589793 * 9 * 5, places=1)
        self.assertTrue((self.evidence / "geometry.json").exists())

    def test_render_seven_views_are_not_blank(self) -> None:
        self._build_plate()
        out = self.evidence / "visual"
        envelope = run_cadctl(
            "render",
            "--artifact",
            str(self.build / "plate.step"),
            "--out-dir",
            str(out),
            "--width",
            "320",
            "--height",
            "240",
            cwd=self.cwd,
        )
        self.assertTrue(envelope["ok"])
        payload = envelope["payload"]
        self.assertEqual(len(payload["views"]), 7)
        from PIL import Image

        for view in payload["views"]:
            image = Image.open(view["path"])
            colors = image.getcolors(maxcolors=1_000_000)
            nonwhite = sum(count for count, color in colors if color != (255, 255, 255))
            self.assertGreater(nonwhite, 1000, f"view {view['name']} looks blank")

    def test_measure_diameter_and_hole_centers(self) -> None:
        self._build_plate()
        step = self.build / "plate.step"
        diameter = run_cadctl(
            "measure", "--artifact", str(step), "--metric", "diameter", "--a", "#c0", cwd=self.cwd
        )
        self.assertEqual(diameter["payload"]["value"], 6.0)

        horizontal = run_cadctl(
            "measure",
            "--artifact",
            str(step),
            "--metric",
            "distance",
            "--a",
            "#c0",
            "--b",
            "#c1",
            cwd=self.cwd,
        )
        self.assertEqual(horizontal["payload"]["value"], 80.0)

        diagonal = run_cadctl(
            "measure",
            "--artifact",
            str(step),
            "--metric",
            "distance",
            "--a",
            "#c0",
            "--b",
            "#c3",
            cwd=self.cwd,
        )
        self.assertEqual(diagonal["payload"]["value"], 100.0)


    def test_section_and_compare_and_assembly_tree(self) -> None:
        self._build_plate()
        step = self.build / "plate.step"

        section = run_cadctl(
            "section",
            "--artifact",
            str(step),
            "--out-dir",
            str(self.evidence / "section"),
            "--origin",
            "0,0,0",
            "--normal",
            "0,1,0",
            "--display",
            "hidden_edges",
            "--width",
            "320",
            "--height",
            "240",
            cwd=self.cwd,
        )
        self.assertTrue(section["ok"])
        self.assertEqual(section["payload"]["sectionFaceCount"], 1)
        self.assertTrue((self.evidence / "section" / "section.png").exists())

        compare = run_cadctl(
            "compare",
            "--before",
            str(step),
            "--after",
            str(step),
            "--output",
            str(self.evidence / "compare.json"),
            cwd=self.cwd,
        )
        self.assertTrue(compare["ok"])
        self.assertEqual(compare["payload"]["delta"]["volume"], 0.0)
        self.assertTrue((self.evidence / "compare.json").exists())

        tree = run_cadctl("assembly-tree", "--artifact", str(step), cwd=self.cwd)
        self.assertTrue(tree["ok"])
        self.assertGreaterEqual(tree["payload"]["leafCount"], 1)

    def test_export_and_capability(self) -> None:
        self._build_plate()
        step = self.build / "plate.step"
        exported = run_cadctl(
            "export",
            "--source",
            str(step),
            "--output",
            str(self.build / "plate.stl"),
            "--format",
            "stl",
            cwd=self.cwd,
        )
        self.assertTrue(exported["ok"])
        self.assertTrue((self.build / "plate.stl").exists())

        caps = run_cadctl("capability", cwd=self.cwd)
        self.assertTrue(caps["ok"])
        self.assertIn("geometry", caps["payload"]["capabilities"])

    def test_drawing_generate_and_simulation_unavailable(self) -> None:
        self._build_plate()
        step = self.build / "plate.step"
        spec = self.cwd / "drawing-spec.json"
        spec.write_text(
            json.dumps(
                {
                    "artifact": str(step),
                    "units": "mm",
                    "sheet": {"width": 297, "height": 210},
                    "views": [{"name": "front"}],
                    "dimensions": [{"p1": [10, 10], "p2": [60, 10], "text": "50", "feature_refs": ["#c0"]}],
                    "notes": ["V0 drawing test"],
                }
            ),
            encoding="utf-8",
        )
        drawing = run_cadctl(
            "drawing",
            "generate",
            "--spec",
            str(spec),
            "--output-dir",
            str(self.evidence / "drawing"),
            cwd=self.cwd,
        )
        self.assertTrue(drawing["ok"])
        self.assertTrue((self.evidence / "drawing" / "drawing.dxf").exists())

        analysis = self.cwd / "analysis-spec.json"
        analysis.write_text(
            json.dumps(
                {
                    "backend": "torch-fem",
                    "device": "auto",
                    "physics": {"type": "linear_elasticity"},
                    "mesh": {"element": "tet", "box": [20, 10, 2], "size": 2.0},
                    "materials": [{"name": "steel", "E": 210000.0, "nu": 0.3}],
                    "constraints": [{"type": "fixed", "region": {"axis": "x", "side": "min"}}],
                    "loads": [{"type": "force", "region": {"axis": "x", "side": "max"}, "vector": [0, 0, -10.0]}],
                }
            ),
            encoding="utf-8",
        )
        sim = run_cadctl(
            "simulate",
            "run",
            "--spec",
            str(analysis),
            "--output-dir",
            str(self.evidence / "fea"),
            cwd=self.cwd,
        )
        self.assertTrue(sim["ok"])
        self.assertEqual(sim["payload"]["backend"], "torch-fem")

    def test_failed_model_returns_envelope_not_traceback(self) -> None:
        bad = self.cwd / "bad.py"
        bad.write_text("this is not python", encoding="utf-8")
        envelope = run_cadctl(
            "build", "--source", str(bad), "--output", str(self.build / "bad.step"), cwd=self.cwd
        )
        self.assertFalse(envelope["ok"])
        self.assertIn("error", envelope["payload"])
        self.assertFalse((self.build / "bad.step").exists())


if __name__ == "__main__":
    unittest.main()
