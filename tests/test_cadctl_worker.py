from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class CadctlWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(__file__).resolve().parents[1]
        env = os.environ.copy()
        env["PYTHONPATH"] = os.pathsep.join(
            [str(root / "python"), env.get("PYTHONPATH", "")]
        ).rstrip(os.pathsep)
        self.process = subprocess.Popen(
            [sys.executable, "-m", "cadctl.worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )

    def tearDown(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        self.process.wait(timeout=10)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()
        self.tmp.cleanup()

    def request(self, request_id: int, args: list[str], timeout_ms: int | None = None) -> dict:
        assert self.process.stdin and self.process.stdout
        self.process.stdin.write(
            json.dumps(
                {
                    "id": request_id,
                    "args": args,
                    "cwd": self.tmp.name,
                    **({"timeoutMs": timeout_ms} if timeout_ms is not None else {}),
                }
            )
            + "\n"
        )
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def test_reuses_one_process_for_multiple_safe_commands(self) -> None:
        first = self.request(1, ["capability"])
        second = self.request(2, ["capability"])
        self.assertEqual(first["id"], 1)
        self.assertEqual(second["id"], 2)
        self.assertEqual(first["workerPid"], second["workerPid"])
        self.assertEqual(first["exitCode"], 0)
        self.assertTrue(json.loads(first["stdout"])["ok"])

    def test_builds_run_in_fresh_forked_children_of_one_warm_parent(self) -> None:
        source = Path(self.tmp.name) / "model.py"
        source.write_text(
            "import build123d as bd\n"
            "def build(parameters):\n"
            "    print('child output stays inside the envelope')\n"
            "    return bd.Box(parameters['width'], 10, 5)\n",
            encoding="utf-8",
        )
        first_output = Path(self.tmp.name) / "first.step"
        second_output = Path(self.tmp.name) / "second.step"

        first = self.request(
            1,
            [
                "build",
                "--source",
                str(source),
                "--output",
                str(first_output),
                "--parameters-json",
                '{"width":20}',
            ],
        )
        second = self.request(
            2,
            [
                "build",
                "--source",
                str(source),
                "--output",
                str(second_output),
                "--parameters-json",
                '{"width":30}',
            ],
        )

        self.assertEqual(first["workerPid"], second["workerPid"])
        self.assertNotEqual(first["childPid"], second["childPid"])
        self.assertNotEqual(first["workerPid"], first["childPid"])
        self.assertEqual(first["exitCode"], 0, first)
        self.assertEqual(second["exitCode"], 0, second)
        first_envelope = json.loads(first["stdout"])
        self.assertTrue(first_envelope["ok"])
        self.assertIn("child output stays inside the envelope", first_envelope["payload"]["stdout"])
        self.assertTrue(json.loads(second["stdout"])["ok"])
        self.assertTrue(first_output.is_file())
        self.assertTrue(second_output.is_file())

    def test_timed_out_build_child_does_not_poison_warm_parent(self) -> None:
        source = Path(self.tmp.name) / "slow.py"
        source.write_text(
            "import time\n"
            "def build(parameters):\n"
            "    time.sleep(5)\n",
            encoding="utf-8",
        )
        timed_out = self.request(
            1,
            ["build", "--source", str(source), "--output", str(Path(self.tmp.name) / "never.step"), "--parameters-json", "{}"],
            timeout_ms=100,
        )
        healthy = self.request(2, ["capability"])
        self.assertEqual(timed_out["exitCode"], 124)
        self.assertIn("timed out", timed_out["stderr"])
        self.assertEqual(healthy["workerPid"], timed_out["workerPid"])
        self.assertEqual(healthy["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
