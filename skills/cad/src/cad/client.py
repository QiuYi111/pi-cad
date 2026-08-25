from __future__ import annotations

"""Stateless JSON bridge used by the Prime kernel package."""

import asyncio
import json
import os
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
    cwd = Path(os.environ.get("PI_CAD_PROJECT_CWD", os.getcwd())).resolve()
    if os.name == "nt" or ":\\" in str(cwd):
        raise CadApiError("cad requires Linux/WSL path semantics; Windows paths are rejected")
    return cwd


async def request(op: str, **payload: Any) -> Any:
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
    stdout, stderr = await process.communicate(json.dumps({"schema": 1, "op": op, **payload}, ensure_ascii=False).encode())
    try:
        response = json.loads(stdout.decode())
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CadApiError(f"Pi-CAD bridge returned invalid JSON: {stderr.decode(errors='replace')[-1000:]}") from error
    if process.returncode != 0 or not response.get("ok"):
        detail = response.get("error") or {}
        raise CadApiError(detail.get("message") or stderr.decode(errors="replace")[-1000:] or "Pi-CAD bridge failed", error_type=detail.get("type", "CadApiError"))
    return response.get("result")
