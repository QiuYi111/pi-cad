"""Tests for disposable programmable B-Rep experiments (cadctl probe).

Covers the MVP acceptance criteria:
  1. arbitrary derived computation (bbox ratio / volume / solid count);
  2. subject binding + envelope hashes (script + artifact);
  3. arbitrary Python and scratch writes leave the original artifact unchanged;
  4. infinite loops are killed by the alarm timeout;
  5. probe artifacts and temporary files are discarded after execution;
  6. result must be JSON-serializable and named `result`.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import build123d as bd

ROOT = Path(__file__).resolve().parents[1]
STEP_FIXTURE = ROOT / "tests" / "fixtures" / "interference_contact.step"

PROBE_CODE = """
bb = shape.bounding_box()
result = {
    "volume": shape.volume,
    "bbox": [bb.size.X, bb.size.Y, bb.size.Z],
    "shape_factor": shape.volume / (bb.size.X * bb.size.Y * bb.size.Z),
    "solid_count": len(shape.solids()),
}
"""


def cadctl_env() -> dict[str, str]:
    env = os.environ.copy()
    entries = [str(ROOT / "python")]
    if not (ROOT / ".venv" / "bin" / "python").exists():
        site = ROOT / ".python" / "site-packages"
        if site.exists():
            entries.append(str(site))
    env["PYTHONPATH"] = os.pathsep.join(entries) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    return env


def run_probe(code: str, artifact: Path = STEP_FIXTURE, params: dict | None = None) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(code)
        code_file = f.name
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "cadctl", "probe", "--artifact", str(artifact), "--code-file", code_file, "--params-json", json.dumps(params or {}, ensure_ascii=False)],
            capture_output=True, text=True, env=cadctl_env(), timeout=60,
        )
        return json.loads(proc.stdout.strip()) if proc.stdout.strip() else {"ok": False, "stderr": proc.stderr}
    finally:
        os.unlink(code_file)


class ProbeTests(unittest.TestCase):
    def test_derived_computation(self) -> None:
        env = run_probe(PROBE_CODE)
        self.assertTrue(env["ok"], env)
        result = env["payload"]["result"]
        self.assertGreater(result["volume"], 0)
        self.assertEqual(len(result["bbox"]), 3)
        self.assertGreater(result["shape_factor"], 0)
        self.assertLessEqual(result["shape_factor"], 1)
        self.assertGreaterEqual(result["solid_count"], 1)
        # envelope binds both the subject artifact and the script
        self.assertIn("artifact", env["inputHashes"])
        self.assertIn("script", env["inputHashes"])

    def test_artifact_path_points_to_disposable_copy(self) -> None:
        env = run_probe("result = {'artifact_path': artifact_path}")
        self.assertTrue(env["ok"], env)
        self.assertNotEqual(Path(env["payload"]["result"]["artifact_path"]), STEP_FIXTURE)
        self.assertFalse(Path(env["payload"]["result"]["artifact_path"]).exists())

    def test_arbitrary_python_and_geometry_are_isolated(self) -> None:
        original = STEP_FIXTURE.read_bytes()
        env = run_probe("""
import os
import sys
from pathlib import Path
cut = shape - bd.Box(1, 1, 1)
Path('analysis.txt').write_text(str(cut.volume))
Path(artifact_path).write_bytes(b'changed scratch STEP')
result = {'cwd': os.getcwd(), 'argv': sys.argv, 'cut_volume': cut.volume, 'file': Path('analysis.txt').read_text()}
""")
        self.assertTrue(env["ok"], env)
        self.assertGreater(env["payload"]["result"]["cut_volume"], 0)
        self.assertFalse(Path(env["payload"]["result"]["cwd"]).exists())
        self.assertNotIn(str(STEP_FIXTURE), env["payload"]["result"]["argv"])
        self.assertEqual(STEP_FIXTURE.read_bytes(), original)

    def test_result_required(self) -> None:
        env = run_probe("x = 1")
        self.assertFalse(env["ok"])
        self.assertIn("result", env["payload"]["error"])

    def test_print_does_not_break_json_transport(self) -> None:
        env = run_probe("print('checking section')\nresult = {'ok': True}")
        self.assertTrue(env["ok"], env)
        self.assertIn("checking section", env["payload"]["stdout"])

    def test_subprocess_output_does_not_break_json_transport(self) -> None:
        env = run_probe("import subprocess\nimport sys\nsubprocess.run([sys.executable, '-c', \"print('external check')\"], check=True)\nresult = {'ok': True}")
        self.assertTrue(env["ok"], env)
        self.assertIn("external check", env["payload"]["stdout"])

    def test_result_must_be_serializable(self) -> None:
        env = run_probe("result = lambda: None")
        self.assertFalse(env["ok"])
        self.assertIn("serializable", env["payload"]["error"])

    def test_structured_parameters_decode_json_values(self) -> None:
        params = {"enabled": False, "missing": None, "label": "轴\"组", "values": [1, True, None]}
        env = run_probe("result = params", params=params)
        self.assertTrue(env["ok"], env)
        self.assertEqual(env["payload"]["result"], params)
        self.assertIn("parameters", env["inputHashes"])

    def test_timeout_kills_infinite_loop(self) -> None:
        env = run_probe("while True:\n    pass\n")
        self.assertFalse(env["ok"])

    def test_motion_sweep_finds_collision_between_clear_endpoints(self) -> None:
        code = """
fixed, moving = shape.solids()[:2]
poses = []
for index in range(21):
    parameter = index / 20
    posed = moving.moved(bd.Location((-90 * parameter, 0, 0)))
    common = posed & fixed
    penetration = 0.0 if common is None else common.volume
    poses.append({
        "parameter": parameter,
        "clearance": posed.distance_to(fixed),
        "penetration": penetration,
    })
