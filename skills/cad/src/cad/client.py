from __future__ import annotations

"""Stateless JSON bridge used by the Prime kernel package."""

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any


class CadApiError(RuntimeError):
    def __init__(self, message: str, *, error_type: str = "CadApiError") -> None:
        super().__init__(message)
        self.error_type = error_type


def package_root() -> Path:
    configured = os.environ.get("PI_CAD_REPO")
    return Path(configured).resolve() if configured else Path(__file__).resolve().parents[2]


def project_cwd() -> Path:
    # Daemon workers may outlive the launcher that created them.  In Prime the
    # kernel cwd is the authoritative per-session workspace; a launcher-level
    # PI_CAD_PROJECT_CWD can otherwise leak into a later session.
    configured = os.environ.get("PI_CAD_PROJECT_CWD")
    cwd = Path(os.getcwd() if os.environ.get("PRIME_AGENT_INTERNAL_DAEMON_WORKER") else (configured or os.getcwd())).resolve()
    if os.name == "nt" or ":\\" in str(cwd):
        raise CadApiError("cad requires Linux/WSL path semantics; Windows paths are rejected")
    return cwd


def project_path(value: str | Path, *, error_type: str = "CadApiError") -> tuple[Path, Path]:
    """Resolve a project-local path and return its absolute and wire forms."""
    root = project_cwd()
    path = Path(value)
    if os.name == "nt" or re.match(r"^[A-Za-z]:[\\/]", str(path)):
        raise CadApiError("cad requires Linux/WSL path semantics; Windows paths are rejected", error_type=error_type)
    absolute = (path if path.is_absolute() else root / path).resolve()
    try:
        relative = absolute.relative_to(root)
    except ValueError as error:
        raise CadApiError(f"managed CAD path escapes the project root: {path.as_posix()}", error_type=error_type) from error
    return absolute, relative


async def request(op: str, **payload: Any) -> Any:
    reviewer_socket = os.environ.get("PI_CAD_REVIEWER_SOCKET")
    reviewer_id = os.environ.get("PI_CAD_REVIEW_ID") if reviewer_socket else None
    request_body = json.dumps({"schema": 1, "op": op, **payload, **({"reviewId": reviewer_id} if reviewer_id else {})}, ensure_ascii=False).encode()
    authority_socket = reviewer_socket or os.environ.get("PI_CAD_AUTHOR_SOCKET")
    if authority_socket:
        try:
            reader, writer = await asyncio.open_unix_connection(authority_socket)
            writer.write(request_body)
            await writer.drain()
            writer.write_eof()
            stdout = await reader.read(8 * 1024 * 1024 + 1)
            writer.close()
            await writer.wait_closed()
            if len(stdout) > 8 * 1024 * 1024:
                raise CadApiError("Pi-CAD sidecar response exceeds byte limit")
            response = json.loads(stdout.decode())
        except CadApiError:
            raise
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CadApiError(f"Pi-CAD authority sidecar failed closed: {error}", error_type="SidecarUnavailable") from error
        if not response.get("ok"):
            detail = response.get("error") or {}
            raise CadApiError(detail.get("message") or "Pi-CAD authority sidecar rejected the request", error_type=detail.get("type", "CadApiError"))
        return response.get("result")

    root = package_root()
    command = ["node", str(root / "scripts" / "pi-cad-agent-api.mjs"), "agent-api", str(project_cwd())]
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(project_cwd()),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "PI_CAD_REPO": str(root)},
    )
    stdout, stderr = await process.communicate(request_body)
    try:
        response = json.loads(stdout.decode())
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CadApiError(f"Pi-CAD bridge returned invalid JSON: {stderr.decode(errors='replace')[-1000:]}") from error
    if process.returncode != 0 or not response.get("ok"):
        detail = response.get("error") or {}
        raise CadApiError(detail.get("message") or stderr.decode(errors="replace")[-1000:] or "Pi-CAD bridge failed", error_type=detail.get("type", "CadApiError"))
    return response.get("result")
