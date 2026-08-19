"""SU2 runtime resolution and shared backend orchestration for flow/thermal.

Design:

* SU2 is an optional native runtime, not a Python dependency. Resolution
  order: ``PI_CAD_SU2_BIN`` -> package ``.runtime/su2/<version>/<platform>``
  -> ``PATH``. Everything fails closed with an "unavailable" status so the
  harness can report the missing capability instead of crashing.
* Both input artifacts are hashed BEFORE the solve and re-hashed after; any
  mid-solve mutation discards the result, mirroring the structural solve's
  provenance rules.
* The solver subprocess runs pinned to one OpenMP thread: the official
  precompiled omp builds otherwise busy-wait in thread teardown, and a
  serial run is deterministic anyway.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .base import SimulationBackendError

SU2_MANIFEST_PATH = Path(__file__).resolve().parents[3] / "scripts" / "su2-manifest.json"

_VERSION_PATTERN = re.compile(r"SU2 v([0-9][0-9A-Za-z.\-]*)")


class Su2UnavailableError(SimulationBackendError):
    pass


def _platform_key() -> str:
    machine = os.uname().machine.lower() if hasattr(os, "uname") else ""
    if sys.platform.startswith("linux"):
        return "linux-x64" if "aarch64" not in machine else "linux-arm64"
    if sys.platform == "darwin":
        return "darwin-arm64" if "arm64" in machine else "darwin-x64"
    if sys.platform.startswith("win"):
        return "win32-x64"
    return f"{sys.platform}-{machine}"


def _manifest() -> dict[str, Any]:
    try:
        return json.loads(SU2_MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        raise Su2UnavailableError(f"SU2 manifest is missing or unreadable: {exc}") from exc


def resolve_su2_binary() -> tuple[str, str]:
    """Return (path, version) of the SU2_CFD executable, or raise."""
    override = os.environ.get("PI_CAD_SU2_BIN")
    if override:
        candidate = Path(override).expanduser().resolve()
        if not candidate.exists():
            raise Su2UnavailableError(f"PI_CAD_SU2_BIN points to a missing file: {override}")
        return str(candidate), _probe_version(str(candidate))

    manifest = _manifest()
    platform_key = _platform_key()
    entry = manifest.get("platforms", {}).get(platform_key)
    if entry:
        binary_name = "SU2_CFD.exe" if platform_key.startswith("win32") else "SU2_CFD"
        for base in _package_runtime_roots():
            candidate = base / manifest.get("version", "") / platform_key / "bin" / binary_name
            if candidate.exists():
                return str(candidate), str(manifest.get("version", "unknown"))

    found = shutil.which("SU2_CFD") or shutil.which("su2_cfd")
    if found:
        return found, _probe_version(found)

    raise Su2UnavailableError(
        "no SU2_CFD executable found (PI_CAD_SU2_BIN, package .runtime/su2, PATH); "
        "flow/thermal simulation is unavailable on this host"
    )


def _package_runtime_roots() -> list[Path]:
    roots = [Path(__file__).resolve().parents[3] / ".runtime" / "su2"]
    env_root = os.environ.get("PI_CAD_SU2_RUNTIME")
    if env_root:
        roots.insert(0, Path(env_root))
    return roots


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
