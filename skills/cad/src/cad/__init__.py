from __future__ import annotations

"""Prime-native Python surface for Pi-CAD Plan C."""

from pathlib import Path
from typing import Any

from . import artifacts, model, review, simulation, snapshot, templates, workflow
from .client import CadApiError, project_path, request
from .probe import probe
from .refs import ArtifactRef, Commit


def _commit_from_payload(manifest: dict[str, Any], variables: dict[str, Any]) -> Commit:
    artifacts = tuple(ArtifactRef(Path(item["path"]), item.get("sha256"), item.get("role", "artifact")) for item in manifest.get("artifacts", []))
    return Commit(
        manifest["id"], manifest["name"], manifest.get("parent"), manifest["workflowHash"], manifest["phase"],
        variables, artifacts, manifest["createdAt"],
    )


async def commit(name: str, *, parent: str | Commit | None = None, variables: dict[str, Any] | None = None, artifacts: list[str | Path | ArtifactRef] | None = None) -> Commit:
    encoded = {key: snapshot.registry.encode(value) for key, value in (variables or {}).items()}
    artifact_payload: list[dict[str, str]] = []
    for item in artifacts or []:
        if isinstance(item, ArtifactRef):
            _, relative = project_path(item.path, error_type="CommitError")
            artifact_payload.append({"path": relative.as_posix(), "role": item.role})
        else:
            _, relative = project_path(item, error_type="CommitError")
            artifact_payload.append({"path": relative.as_posix(), "role": "workspace-commit-artifact"})
    parent_id = parent.id if isinstance(parent, Commit) else parent
    commit_payload: dict[str, Any] = {"name": name, "variables": encoded, "artifacts": artifact_payload}
    # Omitting parent means "chain from the current workspace head". Sending
    # JSON null here instead would explicitly create a new root commit and
    # breaks the reviewed-candidate -> release authority chain.
    if parent_id is not None:
        commit_payload["parent"] = parent_id
    manifest = await request("commit", **commit_payload)
    return _commit_from_payload(manifest, dict(variables or {}))


async def load(commit_id: str) -> Commit:
    payload = await request("load", id=commit_id)
    variables = {name: snapshot.registry.decode(value) for name, value in payload["variables"].items()}
    return _commit_from_payload(payload["manifest"], variables)


async def history() -> list[Commit]:
    manifests = await request("history")
    return [_commit_from_payload(manifest, {}) for manifest in manifests]


__all__ = [
    "ArtifactRef", "CadApiError", "Commit", "artifacts", "commit", "history", "load", "model", "probe", "review", "simulation", "snapshot", "templates", "workflow",
]
