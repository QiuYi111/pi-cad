from __future__ import annotations

import hashlib
import json

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


def read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


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
