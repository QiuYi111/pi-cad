"""One resolver for every consumer: probes, viewers, and flow interpreters.

Callers ask by semantic path, by current artifact ref, by kind, or by owner.
The resolver never picks a default object: no match, several matches, a stale
artifact, a mismatched kind, or a manifest that does not belong to the file all
raise an actionable error instead of returning the first hit.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from ..common import sha256_file
from .manifest import identity_path, legacy_path, load_manifest
from .protocol import IdentityError, canonicalize_path, parent_path

_REF_PREFIXES = {"occ-": "instance", "surf-": "face", "edge-": "edge", "solid-": "solid"}


@dataclass
class Resolution:
    """What one semantic path or ref resolves to on one artifact version."""

    target: str
    path: str | None
    kind: str | None
    artifact_hash: str
    source: str
    stable: bool
    label: str | None = None
    display: dict[str, str] | None = None
    owner: str | None = None
    feature_kind: str | None = None
    coordinate: str | None = None
    bindings: list[dict[str, Any]] = field(default_factory=list)
    solid_indices: list[int] = field(default_factory=list)
    container: bool = False
    placement: dict[str, Any] | None = None
    legacy: bool = False

    @property
    def cardinality(self) -> str:
        return "one" if len(self.bindings) == 1 else f"{len(self.bindings)}"

    @property
    def refs(self) -> list[str]:
        return [binding["ref"] for binding in self.bindings]

    def as_payload(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "path": self.path,
            "kind": self.kind,
            "owner": self.owner,
            "label": self.label,
            "display": self.display,
            "featureKind": self.feature_kind,
            "artifactHash": self.artifact_hash,
            "artifactRefs": self.refs,
            "solidIndices": self.solid_indices,
            "cardinality": self.cardinality,
            "source": self.source,
            "stable": self.stable,
            "container": self.container,
            "placement": self.placement,
            "bindings": self.bindings,
        }


def _normalize_expectation(expect: Any) -> tuple[int, int | None] | None:
    if expect is None:
        return None
    if isinstance(expect, bool):
        raise IdentityError("bad-query", "expect cannot be a boolean")
    if isinstance(expect, int):
        return (expect, expect)
    if expect == "one":
        return (1, 1)
    if expect == "many":
        return (1, None)
    raise IdentityError(
        "bad-query",
        f"expect must be an integer, 'one', or 'many'; got {expect!r}",
    )


class IdentityIndex:
    """Version-bound view of one artifact's declared identities."""

    def __init__(self, artifact: str | Path) -> None:
        self.artifact = Path(artifact).resolve()
        if not self.artifact.is_file():
            raise IdentityError("missing-artifact", f"artifact does not exist: {self.artifact}")
        self.artifact_hash = sha256_file(self.artifact)
        self.manifest = load_manifest(self.artifact)
        self.legacy: dict[str, Any] | None = None
        self._surfaces: set[str] | None = None
        if self.manifest is not None:
            declared = str(self.manifest.get("artifact", {}).get("sha256", ""))
            if declared != self.artifact_hash:
                raise IdentityError(
                    "stale-artifact",
                    f"identity manifest {identity_path(self.artifact)} belongs to artifact "
                    f"{declared[:12] or 'unknown'} but {self.artifact.name} is {self.artifact_hash[:12]}; "
                    "rebuild the model",
                    expected=declared,
                    actual=self.artifact_hash,
                )
            self.source = "identity"
        else:
            legacy = legacy_path(self.artifact)
            if legacy.is_file():
                value = json.loads(legacy.read_text(encoding="utf-8"))
                declared = value.get("artifactHash")
                if isinstance(declared, str) and declared and declared != self.artifact_hash:
                    raise IdentityError(
                        "stale-artifact",
                        f"legacy assembly manifest {legacy} belongs to artifact {declared[:12]} "
                        f"but {self.artifact.name} is {self.artifact_hash[:12]}",
                        expected=declared,
                        actual=self.artifact_hash,
                    )
                self.legacy = value
                self.source = "legacy"
            else:
                self.source = "anonymous"

    # -- public surface --------------------------------------------------

    def entities(self, *, kind: str | None = None, owner: str | None = None) -> list[Resolution]:
        if self.source != "identity":
            raise IdentityError(
                "no-manifest",
                f"{self.artifact.name} has no identity manifest; only current-version refs "
                "resolve. Rebuild with a declared Assembly to list semantic paths.",
                source=self.source,
            )
        owner_path = canonicalize_path(owner) if owner else None
        results = []
        for entry in self.manifest["entities"]:
            if kind is not None and entry["kind"] != kind:
                continue
            if owner_path is not None and entry.get("owner") != owner_path:
                continue
            results.append(self._resolution_for(entry, expected=entry["path"], owner=owner_path))
        return results

    def resolve(
        self,
        target: str,
        *,
        kind: str | None = None,
        owner: str | None = None,
        expect: Any = None,
    ) -> Resolution:
        """Resolve one semantic path or one current-artifact ref."""
        if not isinstance(target, str) or not target:
            raise IdentityError("bad-query", "a target must be a non-empty string")
        cardinality = _normalize_expectation(expect)
        resolution = self._resolve_ref(target) if _is_ref(target) else self._resolve_path(target)
        if kind is not None and resolution.kind != kind:
            raise IdentityError(
                "wrong-kind",
                f"'{target}' is a {resolution.kind}, not a {kind}",
                target=target,
                expected=kind,
                actual=resolution.kind,
            )
        if owner is not None and resolution.owner != canonicalize_path(owner):
            raise IdentityError(
                "wrong-owner",
                f"'{target}' is owned by {resolution.owner or 'the artifact root'}, not '{owner}'",
                target=target,
                expected=canonicalize_path(owner),
                actual=resolution.owner,
            )
        if cardinality is not None:
            low, high = cardinality
            found = len(resolution.bindings)
            if found < low or (high is not None and found > high):
                raise IdentityError(
                    "cardinality",
                    f"'{target}' has {found} geometry binding(s), which does not satisfy "
                    f"the requested cardinality",
                    target=target,
                    found=found,
                    expected={"min": low, "max": high},
                )
        return resolution

    def verify(self) -> dict[str, Any]:
        """Report whether the manifest and the artifact still agree."""
        return {
            "artifact": str(self.artifact),
            "artifactHash": self.artifact_hash,
            "source": self.source,
            "manifest": str(identity_path(self.artifact)) if self.manifest else None,
            "manifestArtifactHash": (self.manifest or {}).get("artifact", {}).get("sha256"),
            "ok": self.source == "identity" and self.manifest["artifact"]["sha256"] == self.artifact_hash,
            "counts": (self.manifest or {}).get("counts", {}),
        }

    def refs(self) -> dict[str, list[str]]:
        if self.source == "identity":
            return dict(self.manifest["refs"])
        if self.source == "legacy":
            return {}
        return {}

    # -- internals -------------------------------------------------------

    def _resolve_ref(self, ref: str) -> Resolution:
        for prefix, kind in _REF_PREFIXES.items():
            if not ref.startswith(prefix):
                continue
            if self.source == "identity":
                paths = self.manifest["refs"].get(ref)
                if paths is None:
                    raise IdentityError(
                        "unknown-ref",
                        f"'{ref}' is not bound by artifact version {self.artifact_hash[:12]}; "
                        "a ref from another build is dead, so re-inspect the current artifact",
                        target=ref,
                        artifactHash=self.artifact_hash,
                    )
                if isinstance(paths, str):  # manifests written before ref arrays
                    paths = [paths]
                if len(paths) != 1:
                    raise IdentityError(
                        "ambiguous-ref",
                        f"'{ref}' is bound to {len(paths)} semantic paths "
                        f"({', '.join(paths)}); resolve a semantic path instead",
                        target=ref,
                        paths=paths,
                        artifactHash=self.artifact_hash,
                    )
                path = paths[0]
                for entry in self.manifest["entities"]:
                    if entry["path"] == path:
                        return self._resolution_for(entry, expected=ref)
            self._require_current_ref(ref)
            return Resolution(
                target=ref,
                path=None,
                kind=kind,
                artifact_hash=self.artifact_hash,
                source=self.source,
                stable=False,
                legacy=self.source == "legacy",
                bindings=[{"target": kind, "ref": ref, "solidIndex": None, "facts": {}}],
            )
        raise IdentityError(
            "unknown-ref",
            f"'{ref}' is not a current-artifact ref; refs start with "
            f"{', '.join(sorted(_REF_PREFIXES))}",
            target=ref,
        )

    def _require_current_ref(self, ref: str) -> None:
        """Fail closed on a ref that belongs to another artifact version."""
        if ref.startswith("surf-"):
            if ref not in self._surface_ids():
                raise IdentityError(
                    "unknown-ref",
                    f"'{ref}' is not a surface of artifact version {self.artifact_hash[:12]}; "
                    "re-inspect the current artifact",
                    target=ref,
                    artifactHash=self.artifact_hash,
                )
            return
        if f"-{self.artifact_hash[:12]}-" not in ref:
            raise IdentityError(
                "unknown-ref",
                f"'{ref}' carries the token of another artifact version, not "
                f"{self.artifact_hash[:12]}",
                target=ref,
                artifactHash=self.artifact_hash,
            )

    def _surface_ids(self) -> set[str]:
        if self._surfaces is None:
            from ..simulation.surface_selector import enumerate_surfaces

            self._surfaces = {surface["id"] for surface in enumerate_surfaces(self.artifact)["surfaces"]}
        return self._surfaces

    def _resolve_path(self, target: str) -> Resolution:
        canonical = canonicalize_path(target)
        if self.source == "identity":
            for entry in self.manifest["entities"]:
                if entry["path"] == canonical:
                    return self._resolution_for(entry, expected=target)
            raise IdentityError(
                "unknown-path",
                f"{self.artifact.name} does not declare '{canonical}'. Known paths: "
                + ", ".join(sorted(entity["path"] for entity in self.manifest["entities"])[:20]),
                target=canonical,
            )
        if self.source == "legacy":
            parts = (self.legacy or {}).get("parts", [])
            for part in parts:
                if str(part.get("id")) == canonical or str(part.get("name")) == target:
                    return Resolution(
                        target=target,
                        path=str(part.get("id")),
                        kind="part",
                        artifact_hash=self.artifact_hash,
                        source="legacy",
                        stable=False,
                        label=str(part.get("name")) if part.get("name") else None,
                        legacy=True,
                        bindings=[
                            {"target": "solid", "ref": f"solid-{self.artifact_hash[:12]}-{index}", "solidIndex": index, "facts": {}}
                            for index in part.get("solidIndices", [])
                            if isinstance(index, int)
                        ],
                    )
            raise IdentityError(
                "unknown-path",
                f"{self.artifact.name} carries a legacy .assembly.json with ids "
                + ", ".join(sorted(str(part.get('id')) for part in parts)),
                target=canonical,
            )
        raise IdentityError(
            "no-manifest",
            f"{self.artifact.name} has no identity manifest, so '{canonical}' cannot be "
            "resolved. A legacy or anonymous artifact has only current-version refs "
            "(occ-*, surf-*). Rebuild the model with a declared Assembly for stable names.",
            target=canonical,
            source=self.source,
        )

    def _resolution_for(
        self,
        entry: dict[str, Any],
        *,
        expected: str,
        owner: str | None = None,
    ) -> Resolution:
        return Resolution(
            target=expected,
            path=entry["path"],
            kind=entry["kind"],
            artifact_hash=self.artifact_hash,
            source="identity",
            stable=True,
            label=entry.get("label"),
            display=entry.get("display"),
            owner=entry.get("owner"),
            feature_kind=entry.get("featureKind"),
            coordinate=entry.get("coordinate"),
            bindings=list(entry.get("bindings", [])),
            solid_indices=list(entry.get("solidIndices", [])),
            container=bool(entry.get("container")),
            placement=entry.get("world"),
        )


def _is_ref(target: str) -> bool:
    return any(target.startswith(prefix) for prefix in _REF_PREFIXES)


def resolve_many(
    index: IdentityIndex,
    targets: Iterable[str],
    *,
    kind: str | None = None,
    owner: str | None = None,
    expect: Any = None,
) -> list[Resolution]:
    return [index.resolve(target, kind=kind, owner=owner, expect=expect) for target in targets]


def ancestor_paths(path: str) -> list[str]:
    """Every owner above ``path``, nearest first."""
    chain: list[str] = []
    current = parent_path(path)
    while current is not None:
        chain.append(current)
        current = parent_path(current)
    return chain
