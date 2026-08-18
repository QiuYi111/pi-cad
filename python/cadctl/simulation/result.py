from __future__ import annotations

from pathlib import Path


def write_result(path: str | Path, data: dict) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(__import__("json").dumps(data, indent=2), encoding="utf-8")
    return path
