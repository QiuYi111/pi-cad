from __future__ import annotations

"""Thin model handles over the existing Pi-CAD build capability."""

from pathlib import Path
from typing import Any

from .client import CadApiError, request
from .refs import ArtifactRef


async def build(source: str | Path, output: str | Path | None = None, *, force: bool = False) -> ArtifactRef:
    source_path = Path(source)
    output_path = Path(output) if output is not None else Path("build") / f"{source_path.stem}.step"
    envelope: dict[str, Any] = await request("model-build", source=source_path.as_posix(), output=output_path.as_posix(), force=force)
    if not envelope.get("ok"):
        payload = envelope.get("payload") or {}
        raise CadApiError(payload.get("error") or "Pi-CAD model build failed", error_type="ModelBuildError")
    artifacts = envelope.get("artifacts") or []
    artifact = next((item for item in artifacts if item.get("kind") == "step"), artifacts[0] if artifacts else None)
    if not artifact or not output_path.is_file():
        raise CadApiError(f"Pi-CAD model build did not create {output_path.as_posix()}", error_type="ModelBuildError")
    digest = artifact.get("sha256") if artifact else None
    return ArtifactRef(output_path, digest, "candidate")
