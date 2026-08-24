from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, repr=False)
class ArtifactRef:
    path: Path
    sha256: str | None = None
    role: str = "artifact"

    def __repr__(self) -> str:
        digest = f"sha256:{self.sha256[:12]}…" if self.sha256 else "unhashed"
        return f"ArtifactRef(id='{digest}', role={self.role!r}, path={str(self.path)!r})"

    def __cad_snapshot__(self) -> dict[str, Any]:
        return {"kind": "artifact", "path": str(self.path), "sha256": self.sha256, "role": self.role}


@dataclass(frozen=True, repr=False)
class Commit:
    id: str
    name: str
    parent: str | None
    workflow_hash: str
    phase: str
    variables: dict[str, Any]
    artifacts: tuple[ArtifactRef, ...]
    created_at: str

    def __repr__(self) -> str:
        return f"Commit(id={self.id!r}, name={self.name!r}, phase={self.phase!r}, variables={len(self.variables)}, artifacts={len(self.artifacts)})"

    def __cad_snapshot__(self) -> dict[str, Any]:
        return {"kind": "commit", "id": self.id, "name": self.name, "workflowHash": self.workflow_hash, "phase": self.phase}


@dataclass(frozen=True, repr=False)
class ProbeResult:
    value: Any
    artifact_hash: str | None = None
    script_hash: str | None = None
    observation_id: str | None = None

    def __repr__(self) -> str:
        kind = type(self.value).__name__
        return f"ProbeResult(value={kind}, artifact_hash={self.artifact_hash[:12] + '…' if self.artifact_hash else None!r}, script_hash={self.script_hash[:12] + '…' if self.script_hash else None!r})"
