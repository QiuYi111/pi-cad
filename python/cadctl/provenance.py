"""Frozen invocation provenance.

Evidence is an observation of a fixed computation: the inputs an
interpreter invocation consumes are hashed once, before the solve, and
afterwards only verified — never re-derived from whatever files exist when
the computation finishes. A mid-run rewrite therefore invalidates a result
instead of silently redefining its provenance.

Any spec-driven interpreter command (simulation, flow, thermal, and later
optimization / assembly / external verification runs) composes this instead
of hand-rolling a hash lifecycle.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable


class FrozenInputs:
    """Role-tagged input set of one invocation, hashed at freeze time."""

    def __init__(self, entries: list[dict[str, str]]) -> None:
        self._entries = [dict(entry) for entry in entries]

    @classmethod
    def freeze(cls, paths: Iterable[tuple[str, str | Path]]) -> "FrozenInputs":
        """Hash each (role, path) pair once; this call defines provenance."""
        from .common import sha256_file

        return cls(
            [
                {
                    "role": str(role),
                    "path": str(Path(path).resolve()),
                    "sha256": sha256_file(path),
                }
                for role, path in paths
            ]
        )

    def __iter__(self):
        return iter(self._entries)

    def __len__(self) -> int:
        return len(self._entries)

    def hashes(self) -> dict[str, str]:
        """role -> sha256, for the envelope's inputHashes."""
        return {entry["role"]: entry["sha256"] for entry in self._entries}

    def artifacts(self) -> list[dict[str, str]]:
        """Hash-bound input descriptors, for the envelope's inputArtifacts."""
        return [dict(entry) for entry in self._entries]

    def changed_role(self) -> str | None:
        """Role of the first input that no longer matches its frozen hash."""
        from .common import sha256_file

        for entry in self._entries:
            path = Path(entry["path"])
            if not path.exists() or sha256_file(path) != entry["sha256"]:
                return entry["role"]
        return None

    def discard_reason(self) -> str | None:
        """Ready-to-emit reason when an input changed during the run."""
        role = self.changed_role()
        if role is None:
            return None
        return (
            "input artifact changed during simulation; result discarded because "
            f"provenance no longer matches the invocation inputs: {role}"
        )


def spec_input_paths(
    spec_path: str | Path,
    roles: Iterable[str] = ("artifact", "fluidDomain"),
    include_spec: bool = True,
) -> list[tuple[str, str]]:
    """(role, path) pairs for a spec plus every artifact input it names.

    Fail-soft per role: a missing optional artifact is simply not part of
    the frozen set (spec validation reports hard requirements upstream).
    """
    entries: list[tuple[str, str]] = []
    if include_spec:
        entries.append(("spec", str(Path(spec_path).resolve())))
    try:
        spec: Any = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    except Exception:
        return entries
    if not isinstance(spec, dict):
        return entries
    for role in roles:
        value = spec.get(role)
        if isinstance(value, str) and value and Path(value).exists():
            entries.append((role, str(Path(value).resolve())))
    # The authoritative design an analysisModel derives from is a frozen
    # input like any other: mid-solve mutation discards the invocation.
    model = spec.get("analysisModel")
    if isinstance(model, dict):
        source = model.get("source")
        if isinstance(source, str) and source and Path(source).exists():
            entries.append(("analysisSource", str(Path(source).resolve())))
    return entries
