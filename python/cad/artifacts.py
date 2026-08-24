from __future__ import annotations

import hashlib
from pathlib import Path

from .refs import ArtifactRef


def ref(path: str | Path, *, role: str = "artifact") -> ArtifactRef:
    value = Path(path)
    digest = hashlib.sha256(value.read_bytes()).hexdigest() if value.is_file() else None
    return ArtifactRef(value, digest, role)
