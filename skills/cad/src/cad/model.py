from __future__ import annotations

"""Thin model handles over the existing Pi-CAD build capability."""

from pathlib import Path
from typing import Any

from ._attachments import display_inline_image
from .client import CadApiError, project_path, request
from .refs import ArtifactRef


def _project_path(value: str | Path) -> tuple[Path, Path]:
    return project_path(value, error_type="ModelBuildError")


async def _attach_images(images: list[dict[str, str]], artifact: ArtifactRef | None = None) -> None:
    if not images:
        raise CadApiError("Pi-CAD model build produced no mandatory visual observations", error_type="ModelBuildError")
    try:
        import IPython.display  # noqa: F401 -- fail clearly when the Prime kernel display channel is unavailable
    except Exception as error:
        raise CadApiError("Prime image attachment capability is unavailable", error_type="ModelBuildError") from error
    try:
        for index, image in enumerate(images):
            if image.get("mimeType") != "image/png" or not image.get("data"):
                raise ValueError("mandatory build image is not an inline PNG")
            view = image.get("name") or image.get("view")
            view_label = f"[{str(view).upper()}]" if view else "[VIEW]"
            label = (
                f"Built {artifact!r}. Inspect the attached views carefully as the primary observation of the actual geometry. "
                f"Reason about what the geometry actually does before your next action. Probe only for facts you need to verify.\n\n{view_label}"
                if index == 0 and artifact is not None else view_label
            )
            display_inline_image(image, label=label)
    except Exception as error:
        raise CadApiError(f"Pi-CAD could not inject mandatory build images into Prime: {error}", error_type="ModelBuildError") from error


async def build(
    source: str | Path,
    output: str | Path | None = None,
    *,
    force: bool = False,
    validation: str = "auto",
    parameters: dict[str, dict[str, Any]] | None = None,
) -> ArtifactRef:
    if validation not in {"auto", "fast", "full"}:
        raise CadApiError("validation must be auto, fast, or full", error_type="ModelBuildError")
    source_path, source_relative = _project_path(source)
    requested_output = Path(output) if output is not None else Path("build") / f"{source_path.stem}.step"
    output_path, output_relative = _project_path(requested_output)
    response: dict[str, Any] = await request(
        "model-build",
        source=source_relative.as_posix(),
        output=output_relative.as_posix(),
        force=force,
        validation=validation,
        **({"parameters": parameters} if parameters is not None else {}),
    )
    envelope = response.get("build") or {}
    if not envelope.get("ok"):
        payload = envelope.get("payload") or {}
        raise CadApiError(payload.get("error") or "Pi-CAD model build failed", error_type="ModelBuildError")
    artifacts = envelope.get("artifacts") or []
    artifact = next((item for item in artifacts if item.get("kind") == "step"), artifacts[0] if artifacts else None)
    if not artifact or not output_path.is_file():
        raise CadApiError(f"Pi-CAD model build did not create {output_relative.as_posix()}", error_type="ModelBuildError")
    digest = artifact.get("sha256") if artifact else None
    ref = ArtifactRef(output_relative, digest, "candidate")
    await _attach_images(response.get("images") or [], ref)
    return ref
