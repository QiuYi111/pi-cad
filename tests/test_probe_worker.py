from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "interference_single.step"
PROTOCOL = "pi-cad/probe-worker-v1"


class ProbeWorkerProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        env = os.environ.copy()
        env["PYTHONPATH"] = str(ROOT / "python") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        self.worker = subprocess.Popen(
            [sys.executable, "-m", "cadctl.probe_worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )

    def tearDown(self) -> None:
        self.worker.terminate()
        self.worker.wait(timeout=10)
        for stream in (self.worker.stdin, self.worker.stdout, self.worker.stderr):
            if stream is not None:
                stream.close()

    def request(self, args: list[str]) -> dict:
        request_id = str(uuid.uuid4())
        assert self.worker.stdin is not None and self.worker.stdout is not None
        self.worker.stdin.write(json.dumps({"protocol": PROTOCOL, "id": request_id, "cwd": str(ROOT), "args": args}) + "\n")
        self.worker.stdin.flush()
        response = json.loads(self.worker.stdout.readline())
        self.assertEqual(response["id"], request_id)
        return response

    def test_reuses_pid_and_rejects_mutating_commands(self) -> None:
        first = self.request(["inspect", "--artifact", str(FIXTURE)])
        second = self.request(["inspect", "--artifact", str(FIXTURE)])
        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertEqual(first["workerPid"], second["workerPid"])
        self.assertTrue(json.loads(first["stdout"])["ok"])
        rejected = self.request(["build", "--source", "x.py", "--output", "x.step"])
        self.assertFalse(rejected["ok"])
        self.assertIn("not allowed", rejected["error"])
        escaped = self.request(["inspect", "--artifact", str(FIXTURE), "--output", str(ROOT.parent / "escaped.json")])
        self.assertFalse(escaped["ok"])
        self.assertIn("escapes the project", escaped["error"])


if __name__ == "__main__":
    unittest.main()
