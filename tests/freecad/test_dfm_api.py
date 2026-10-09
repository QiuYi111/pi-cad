"""``cad.part`` DFM API, end to end: apply, ``PartResult.dfm``, ``doc.dfm()``, and the report file.

The calls go through the real Agent API bridge (``scripts/pi-cad-agent-api.mjs``) to the real FreeCAD
worker, the same way a Prime kernel calls them. A workflow run is started first, because part
operations need one. Skipped without FreeCAD.

    PYTHONPATH=python:skills/cad/src:<env>/lib PI_CAD_FREECAD_PYTHON=<env>/bin/python <env>/bin/python -m unittest tests/freecad/test_dfm_api.py
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "skills" / "cad" / "src"))
from test_part_backend import HAVE_FREECAD  # noqa: E402

OPS = ROOT / "skills" / "parametric-cad-modeling" / "assets" / "freecad-part" / "dfm.ops.json"

# Starts a v7 workflow run in the project, as the desktop does for a model build. Imports go through jiti
# by absolute path, so the helper can live in a temporary directory.
START_RUN = """
import {{ createJiti }} from "{root}/node_modules/jiti/lib/jiti.mjs";
const jiti = createJiti("{root}/tests/run-ts-tests.mjs", {{ moduleCache: false }});
const load = (path) => jiti.import(`{root}/${{path}}`, {{ default: true }});
const {{ bootstrapAgentApiContracts }} = await load("src/agent-api/bootstrap.ts");
const {{ mechanicalRegistries }} = await load("src/domains/mechanical/registries.ts");
const {{ buildRegistryContract }} = await load("src/harness/registry-contract.ts");
const {{ HarnessProjectStoreV7 }} = await load("src/harness/run-store.ts");
const {{ compileWorkflowDefinition }} = await load("src/harness/workflow/compiler.ts");
bootstrapAgentApiContracts();
const workflow = compileWorkflowDefinition({{
  schema: 1, id: "test/dfm-api", version: "1.0.0", parametersSchema: {{}}, initialPhase: "build",
  phases: {{
    build: {{
      purpose: "Build and revise a part", actions: ["cad_build_step", "transition"],
      grants: ["model_build", "observe", "observe_programmable", "transition"],
      writeScopes: ["project:deliverable"], recordObligations: [],
      evidenceObligations: [
        {{ ref: "candidate-visual", type: "visual", closeWith: "cad_build_step" }},
        {{ ref: "candidate-geometry", type: "geometry", closeWith: "cad_build_step" }},
      ],
      contextProviders: ["kernel.current-action"], hooks: [],
      transitions: {{ built: {{ target: "done", requiresPhaseObligations: true }} }},
    }},
    done: {{ purpose: "Done", actions: [], grants: [], writeScopes: [], recordObligations: [], evidenceObligations: [],
      contextProviders: ["kernel.current-action"], hooks: [], transitions: {{}}, terminal: true }},
  }},
}}, mechanicalRegistries);
await new HarnessProjectStoreV7(process.argv[2]).startRun({{ workflow, registryContract: buildRegistryContract(mechanicalRegistries) }});
"""


def ops_with_tap_drill(diameter: float) -> list[dict[str, Any]]:
    """The copyable DFM example, with the M3 tap drill set to ``diameter`` (2.5 is right, 2.4 is the wrong tap)."""
    ops = json.loads(OPS.read_text(encoding="utf-8"))
    for op in ops:
        if op.get("op") == "param" and op.get("name") == "m3_tap_drill":
            op["value"] = diameter
    return ops


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class DfmApiTests(unittest.TestCase):
    def setUp(self) -> None:
        import cad.part as cad_part  # noqa: PLC0415 -- needs the path set above

        self.cad_part = cad_part
        self.project = Path(tempfile.mkdtemp(prefix="reify-dfm-api-project-"))
        self.canonical = Path(tempfile.mkdtemp(prefix="reify-dfm-api-canonical-"))
        self.addCleanup(shutil.rmtree, self.project, True)
        self.addCleanup(shutil.rmtree, self.canonical, True)
        self.images: list[dict[str, Any]] = []

        async def record(images: list[dict[str, Any]], *_args: Any, **_kwargs: Any) -> None:
            # Prime's image channel is not present here; the images are what the API hands it.
            self.images.extend(images)

        patcher = patch.object(cad_part, "_attach_images", record)
        patcher.start()
        self.addCleanup(patcher.stop)
        env = {
            "PI_CAD_PROJECT_CWD": str(self.project),
            "PI_CAD_CANONICAL_PROJECT_DIR": str(self.canonical),
            "PI_CAD_REPO": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        env_patcher = patch.dict(os.environ, env)
        env_patcher.start()
        self.addCleanup(env_patcher.stop)
        helper = Path(tempfile.mkdtemp(prefix="reify-dfm-api-helper-"))
        self.addCleanup(shutil.rmtree, helper, True)
        script = helper / "start-run.mjs"
        script.write_text(START_RUN.format(root=ROOT.as_posix()), encoding="utf-8")
        subprocess.run(["node", str(script), str(self.project)], check=True, cwd=str(ROOT), capture_output=True, text=True, timeout=300)

    def run_async(self, coro: Any) -> Any:
        return asyncio.run(coro)

    def test_good_plate_apply_then_geometry_check(self) -> None:
        async def scenario() -> tuple[Any, Any]:
            doc = await self.cad_part.open("parts/bracket.FCStd", create=True, body="bracket")
            applied = await doc.apply(ops_with_tap_drill(2.5))
            report = await doc.dfm()
            return applied, report

        applied, report = self.run_async(scenario())

        self.assertIsNotNone(applied.dfm, "the apply result carries the DFM summary")
        self.assertEqual(applied.dfm["rulepack"], "quanzhou.cnc_mill")
        self.assertEqual((applied.dfm["counts"]["error"], applied.dfm["counts"]["warn"]), (0, 0), applied.dfm["issues"])
        self.assertIn("DFM (quanzhou.cnc_mill, lint): 0 error, 0 warn", repr(applied))

        self.assertEqual(report.counts["error"], 0, report.issues)
        self.assertEqual(report.counts["warn"], 0, report.issues)
        self.assertEqual(report.rulepack, "quanzhou.cnc_mill")
        self.assertTrue(report.coverage, "every rule is accounted for in coverage")
        report_file = self.project / report.report_path
        self.assertTrue(report_file.is_file(), report.report_path)
        self.assertEqual(json.loads(report_file.read_text(encoding="utf-8"))["rev"], report.rev)
        self.assertTrue(repr(report).startswith("DFM (quanzhou.cnc_mill, "), repr(report))
        self.assertEqual({image["mimeType"] for image in self.images}, {"image/png"})
        self.assertTrue(self.images, "the report attaches its views")

    def test_wrong_tap_apply_then_geometry_check_reports_the_tap_drill(self) -> None:
        async def scenario() -> tuple[Any, Any]:
            doc = await self.cad_part.open("parts/bracket.FCStd", create=True, body="bracket")
            applied = await doc.apply(ops_with_tap_drill(2.4))
            report = await doc.dfm()
            return applied, report

        applied, report = self.run_async(scenario())

        self.assertIsNotNone(applied.dfm)
        self.assertIn("hole.thread_tap_drill", [issue["rule"] for issue in applied.dfm["issues"]])
        self.assertIn("hole.thread_tap_drill", repr(applied))

        errors = [issue for issue in report.issues if issue["severity"] == "error"]
        self.assertEqual(report.counts["error"], 1, report.issues)
        self.assertEqual([issue["rule"] for issue in errors], ["hole.thread_tap_drill"])
        self.assertNotIn("hole.min_diameter", [issue["rule"] for issue in report.issues])
        self.assertIn("hole.thread_tap_drill", repr(report))
        self.assertTrue(report.highlighted, "the wrong tap's face is highlighted in the views")
        self.assertTrue((self.project / report.report_path).is_file())
        self.assertTrue(self.images)


class DfmSummaryTextTests(unittest.TestCase):
    """The text an agent reads: the DFM lines of ``PartResult`` and ``DfmReport``, and the export field. No FreeCAD needed."""

    def setUp(self) -> None:
        import cad.part as cad_part  # noqa: PLC0415
        from cad import transfer  # noqa: PLC0415

        self.cad_part = cad_part
        self.transfer = transfer

    def test_part_result_adds_the_dfm_summary_lines(self) -> None:
        part = {"dfm": {
            "rulepack": "quanzhou.cnc_mill", "material": "al6061", "layer": "lint",
            "counts": {"error": 1, "warn": 1, "info": 0, "pass": 3},
            "issues": [
                {"rule": "hole.min_diameter", "severity": "warn", "target": "bracket/side", "message": "thin", "measured": 1.3, "limit": 1.5, "unit": "mm"},
                {"rule": "hole.thread_tap_drill", "severity": "error", "target": "bracket/m3_holes", "measured": 2.4, "limit": 2.5, "unit": "mm",
                 "message": "M3 tap drill should be phi2.5", "source": "quanzhou p.1"},
            ],
            "geometry": {"state": "none", "last_rev": None},
        }}
        result = self.cad_part.PartResult(rev=1, artifact=None, changes=None, part=part)
        lines = repr(result).splitlines()
        self.assertEqual(lines[1], "DFM (quanzhou.cnc_mill, lint): 1 error, 1 warn — geometry none; run doc.dfm() for the geometry check")
        self.assertEqual(lines[2], "- [error] hole.thread_tap_drill bracket/m3_holes: M3 tap drill should be phi2.5 (2.4/2.5 mm) — quanzhou p.1")
        self.assertEqual(lines[3], "- [warn] hole.min_diameter bracket/side: thin (1.3/1.5 mm)")
        self.assertEqual(len(lines), 4)

    def test_part_result_without_a_profile_has_no_dfm_lines(self) -> None:
        result = self.cad_part.PartResult(rev=1, artifact=None, changes=None, part={"dfm": None})
        self.assertIsNone(result.dfm)
        self.assertNotIn("DFM", repr(result))

    def test_dfm_report_lists_errors_and_warnings_and_the_skipped_count(self) -> None:
        issues = [{"rule": "info.rule", "severity": "info", "target": "x", "message": "m"}]
        issues += [{"rule": f"hole.r{index}", "severity": "error", "target": {"body": "bracket", "face": index, "centre": [0, 0, 0]},
                    "message": "bad", "measured": 1.0, "limit": 1.2, "unit": "mm", "source": "p.1"} for index in range(9)]
        report = self.cad_part.DfmReport(
            rulepack="quanzhou.cnc_mill", material="al6061", rev=3, analyzer="analysis_situs", issues=issues,
            counts={"error": 9, "warn": 0, "info": 1, "pass": 4},
            coverage=[{"rule": "a", "status": "checked"}, {"rule": "b", "status": "skipped", "reason": "analysis_situs_unavailable"}],
        )
        lines = repr(report).splitlines()
        self.assertEqual(lines[0], "DFM (quanzhou.cnc_mill, analysis_situs): 9 error, 0 warn, 1 info")
        self.assertEqual(len(lines), 1 + 8 + 1, "at most eight error or warning lines, then the skipped count")
        self.assertEqual(lines[1], "- [error] hole.r0 bracket#face0: bad (1/1.2 mm) — p.1")
        self.assertEqual(lines[-1], "skipped: 1 rules (see coverage)")

    def test_transfer_result_carries_the_dfm_state(self) -> None:
        wire = {"target": "fusion", "file": "exports/plate.f3d", "checkStep": None, "check": "passed", "features": 7,
                "dfm": {"counts": {"error": 2}, "geometry": {"state": "stale", "last_rev": 1}}}
        result = self.transfer._result_from_wire(wire)
        self.assertEqual(result.dfm, {"counts": {"error": 2}, "geometry": {"state": "stale", "last_rev": 1}})
        self.assertIsNone(self.transfer._result_from_wire({**wire, "dfm": None}).dfm)


if __name__ == "__main__":
    unittest.main()
