"""SU2 runtime resolution and shared backend orchestration for flow/thermal.

Design:

* SU2 is an explicit managed native runtime, not a Python dependency. The V2
  launcher injects ``PI_CAD_SU2_BIN`` after verifying the immutable runtime
  identity. Host PATH and repository-local runtime discovery are forbidden.
* Both input artifacts are hashed BEFORE the solve and re-hashed after; any
  mid-solve mutation discards the result, mirroring the structural solve's
  provenance rules.
* The solver subprocess runs pinned to one OpenMP thread: the official
  precompiled omp builds otherwise busy-wait in thread teardown, and a
  serial run is deterministic anyway.
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from .base import SimulationBackendError

_VERSION_PATTERN = re.compile(r"SU2 v([0-9][0-9A-Za-z.\-]*)")


class Su2UnavailableError(SimulationBackendError):
    pass


def resolve_su2_binary() -> tuple[str, str]:
    """Return the launcher-injected managed SU2 executable, or fail closed."""
    override = os.environ.get("PI_CAD_SU2_BIN")
    if not override:
        raise Su2UnavailableError("PI_CAD_SU2_BIN is not set by a verified managed SU2 runtime")
    candidate = Path(override).resolve()
    managed_root = Path("/opt/pi-cad-runtime/su2/8.5.0").resolve()
    if managed_root not in candidate.parents:
        raise Su2UnavailableError("PI_CAD_SU2_BIN must resolve inside the immutable managed SU2 runtime")
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise Su2UnavailableError(f"managed SU2 executable is missing or not executable: {candidate}")
    version = _probe_version(str(candidate))
    if version != "8.5.0":
        raise Su2UnavailableError(f"managed SU2 version mismatch: expected 8.5.0, got {version}")
    return str(candidate), version


def _probe_version(binary: str) -> str:
    try:
        result = subprocess.run(
            [binary, "--help"],
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "OMP_NUM_THREADS": "1"},
        )
        output = (result.stdout or "") + (result.stderr or "")
        match = _VERSION_PATTERN.search(output)
        if match:
            return match.group(1)
    except Exception:
        pass
    return "unknown"


def _hash_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_su2(config_path: str | Path, workdir: str | Path, timeout_s: float = 5400.0) -> dict[str, Any]:
    """Run SU2_CFD on one config; returns stdout/stderr/exit information."""
    binary, version = resolve_su2_binary()
    config_path = Path(config_path).resolve()
    workdir = Path(workdir).resolve()
    result = subprocess.run(
        [binary, str(config_path)],
        cwd=str(workdir),
        capture_output=True,
        text=True,
        timeout=timeout_s,
        env={**os.environ, "OMP_NUM_THREADS": "1"},
    )
    return {
        "binary": binary,
        "version": version,
        "exitCode": result.returncode,
        "stdout": result.stdout[-8000:],
        "stderr": result.stderr[-8000:],
    }


def su2_status() -> dict[str, Any]:
    """Doctor-facing capability probe."""
    try:
        binary, version = resolve_su2_binary()
        return {"status": "ready", "backend": "su2", "binary": binary, "version": version}
    except Su2UnavailableError as exc:
        return {"status": "unavailable", "backend": "su2", "reason": str(exc)}


def pre_hash_artifacts(paths: list[str | Path]) -> dict[str, str]:
    return {str(path): _hash_file(path) for path in paths}


def verify_unchanged(before: dict[str, str]) -> None:
    """Fail closed if any pre-hashed input changed during the solve."""
    for path, digest in before.items():
        if not Path(path).exists() or _hash_file(path) != digest:
            raise SimulationBackendError(
                f"input artifact changed during simulation; result discarded because the mesh "
                f"and the bound artifact version no longer match: {path}"
            )
