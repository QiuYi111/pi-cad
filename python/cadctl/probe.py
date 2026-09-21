"""Run arbitrary CAD analysis on a disposable copy of the subject STEP.

The imported shape and working directory belong to the temporary experiment.
The original artifact is never passed into agent code. This isolates normal
engineering exploration; it is not a security sandbox for hostile code.
"""
from __future__ import annotations

import builtins
import contextlib
import io
import json
import math
import os
import signal
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

class ProbeError(Exception):
    """Raised for probe misuse or execution failure."""


def run_probe(artifact: Path, code: str, timeout_s: int = 25) -> dict[str, Any]:
    """Execute ``code`` against ``artifact`` and return the probe result dict.

    The scope preloads ``shape`` (the imported STEP), ``bd`` (build123d),
    ``math``, ``statistics``, and ``np`` (numpy). The script must leave a
    JSON-serializable object in ``result``.
    """
    import build123d as bd
    import numpy as np

    def _alarm(_signum: int, _frame: Any) -> None:
        raise TimeoutError(f"probe exceeded {timeout_s}s CPU wall limit")

    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="cad-probe-") as scratch:
        subject = Path(scratch) / "subject.step"
        try:
            shutil.copyfile(artifact, subject)
            shape = bd.import_step(str(subject))
        except Exception as error:  # noqa: BLE001 - surfaced as probe failure
            raise ProbeError(f"cannot import subject artifact: {error}") from error

        scope: dict[str, Any] = {
            "__builtins__": builtins.__dict__,
            "shape": shape,
            "artifact_path": str(subject),
            "scratch_dir": scratch,
            "bd": bd,
            "math": math,
            "statistics": statistics,
            "np": np,
            "result": None,
        }
        previous_cwd = os.getcwd()
        previous_argv = sys.argv
        previous_handler = signal.signal(signal.SIGALRM, _alarm)
        printed = io.StringIO()
        with tempfile.TemporaryFile(mode="w+b") as process_stdout:
            saved_stdout_fd = os.dup(1)
            try:
                os.chdir(scratch)
                sys.argv = ["<cad-probe>", str(subject)]
                os.dup2(process_stdout.fileno(), 1)
                signal.alarm(timeout_s)
                with contextlib.redirect_stdout(printed):
                    exec(compile(code, "<cad-probe>", "exec"), scope)  # noqa: S102 - intentional arbitrary analysis
                result = scope.get("result")
                if result is None:
                    raise ProbeError("probe code did not set 'result'; assign a JSON-serializable dict to result")
                try:
                    json.dumps(result)
                except (TypeError, ValueError) as error:
                    raise ProbeError(f"probe result is not JSON-serializable: {error}") from error
            except TimeoutError as error:
                raise ProbeError(str(error)) from error
            except ProbeError:
                raise
            except BaseException as error:  # noqa: BLE001 - agent code, any failure is a probe error
                raise ProbeError(f"{type(error).__name__}: {error}") from error
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, previous_handler)
                sys.argv = previous_argv
                os.chdir(previous_cwd)
                os.dup2(saved_stdout_fd, 1)
                os.close(saved_stdout_fd)
            process_stdout.seek(0, os.SEEK_END)
            process_stdout.seek(max(0, process_stdout.tell() - 8192))
            external_output = process_stdout.read().decode("utf-8", errors="replace")

    return {"result": result, "stdout": (printed.getvalue() + external_output)[-8192:], "probeSeconds": round(time.monotonic() - started, 3)}
