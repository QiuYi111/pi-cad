"""Programmable read-only B-Rep probe.

Executes an agent-authored Python computation against the current (or
baseline) STEP artifact and returns a JSON result. This is an
*observability* tool, not an authoring tool:

    - the subject artifact is chosen by name ("current"/"baseline") and
      resolved by the harness from run state — the probe never accepts an
      arbitrary path;
    - the execution scope has no filesystem, import, subprocess, or network
      entry points (whitelisted builtins only);
    - the only output is the JSON-serializable ``result`` variable;
    - nothing on disk is written by the probe itself.

This is an effect fence against accidental mutation by the agent, not a
security sandbox for hostile third-party code.
"""
from __future__ import annotations

import builtins
import json
import math
import signal
import statistics
import time
from pathlib import Path
from typing import Any

# Builtins that carry no side-channel: no open/__import__/eval/exec/compile/input.
_SAFE_BUILTIN_NAMES = (
    "abs", "min", "max", "sum", "len", "range", "enumerate", "zip",
    "sorted", "reversed", "any", "all", "round", "pow", "divmod",
    "int", "float", "str", "bool", "list", "tuple", "dict", "set",
    "frozenset", "map", "filter", "isinstance", "getattr", "hasattr",
)

SAFE_BUILTINS = {name: getattr(builtins, name) for name in _SAFE_BUILTIN_NAMES}


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

    try:
        shape = bd.import_step(str(artifact))
    except Exception as error:  # noqa: BLE001 - surfaced as probe failure
        raise ProbeError(f"cannot import subject artifact: {error}") from error

    scope: dict[str, Any] = {
        "__builtins__": SAFE_BUILTINS,
        "shape": shape,
        "bd": bd,
        "math": math,
        "statistics": statistics,
        "np": np,
        "result": None,
    }

    def _alarm(_signum: int, _frame: Any) -> None:
        raise TimeoutError(f"probe exceeded {timeout_s}s CPU wall limit")

    previous_handler = signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(timeout_s)
    started = time.monotonic()
    try:
        exec(compile(code, "<cad-probe>", "exec"), scope)  # noqa: S102 - by design
    except TimeoutError as error:
        raise ProbeError(str(error)) from error
    except BaseException as error:  # noqa: BLE001 - agent code, any failure is a probe error
        raise ProbeError(f"{type(error).__name__}: {error}") from error
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)

    result = scope.get("result", None)
    if result is None:
        raise ProbeError(
            "probe code did not set 'result'; assign a JSON-serializable dict to result"
        )
    try:
        json.dumps(result)
    except (TypeError, ValueError) as error:
        raise ProbeError(f"probe result is not JSON-serializable: {error}") from error

    return {
        "result": result,
        "probeSeconds": round(time.monotonic() - started, 3),
    }
