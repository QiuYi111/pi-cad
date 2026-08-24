"""Persistent, strictly read-only cadctl probe worker.

The JSONL protocol is intentionally private to the Pi-CAD Node runtime.  It
accepts argv only for the observation command allowlist; MODEL, export,
simulation, optimization, drawing and presentation commands are impossible to
dispatch through this process.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import time
from pathlib import Path

from .cli import main as cadctl_main


PROTOCOL = "pi-cad/probe-worker-v1"
READ_ONLY_COMMANDS = {
    "inspect",
    "render",
    "probe",
    "measure",
    "section",
    "compare",
    "assembly-tree",
    "inspect-interference",
    "scan-sections",
    "inspect-surfaces",
}


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _validate_write_targets(args: list[str], cwd: Path) -> None:
    # Probe commands may materialize observation JSON/images, but never into
    # project source or arbitrary host paths.
    observation_root = cwd
    for index, value in enumerate(args[:-1]):
        if value not in {"--output", "--out-dir"}:
            continue
        target = Path(args[index + 1])
        target = target if target.is_absolute() else cwd / target
        if not _inside(observation_root, target):
            raise ValueError(f"probe output escapes the project workspace: {target}")


def _response(request_id: str, **values: object) -> None:
    print(json.dumps({"protocol": PROTOCOL, "id": request_id, **values}, separators=(",", ":")), flush=True)


def _handle(request: object) -> None:
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    request_id = request.get("id")
    args = request.get("args")
    cwd = request.get("cwd")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("request id is missing")
    if not isinstance(args, list) or not args or not all(isinstance(item, str) for item in args):
        raise ValueError("request args must be a non-empty string array")
    if args[0] not in READ_ONLY_COMMANDS:
        _response(request_id, ok=False, error=f"command is not allowed in probe worker: {args[0]}")
        return
    if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
        _response(request_id, ok=False, error="worker cwd must be an existing absolute directory")
        return
    _validate_write_targets(args, Path(cwd))

    stdout = io.StringIO()
    stderr = io.StringIO()
    previous = Path.cwd()
    started = time.monotonic()
    try:
        os.chdir(cwd)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                exit_code = int(cadctl_main(args))
            except SystemExit as exc:
                exit_code = int(exc.code or 0)
        _response(
            request_id,
            ok=True,
            exitCode=exit_code,
            stdout=stdout.getvalue(),
            stderr=stderr.getvalue(),
            durationMs=int((time.monotonic() - started) * 1000),
            workerPid=os.getpid(),
        )
    except BaseException as exc:  # keep the worker alive after one bad probe
        _response(
            request_id,
            ok=False,
            error=f"{type(exc).__name__}: {exc}",
            stdout=stdout.getvalue(),
            stderr=stderr.getvalue(),
            durationMs=int((time.monotonic() - started) * 1000),
            workerPid=os.getpid(),
        )
    finally:
        os.chdir(previous)


def main() -> int:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request.get("id", "invalid") if isinstance(request, dict) else "invalid"
            _handle(request)
        except BaseException as exc:
            _response(str(request_id), ok=False, error=f"invalid request: {type(exc).__name__}: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
