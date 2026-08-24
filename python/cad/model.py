from __future__ import annotations

from pathlib import Path
from typing import Any

from .client import request
from .refs import ArtifactRef


async def build(source: str | Path, output: str | Path | None = None, *, force: bool = False) -> ArtifactRef:
    source_path = Path(source)
    output_path = Path(output) if output is not None else Path("build") / f"{source_path.stem}.step"
    envelope: dict[str, Any] = await request("model-build", source=source_path.as_posix(), output=output_path.as_posix(), force=force)
    digest = (envelope.get("outputHashes") or {}).get("artifact")
    return ArtifactRef(output_path, digest, "candidate")