failures = [pose for pose in poses if pose["penetration"] > 1e-6]
worst = min(poses, key=lambda pose: pose["clearance"])
result = {
    "kind": "motion",
    "analysisLevel": "full",
    "parameter": {"name": "travel", "unit": "ratio", "requiredRange": [0, 1]},
    "sampleCount": len(poses),
    "maxParameterStep": 0.05,
    "endpointsReached": True,
    "endpointsClear": poses[0]["penetration"] == 0 and poses[-1]["penetration"] == 0,
    "minimumClearance": {"value": worst["clearance"], "at": worst["parameter"]},
    "firstFailure": None if not failures else failures[0]["parameter"],
    "maximumPenetration": max(pose["penetration"] for pose in poses),
    "passed": not failures,
}
"""
        env = run_probe(code, ROOT / "tests" / "fixtures" / "interference_clearance.step")
        self.assertTrue(env["ok"], env)
        result = env["payload"]["result"]
        self.assertTrue(result["endpointsClear"])
        self.assertFalse(result["passed"])
        self.assertIsNotNone(result["firstFailure"])
        self.assertGreater(result["maximumPenetration"], 0)

    def test_composable_interference_uses_same_shape_and_explicit_pairs(self) -> None:
        env = run_probe("result = cad_interference(shape, [(0, 1)])", ROOT / "tests" / "fixtures" / "interference_contact.step")
        self.assertTrue(env["ok"], env)
        result = env["payload"]["result"]
        self.assertEqual(result["pairCount"], 1)
        self.assertEqual(result["pairs"][0]["solidIndices"], [0, 1])
        self.assertEqual(result["pairs"][0]["classification"], "contact")

    def test_composable_interference_rejects_empty_and_bad_pairs(self) -> None:
        for pairs in ([], [(0, 99)]):
            env = run_probe(f"result = cad_interference(shape, {pairs!r})", ROOT / "tests" / "fixtures" / "interference_contact.step")
            self.assertFalse(env["ok"], env)

    def test_pose_batch_reports_evaluated_poses_and_finite_coverage(self) -> None:
        code = """
import json, time
poses = [{"id": str(index), "transforms": [{"solidIndex": 1, "translationMm": [index, 0, 0]}]} for index in range(10)]
started = time.monotonic()
repeated_imports = [bd.import_step(artifact_path) for _ in poses]
repeated_import_seconds = time.monotonic() - started
started = time.monotonic()
batch = cad_interference_batch(shape, poses, [(0, 1)])
batch_seconds = time.monotonic() - started
result = {
    "comparison": {
        "poseCount": len(poses),
        "repeatedImportCount": len(repeated_imports),
        "repeatedImportSeconds": repeated_import_seconds,
        "batchedSubjectImportCount": 1,
        "batchSeconds": batch_seconds,
        "batchJsonBytes": len(json.dumps(batch, ensure_ascii=False).encode("utf-8")),
    },
    "batch": batch,
}
"""
        env = run_probe(code, ROOT / "tests" / "fixtures" / "interference_contact.step")
        self.assertTrue(env["ok"], env)
        result = env["payload"]["result"]
        comparison = result["comparison"]
        self.assertEqual((comparison["poseCount"], comparison["repeatedImportCount"], comparison["batchedSubjectImportCount"]), (10, 10, 1))
        self.assertGreaterEqual(comparison["repeatedImportSeconds"], 0)
        self.assertGreaterEqual(comparison["batchSeconds"], 0)
        self.assertGreater(comparison["batchJsonBytes"], 0)
        self.assertEqual((result["batch"]["requested"], result["batch"]["evaluated"], result["batch"]["skipped"], result["batch"]["errors"]), (10, 10, 0, 0))
        self.assertIn("no claim between samples", result["batch"]["coverage"])
        self.assertTrue(all(pose["status"] == "evaluated" for pose in result["batch"]["poses"]))

    def test_two_joint_combination_collides_when_each_joint_endpoint_is_clear(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "two-joint.step"
            left = bd.Box(4, 0.5, 0.5).moved(bd.Location((-5, 0, 0)))
            right = bd.Box(4, 0.5, 0.5).moved(bd.Location((5, 0, 0)))
            bd.export_step(bd.Compound(children=[left, right]), str(artifact))
            code = """
poses = [
    {"id": "home", "transforms": []},
    {"id": "joint-a-end", "transforms": [{"solidIndex": 0, "translationMm": [-6, 0, 0], "rotationDegrees": [0, 0, 180]}]},
    {"id": "joint-b-end", "transforms": [{"solidIndex": 1, "translationMm": [6, 0, 0], "rotationDegrees": [0, 0, 180]}]},
    {"id": "combined", "transforms": [
        {"solidIndex": 0, "translationMm": [-6, 0, 0], "rotationDegrees": [0, 0, 180]},
        {"solidIndex": 1, "translationMm": [6, 0, 0], "rotationDegrees": [0, 0, 180]},
    ]},
]
result = cad_interference_batch(shape, poses, [(0, 1)])
"""
            env = run_probe(code, artifact)
            self.assertTrue(env["ok"], env)
            batch = env["payload"]["result"]
            self.assertEqual((batch["requested"], batch["evaluated"], batch["errors"]), (4, 4, 0))
            by_pose = {pose["poseId"]: pose for pose in batch["poses"]}
            for name in ("home", "joint-a-end", "joint-b-end"):
                self.assertEqual(by_pose[name]["facts"]["summary"]["clearance"], 1)
                self.assertEqual(by_pose[name]["facts"]["summary"]["penetration"], 0)
            self.assertEqual(by_pose["combined"]["facts"]["summary"]["penetration"], 1)


if __name__ == "__main__":
    unittest.main()
