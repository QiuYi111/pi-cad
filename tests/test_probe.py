"""Tests for the programmable read-only B-Rep probe (cadctl probe).

Covers the MVP acceptance criteria:
  1. arbitrary derived computation (bbox ratio / volume / solid count);
  2. subject binding + envelope hashes (script + artifact);
  3. no open / import / subprocess inside the probe scope;
  4. infinite loops are killed by the alarm timeout;
  5. the probe never writes project state (nothing to assert here beyond
     the scope fence — the CLI writes no artifact paths);
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


def run_probe(code: str, artifact: Path = STEP_FIXTURE) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(code)
        code_file = f.name
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "cadctl", "probe", "--artifact", str(artifact), "--code-file", code_file],
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

    def test_artifact_path_is_a_read_only_runtime_binding(self) -> None:
        env = run_probe("result = {'artifact_path': artifact_path}")
        self.assertTrue(env["ok"], env)
        self.assertEqual(Path(env["payload"]["result"]["artifact_path"]).resolve(), STEP_FIXTURE.resolve())

    def test_open_is_unavailable(self) -> None:
        env = run_probe('result = open("/etc/passwd")')
        self.assertFalse(env["ok"])
        self.assertIn("open", env["payload"]["error"])

    def test_import_is_unavailable(self) -> None:
        env = run_probe("import subprocess")
        self.assertFalse(env["ok"])

    def test_exec_is_unavailable(self) -> None:
        env = run_probe('exec("result = 1")')
        self.assertFalse(env["ok"])

    def test_result_required(self) -> None:
        env = run_probe("x = 1")
        self.assertFalse(env["ok"])
        self.assertIn("result", env["payload"]["error"])

    def test_result_must_be_serializable(self) -> None:
        env = run_probe("result = lambda: None")
        self.assertFalse(env["ok"])
        self.assertIn("serializable", env["payload"]["error"])

    def test_timeout_kills_infinite_loop(self) -> None:
        env = run_probe("while True:\n    pass\n")
        self.assertFalse(env["ok"])


if __name__ == "__main__":
    unittest.main()
