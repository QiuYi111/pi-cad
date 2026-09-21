from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from cadctl import owner


def python_path() -> str:
    root = Path(__file__).resolve().parents[1]
    return os.pathsep.join([str(root / "python"), os.environ.get("PYTHONPATH", "")]).rstrip(os.pathsep)


def process_start_time(pid: int) -> str:
    raw = Path(f"/proc/{pid}/stat").read_bytes()
    return raw[raw.rfind(b")") + 2 :].split()[19].decode()


class CadctlWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(__file__).resolve().parents[1]
        env = os.environ.copy()
        env["PYTHONPATH"] = python_path()
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


class CadctlWorkerOwnerTests(unittest.TestCase):
    """A kernel must not outlive the process that owns it.

    The owner can die from SIGKILL, which runs no cleanup at all, so the kernel
    watches the identity the spawner handed it in the environment.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.owner: subprocess.Popen | None = None
        self.worker: subprocess.Popen | None = None

    def tearDown(self) -> None:
        for process in (self.worker, self.owner):
            if process is None or process.poll() is not None:
                continue
            try:
                process.kill()
            except OSError:
                pass
            process.wait(timeout=10)
        if self.worker is not None:
            for stream in (self.worker.stdin, self.worker.stdout, self.worker.stderr):
                if stream is not None:
                    stream.close()
        self.tmp.cleanup()

    def start_owner(self) -> int:
        self.owner = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        return self.owner.pid

    def start_worker(self, env: dict[str, str]) -> subprocess.Popen:
        self.worker = subprocess.Popen(
            [sys.executable, "-m", "cadctl.worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        return self.worker

    def owned_env(self, owner_pid: int) -> dict[str, str]:
        env = os.environ.copy()
        env["PYTHONPATH"] = python_path()
        env[owner.OWNER_PID_ENV] = str(owner_pid)
        env[owner.OWNER_START_ENV] = process_start_time(owner_pid)
        return env

    def wait_for_exit(self, process: subprocess.Popen, timeout: float = 20.0) -> int | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                return process.returncode
            time.sleep(0.05)
        process.kill()
        process.wait(timeout=10)
        return None

    def wait_for_forked_build_child(self, worker_pid: int, timeout: float = 90.0) -> list[int]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            children = owner.owned_processes(worker_pid)
            if children:
                return children
            time.sleep(0.05)
        return []

    def start_slow_build(self) -> None:
        """One real build that stays inside the forked child for a long time."""
        source = Path(self.tmp.name) / "slow.py"
        source.write_text(
            "import time\n"
            "import build123d as bd\n"
            "time.sleep(120)\n"
            "result = bd.Box(10, 10, 5)\n",
            encoding="utf-8",
        )
        assert self.worker and self.worker.stdin
        self.worker.stdin.write(
            json.dumps(
                {
                    "id": 1,
                    "args": [
                        "build",
                        "--source",
                        str(source),
                        "--output",
                        str(Path(self.tmp.name) / "slow.step"),
                    ],
                    "cwd": self.tmp.name,
                    "timeoutMs": 600_000,
                }
            )
            + "\n"
        )
        self.worker.stdin.flush()

    def test_worker_exits_when_its_owner_is_killed(self) -> None:
        worker = self.start_worker(self.owned_env(self.start_owner()))
        self.assertIsNone(worker.poll())
        os.kill(self.owner.pid, signal.SIGKILL)
        self.assertIsNotNone(self.wait_for_exit(worker), "owner 被 SIGKILL 后 worker 必须自己退出")

    def test_worker_and_forked_build_child_both_exit_when_the_owner_dies(self) -> None:
        worker = self.start_worker(self.owned_env(self.start_owner()))
        self.start_slow_build()
        children = self.wait_for_forked_build_child(worker.pid)
        self.assertTrue(children, "真 build 必须 fork 出一个子进程")

        os.kill(self.owner.pid, signal.SIGKILL)
        self.assertIsNotNone(self.wait_for_exit(worker), "owner 被 SIGKILL 后 worker 必须自己退出")
        for pid in children:
            self.assertFalse(owner.owner_alive(owner.OwnerIdentity(pid, None)), f"{pid} 还在")

    def test_sigterm_stop_takes_the_forked_build_child_with_it(self) -> None:
        worker = self.start_worker(self.owned_env(self.start_owner()))
        self.start_slow_build()
        children = self.wait_for_forked_build_child(worker.pid)
        self.assertTrue(children, "真 build 必须 fork 出一个子进程")

        worker.send_signal(signal.SIGTERM)
        self.assertIsNotNone(self.wait_for_exit(worker), "正常 stop 后 worker 必须退出")
        for pid in children:
            self.assertFalse(owner.owner_alive(owner.OwnerIdentity(pid, None)), f"{pid} 还在")

    def test_worker_without_owner_identity_keeps_its_old_behaviour(self) -> None:
        env = os.environ.copy()
        env.pop(owner.OWNER_PID_ENV, None)
        env.pop(owner.OWNER_START_ENV, None)
        env["PYTHONPATH"] = python_path()
        worker = self.start_worker(env)
        assert worker.stdin and worker.stdout
        worker.stdin.write(json.dumps({"id": 1, "args": ["capability"], "cwd": self.tmp.name}) + "\n")
        worker.stdin.flush()
        self.assertEqual(json.loads(worker.stdout.readline())["exitCode"], 0)
        time.sleep(1.0)
        self.assertIsNone(worker.poll(), "没有 owner 身份的 worker 不该自己退出")


class CadctlOwnerIdentityTests(unittest.TestCase):
    def test_parse_proc_stat_survives_a_comm_with_spaces_and_parentheses(self) -> None:
        raw = b"42 (weird ) name) R 7 " + b" ".join(str(index).encode() for index in range(17)) + b" 99\n"
        facts = owner.parse_proc_stat(raw)
        self.assertIsNotNone(facts)
        self.assertEqual(facts.state, "R")
        self.assertEqual(facts.ppid, 7)
        self.assertEqual(facts.start_time, "99")

    def test_owner_identity_ignores_missing_invalid_and_self_pids(self) -> None:
        self.assertIsNone(owner.owner_identity({}))
        self.assertIsNone(owner.owner_identity({owner.OWNER_PID_ENV: "not-a-pid"}))
        self.assertIsNone(owner.owner_identity({owner.OWNER_PID_ENV: "-1"}))
        self.assertIsNone(owner.owner_identity({owner.OWNER_PID_ENV: str(os.getpid())}))
        identity = owner.owner_identity({owner.OWNER_PID_ENV: "7", owner.OWNER_START_ENV: "12345"})
        self.assertEqual(identity, owner.OwnerIdentity(7, "12345"))

    def test_a_zombie_owner_and_a_recycled_pid_are_both_dead(self) -> None:
        # An un-reaped child is a zombie: it has exited, so its children are
        # gone, but its pid still answers in /proc.
        zombie = subprocess.Popen([sys.executable, "-c", "pass"])
        try:
            time.sleep(0.3)
            self.assertFalse(owner.owner_alive(owner.OwnerIdentity(zombie.pid, None)), "僵尸 owner 已经退出")
            facts = owner.read_proc_stat(zombie.pid)
            if facts is not None:
                self.assertEqual(facts.state, "Z", "没被 wait 的子进程应该是僵尸")
        finally:
            zombie.wait(timeout=10)
        # Same pid, different start time: the number was recycled.
        self.assertFalse(owner.owner_alive(owner.OwnerIdentity(os.getpid(), "0")))
        self.assertTrue(owner.owner_alive(owner.OwnerIdentity(os.getpid(), process_start_time(os.getpid()))))

    def test_owned_processes_lists_children_deepest_first(self) -> None:
        outer = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import subprocess,sys,time\n"
                "subprocess.Popen([sys.executable,'-c',"
                "\"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)']);time.sleep(120)\"])\n"
                "time.sleep(120)",
            ]
        )
        try:
            deadline = time.monotonic() + 10
            tree: list[int] = []
            while time.monotonic() < deadline:
                tree = owner.owned_processes(outer.pid)
                if len(tree) >= 2:
                    break
                time.sleep(0.05)
            self.assertGreaterEqual(len(tree), 2, "整棵子树都要算进来")
            self.assertNotIn(outer.pid, tree, "根进程自己不算在里面")
            deepest = owner.read_proc_stat(tree[0])
            self.assertIsNotNone(deepest)
            self.assertIn(deepest.ppid, tree, "最深的进程要排在父进程前面")
        finally:
            owner.terminate_owned_processes(outer.pid)
            outer.kill()
            outer.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
