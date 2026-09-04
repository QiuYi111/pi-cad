from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "plate.py"


def run_cadctl(*args: str, cwd: Path) -> dict:
    env = os.environ.copy()
    root = Path(__file__).resolve().parents[1]
    entries = [str(root / "python")]
    # The package venv is self-contained; only fall back to the target-mode
    # layout when it does not exist (its extensions may target another Python).
    if not (root / ".venv" / "bin" / "python").exists():
        site = root / ".python" / "site-packages"
        if site.exists():
            entries.append(str(site))
    env["PYTHONPATH"] = (
        os.pathsep.join(entries)
        + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    )
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

    def test_parameterized_build_calls_explicit_entrypoint(self) -> None:
        source = self.cwd / "parameterized.py"
        source.write_text(
            "import build123d as bd\n"
            "def build(parameters):\n"
            "    return bd.Box(parameters['width'], parameters['depth'], parameters['height'])\n",
            encoding="utf-8",
        )
        step = self.build / "parameterized.step"

        envelope = run_cadctl(
            "build",
            "--source",
            str(source),
            "--output",
            str(step),
            "--parameters-json",
            json.dumps({"width": 42, "depth": 17, "height": 9}),
            cwd=self.cwd,
        )

        self.assertTrue(envelope["ok"], envelope)
        inspected = run_cadctl("inspect", "--artifact", str(step), cwd=self.cwd)
        self.assertEqual(inspected["payload"]["bbox"], {"x": 42.0, "y": 17.0, "z": 9.0})
        self.assertIn("parameters", envelope["inputHashes"])

    def test_build_cache_tracks_imported_local_source(self) -> None:
        helper = self.cwd / "dimensions.py"
        helper.write_text("WIDTH = 31\n", encoding="utf-8")
        source = self.cwd / "cached.py"
        source.write_text(
            "import build123d as bd\nfrom dimensions import WIDTH\nresult = bd.Box(WIDTH, 12, 7)\n",
            encoding="utf-8",
        )
        output = self.build / "cached.step"

        first = run_cadctl("build", "--source", str(source), "--output", str(output), cwd=self.cwd)
        second = run_cadctl("build", "--source", str(source), "--output", str(output), cwd=self.cwd)
        self.assertEqual(first["payload"]["cache"], "miss")
        self.assertEqual(second["payload"]["cache"], "hit")
        self.assertEqual(first["inputHashes"]["sourceClosure"], second["inputHashes"]["sourceClosure"])
        self.assertIn(str(helper.resolve()), first["payload"]["sourceFiles"])

        helper.write_text("WIDTH = 47\n", encoding="utf-8")
        third = run_cadctl("build", "--source", str(source), "--output", str(output), cwd=self.cwd)
        self.assertEqual(third["payload"]["cache"], "miss")
        self.assertNotEqual(first["inputHashes"]["sourceClosure"], third["inputHashes"]["sourceClosure"])
        inspected = run_cadctl("inspect", "--artifact", str(output), cwd=self.cwd)
        self.assertEqual(inspected["payload"]["bbox"]["x"], 47.0)

    def test_build_cache_ignores_comment_only_edits_and_force_bypasses_it(self) -> None:
        source = self.cwd / "comments.py"
        source.write_text("import build123d as bd\nresult = bd.Box(8, 9, 10)\n", encoding="utf-8")
        output = self.build / "comments.step"
        first = run_cadctl("build", "--source", str(source), "--output", str(output), cwd=self.cwd)
        source.write_text("# harmless\nimport build123d as bd\nresult = bd.Box(8, 9, 10)\n", encoding="utf-8")
        second = run_cadctl("build", "--source", str(source), "--output", str(output), cwd=self.cwd)
        forced = run_cadctl("build", "--source", str(source), "--output", str(output), "--force", cwd=self.cwd)
        self.assertEqual(first["payload"]["cache"], "miss")
        self.assertEqual(second["payload"]["cache"], "hit")
        self.assertEqual(forced["payload"]["cache"], "miss")

    def test_concurrent_builds_share_one_serialized_result(self) -> None:
        source = self.cwd / "slow.py"
        source.write_text(
            "import time\nimport build123d as bd\ntime.sleep(0.4)\nresult = bd.Box(11, 12, 13)\n",
            encoding="utf-8",
        )
        output = self.build / "shared.step"

        def invoke() -> dict:
            return run_cadctl("build", "--source", str(source), "--output", str(output), cwd=self.cwd)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: invoke(), range(2)))
        self.assertEqual(sorted(item["payload"]["cache"] for item in results), ["hit", "miss"])
        self.assertEqual(results[0]["artifacts"][0]["sha256"], results[1]["artifacts"][0]["sha256"])
        self.assertTrue(all(item["inputArtifacts"] for item in results))

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
        self.assertEqual(
            payload["validity"],
            {
                "ok": True,
                "failureCount": 0,
                "reasons": [],
                "checks": {
                    "topology": True,
                    "closedShells": True,
                    "positiveVolume": True,
                    "selfIntersectionFree": True,
                },
                "solids": [
                    {
                        "solidIndex": 0,
                        "topologyValid": True,
                        "closedShells": True,
                        "signedVolume": payload["validity"]["solids"][0]["signedVolume"],
                        "positiveVolume": True,
                        "selfIntersecting": False,
                        "reasons": [],
                    }
                ],
            },
        )
        self.assertGreater(payload["validity"]["solids"][0]["signedVolume"], 0)
        self.assertEqual(len(payload["cylinders"]), 4)
        self.assertAlmostEqual(payload["volume"], 40000 - 4 * 3.141592653589793 * 9 * 5, places=1)
        self.assertTrue((self.evidence / "geometry.json").exists())

    def test_inspect_geometry_reports_an_open_surface_without_guessing_design_intent(self) -> None:
        source = self.cwd / "surface.py"
        source.write_text(
            "import build123d as bd\n"
            "result = bd.Face.make_rect(10, 20)\n",
            encoding="utf-8",
        )
        built = run_cadctl(
            "build",
            "--source",
            str(source),
            "--output",
            str(self.build / "surface.step"),
            cwd=self.cwd,
        )
        self.assertTrue(built["ok"])

        inspected = run_cadctl(
            "inspect",
            "--artifact",
            str(self.build / "surface.step"),
            cwd=self.cwd,
        )
        self.assertTrue(inspected["ok"])
        validity = inspected["payload"]["validity"]
        self.assertFalse(validity["ok"])
        self.assertEqual(validity["failureCount"], 1)
        self.assertEqual(validity["reasons"], ["noSolid"])
        self.assertEqual(validity["solids"], [])
        self.assertEqual(validity["checks"]["positiveVolume"], False)
        self.assertIsNone(validity["checks"]["selfIntersectionFree"])

    def test_self_intersection_is_reported_without_semantic_guessing(self) -> None:
        from unittest.mock import patch

        import build123d as bd
        from cadctl.geometry import _validity

        with patch("cadctl.geometry._is_self_intersecting", return_value=True):
            validity = _validity(bd.Box(10, 10, 10))
        self.assertFalse(validity["ok"])
        self.assertFalse(validity["checks"]["selfIntersectionFree"])
        self.assertIn("selfIntersecting", validity["solids"][0]["reasons"])

    def test_surface_ids_are_hash_bound_and_measureable(self) -> None:
        self._build_plate()
        step = self.build / "plate.step"
        surfaces = run_cadctl(
            "inspect-surfaces", "--artifact", str(step), cwd=self.cwd
        )
        self.assertTrue(surfaces["ok"], surfaces)
        cylinder = next(
            item for item in surfaces["payload"]["surfaces"] if item["type"] == "cylinder"
        )
        measured = run_cadctl(
            "measure",
            "--artifact",
            str(step),
            "--metric",
            "diameter",
            "--a",
            cylinder["id"],
            cwd=self.cwd,
        )
        self.assertTrue(measured["ok"], measured)
        self.assertEqual(measured["payload"]["value"], 6.0)

        changed_source = self.cwd / "changed.py"
        changed_source.write_text(
            "import build123d as bd\nresult = bd.Box(20, 20, 20)\n",
            encoding="utf-8",
        )
        changed = self.build / "changed.step"
        run_cadctl(
            "build", "--source", str(changed_source), "--output", str(changed), cwd=self.cwd
        )
        stale = run_cadctl(
            "measure",
            "--artifact",
            str(changed),
            "--metric",
            "area",
            "--a",
            cylinder["id"],
            cwd=self.cwd,
        )
        self.assertFalse(stale["ok"])
        self.assertIn("run preset='surfaces' again", stale["payload"]["error"])

    def test_surface_inspection_supports_multi_solid_artifacts(self) -> None:
        artifact = Path(__file__).resolve().parent / "fixtures" / "interference_clearance.step"
        inspected = run_cadctl(
            "inspect-surfaces",
            "--artifact",
            str(artifact),
            cwd=self.cwd,
        )
        self.assertTrue(inspected["ok"], inspected)
        self.assertGreaterEqual(inspected["payload"]["solidCount"], 2)
        ids = [item["id"] for item in inspected["payload"]["surfaces"]]
        self.assertEqual(len(ids), len(set(ids)))
        tree = run_cadctl("assembly-tree", "--artifact", str(artifact), cwd=self.cwd)
        occurrence_refs = {item["ref"] for item in tree["payload"]["occurrences"]}
        self.assertTrue(occurrence_refs)
        self.assertTrue(
            all(item["occurrenceRef"] in occurrence_refs for item in inspected["payload"]["surfaces"])
        )

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

    def test_targeted_visual_modes_and_occurrence_selection(self) -> None:
        artifact = Path(__file__).resolve().parent / "fixtures" / "interference_clearance.step"
        tree = run_cadctl("assembly-tree", "--artifact", str(artifact), cwd=self.cwd)
        target = tree["payload"]["occurrences"][0]["ref"]
        out = self.evidence / "diagnostic"
        rendered = run_cadctl(
            "render",
            "--artifact",
            str(artifact),
            "--out-dir",
            str(out),
            "--views",
            "iso,iso_opposite",
            "--display",
            "hidden_edges",
            "--focus-json",
            json.dumps([target]),
            "--explode",
            "0.5",
            "--width",
            "320",
            "--height",
            "240",
            cwd=self.cwd,
        )
        self.assertTrue(rendered["ok"], rendered)
        self.assertEqual([item["name"] for item in rendered["payload"]["views"]], ["iso", "iso_opposite"])
        self.assertEqual(rendered["payload"]["focus"], [target])
        self.assertEqual(rendered["payload"]["display"], "hidden_edges")
        self.assertTrue(all(Path(item["path"]).stat().st_size > 1000 for item in rendered["payload"]["views"]))

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
        self.assertEqual(len(tree["payload"]["artifactHash"]), 64)
        self.assertTrue(all(item["ref"].startswith("occ-") for item in tree["payload"]["occurrences"]))

        flat = Path(__file__).resolve().parent / "fixtures" / "interference_clearance.step"
        flat_tree = run_cadctl("assembly-tree", "--artifact", str(flat), cwd=self.cwd)
        self.assertEqual(flat_tree["payload"]["leafCount"], 2)
        self.assertEqual(len(flat_tree["payload"]["occurrences"]), 2)

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
                    "loads": [{"type": "nodal_force", "region": {"axis": "x", "side": "max"}, "vector": [0, 0, -10.0]}],
                }
            ),
            encoding="utf-8",
        )
        from cadctl.simulation.api import run_simulation

        simulation = run_simulation(str(analysis), str(self.evidence / "fea"), stage="run")
        self.assertEqual(simulation["backend"], "torch-fem")

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
