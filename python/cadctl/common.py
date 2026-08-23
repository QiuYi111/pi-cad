from __future__ import annotations

import hashlib
import json
import os
import re

from . import __version__
import time
from pathlib import Path
from typing import Any


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json_bytes(data: Any) -> bytes:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def write_json(path: str | Path, data: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )


_WINDOWS_ABSOLUTE_PATH = re.compile(r"^([A-Za-z]):[\\/](.*)$")


def host_path(value: str) -> str:
    """Translate an absolute Windows host path when cadctl runs in WSL.

    Paths embedded in an immutable JSON spec are translated in memory so
    the original file and its provenance hash remain unchanged.
    """
    if os.name == "nt":
        return value
    match = _WINDOWS_ABSOLUTE_PATH.match(value)
    if not match:
        return value
    drive, remainder = match.groups()
    windows_workspace = os.environ.get("PI_CAD_WINDOWS_WORKSPACE", "").rstrip("\\/")
    wsl_workspace = os.environ.get("PI_CAD_WSL_WORKSPACE", "").rstrip("/")
    normalized = value.replace("/", "\\").rstrip("\\")
    if windows_workspace and wsl_workspace:
        workspace = windows_workspace.replace("/", "\\").rstrip("\\")
        if normalized.casefold() == workspace.casefold():
            return wsl_workspace
        prefix = workspace + "\\"
        if normalized.casefold().startswith(prefix.casefold()):
            suffix = normalized[len(prefix):].replace("\\", "/")
            return f"{wsl_workspace}/{suffix}"
    return f"/mnt/{drive.lower()}/{remainder.replace(chr(92), '/')}"


def normalize_host_paths(value: Any) -> Any:
    if isinstance(value, str):
        return host_path(value)
    if isinstance(value, list):
        return [normalize_host_paths(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_host_paths(item) for key, item in value.items()}
    return value


def resolve_spec_path(spec_path: str | Path, value: str | Path) -> Path:
    """Resolve a spec reference against the invocation project directory."""
    candidate = Path(host_path(str(value)))
    if not candidate.is_absolute():
        invocation_cwd = os.environ.get("PI_CAD_INVOCATION_CWD")
        candidate = (Path(invocation_cwd) if invocation_cwd else Path(spec_path).resolve().parent) / candidate
    return candidate.resolve()


def read_json(path: str | Path, *, normalize_paths: bool = False) -> Any:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    return normalize_host_paths(value) if normalize_paths else value


def utcnow_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def emit(
    tool: str,
    payload: dict[str, Any],
    *,
    input_hashes: dict[str, str] | None = None,
    input_artifacts: list[dict[str, str]] | None = None,
    artifacts: list[dict[str, str]] | None = None,
    warnings: list[str] | None = None,
    duration_ms: int,
) -> None:
    envelope = {
        "ok": True,
        "tool": tool,
        "toolVersion": __version__,
        "backendVersion": _backend_version(),
        "inputHashes": input_hashes or {},
        # Inputs with paths+roles so persisted evidence can re-verify
        # them after the solve (hashes alone cannot be re-checked on disk).
        "inputArtifacts": input_artifacts or [],
        "outputHashes": {
            artifact["path"]: artifact["sha256"] for artifact in (artifacts or [])
        },
        "durationMs": duration_ms,
        "warnings": warnings or [],
        "artifacts": artifacts or [],
        "payload": payload,
    }
    print(json.dumps(envelope, sort_keys=True, ensure_ascii=True))


def emit_error(
    tool: str,
    message: str,
    *,
    input_hashes: dict[str, str] | None = None,
    duration_ms: int,
    stderr: str = "",
) -> None:
    envelope = {
        "ok": False,
        "tool": tool,
        "toolVersion": __version__,
        "backendVersion": _backend_version(),
        "inputHashes": input_hashes or {},
        "outputHashes": {},
        "durationMs": duration_ms,
        "warnings": [],
        "artifacts": [],
        "payload": {"error": message, "stderr": stderr},
    }
    print(json.dumps(envelope, sort_keys=True, ensure_ascii=True))


def _backend_version() -> str:
    try:
        import build123d as bd

        return getattr(bd, "__version__", "unknown")
    except Exception:
        return "unavailable"
