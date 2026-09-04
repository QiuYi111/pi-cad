"""Warm NDJSON transport for cadctl.

The parent only imports trusted modules and handles transport. Every command
runs in a fresh forked child so warm imports are reused without carrying CAD
kernel or user-source state between requests.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import signal
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

from .cli import main

# Preload build123d/OCC once. Forked build children inherit these read-only
# module pages and exit after one request.
from . import model as _preheated_model  # noqa: F401, E402
from . import mesh as _preheated_mesh  # noqa: F401, E402


SAFE_COMMANDS = frozenset(
    {
        "assembly-tree",
        "capability",
        "compare",
        "export",
        "inspect",
        "inspect-interference",
        "inspect-surfaces",
        "measure",
        "mesh",
        "render",
        "scan-sections",
        "section",
    }
)
FORKED_COMMANDS = SAFE_COMMANDS | {"build"}


def _response(
    request: Any,
    allowed_commands: frozenset[str] = SAFE_COMMANDS,
) -> dict[str, Any]:
    request_id = request.get("id") if isinstance(request, dict) else None
    stdout = io.StringIO()
    stderr = io.StringIO()
    exit_code = 2
    if not isinstance(request, dict):
        return {
            "id": request_id,
            "workerPid": os.getpid(),
            "exitCode": exit_code,
            "stdout": "",
            "stderr": "worker request must be an object",
        }

    args = request.get("args")
    cwd = request.get("cwd")
    if not isinstance(args, list) or not args or not all(isinstance(item, str) for item in args):
        return {
            "id": request_id,
            "workerPid": os.getpid(),
            "exitCode": exit_code,
            "stdout": "",
            "stderr": "worker args must be a non-empty string array",
        }
    if args[0] not in allowed_commands:
        return {
            "id": request_id,
            "workerPid": os.getpid(),
            "exitCode": exit_code,
            "stdout": "",
            "stderr": f"cadctl command {args[0]!r} is not allowed in the warm worker",
        }
    if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
        return {
            "id": request_id,
            "workerPid": os.getpid(),
            "exitCode": exit_code,
            "stdout": "",
            "stderr": "worker cwd must be an existing absolute directory",
        }

    old_cwd = Path.cwd()
    old_invocation_cwd = os.environ.get("PI_CAD_INVOCATION_CWD")
    try:
        os.chdir(cwd)
        os.environ["PI_CAD_INVOCATION_CWD"] = cwd
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exit_code = int(main(args))
    except SystemExit as error:
        exit_code = int(error.code) if isinstance(error.code, int) else 2
    except BaseException:  # noqa: BLE001 - isolate one malformed request
        exit_code = 1
        stderr.write(traceback.format_exc())
    finally:
        os.chdir(old_cwd)
        if old_invocation_cwd is None:
            os.environ.pop("PI_CAD_INVOCATION_CWD", None)
        else:
            os.environ["PI_CAD_INVOCATION_CWD"] = old_invocation_cwd

    return {
        "id": request_id,
        "workerPid": os.getpid(),
        "exitCode": exit_code,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
    }


def _forked_response(request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    fd, raw_path = tempfile.mkstemp(prefix="pi-cad-build-", suffix=".json")
    os.close(fd)
    result_path = Path(raw_path)
    timeout_seconds = max(
        1.0,
        min(float(request.get("timeoutMs", 180_000)) / 1000.0, 1800.0),
    )
    child_pid = os.fork()
    if child_pid == 0:
        try:
            os.setsid()
            devnull = os.open(os.devnull, os.O_RDWR)
            try:
                os.dup2(devnull, 0)
                os.dup2(devnull, 1)
                os.dup2(devnull, 2)
            finally:
                if devnull > 2:
                    os.close(devnull)
            response = _response(request, SAFE_COMMANDS | FORKED_COMMANDS)
            response["childPid"] = os.getpid()
            result_path.write_text(
                json.dumps(response, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
        except BaseException:  # noqa: BLE001 - child must always terminate
            try:
                result_path.write_text(
                    json.dumps(
                        {
                            "id": request_id,
                            "childPid": os.getpid(),
                            "exitCode": 1,
                            "stdout": "",
                            "stderr": traceback.format_exc(),
                        },
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    encoding="utf-8",
                )
            except BaseException:
                pass
        finally:
            os._exit(0)

    deadline = time.monotonic() + timeout_seconds
    timed_out = False
    status = 0
    while True:
        waited, status = os.waitpid(child_pid, os.WNOHANG)
        if waited == child_pid:
            break
        if time.monotonic() >= deadline:
            timed_out = True
            try:
                os.killpg(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            os.waitpid(child_pid, 0)
            break
        time.sleep(0.01)

    try:
        if timed_out:
            response = {
                "id": request_id,
                "childPid": child_pid,
                "exitCode": 124,
                "stdout": "",
                "stderr": f"forked cadctl command timed out after {timeout_seconds:g}s",
            }
        elif not result_path.stat().st_size:
            response = {
                "id": request_id,
                "childPid": child_pid,
                "exitCode": 1,
                "stdout": "",
                "stderr": f"forked cadctl build exited without a result (status {status})",
            }
        else:
            response = json.loads(result_path.read_text(encoding="utf-8"))
    finally:
        result_path.unlink(missing_ok=True)
    response["workerPid"] = os.getpid()
    return response


def serve() -> int:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = (
                _forked_response(request)
                if isinstance(request, dict)
                and isinstance(request.get("args"), list)
                and request["args"]
                and request["args"][0] in FORKED_COMMANDS
                else _response(request)
            )
        except Exception:  # noqa: BLE001 - protocol errors stay request-scoped
            response = {
                "id": None,
                "workerPid": os.getpid(),
                "exitCode": 2,
                "stdout": "",
                "stderr": traceback.format_exc(),
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
