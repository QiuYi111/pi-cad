from __future__ import annotations

"""Export a FreeCAD part to a native Fusion or SolidWorks file with feature history.

    await cad.transfer.status()                       # which targets are ready on this machine
    features = await cad.transfer.features("parts/bracket.FCStd")   # dry run, no CAD app needed
    job = await cad.transfer.export("parts/bracket.FCStd", target="fusion", output="exports/bracket.f3d")
    result = await job.result()                       # check='passed' means the STEP files match

The tool reads the committed, recomputed document and never changes it. The CAD
program runs on the user's own machine and is started by the Reify desktop app.
Without the desktop app every ``export`` raises ``CadApiError`` with
``code == "TRANSFER_UNAVAILABLE"``.
"""

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import snapshot
from .client import CadApiError, project_path, request
from .part import PartDocument

TARGETS = ("fusion", "solidworks")
_SUFFIX = {"fusion": ".f3d", "solidworks": ".SLDPRT"}


def _bad_request(message: str) -> CadApiError:
    return CadApiError(message, error_type="TransferError", code="BAD_REQUEST")


def _doc_path(doc: str | Path | PartDocument) -> str:
    value = doc.path if isinstance(doc, PartDocument) else doc
    _absolute, relative = project_path(value, error_type="TransferError")
    if relative.suffix.lower() != ".fcstd":
        raise _bad_request(f"a transfer source must be a .FCStd document, got {relative.as_posix()}")
    return relative.as_posix()


@dataclass(frozen=True, repr=False)
class TransferStatus:
    """Readiness of each target on this machine. A state is ``ready`` or says what is missing."""

    fusion: str
    solidworks: str
    detail: dict[str, Any] = field(default_factory=dict, compare=False)

    def __repr__(self) -> str:
        return f"TransferStatus(fusion={self.fusion!r}, solidworks={self.solidworks!r})"


@dataclass(frozen=True, repr=False)
class TransferFeatures:
    """The canonical feature JSON of a part (``reify.features/1``), written to ``path``."""

    part: str
    features: int
    path: str
    data: dict[str, Any] = field(default_factory=dict, compare=False)

    def __repr__(self) -> str:
        return f"TransferFeatures(part={self.part!r}, features={self.features}, path={self.path!r})"


@dataclass(frozen=True, repr=False)
class TransferResult:
    """One finished export. ``check`` is ``passed``, ``failed`` or ``skipped``."""

    target: str
    file: str
    check_step: str | None
    check: str
    features: int
    log: str | None = None
    detail: dict[str, Any] | None = None

    def __repr__(self) -> str:
        return f"TransferResult(target={self.target!r}, file={self.file!r}, check={self.check!r}, features={self.features})"


@dataclass(frozen=True, repr=False)
class TransferJob:
    _task: asyncio.Task[dict[str, Any]]
    target: str

    def __repr__(self) -> str:
        if not self._task.done():
            status = "running"
        else:
            status = "cancelled" if self._task.cancelled() else ("failed" if self._task.exception() else "completed")
        return f"TransferJob(target={self.target!r}, status={status!r})"

    def cancel(self) -> None:
        self._task.cancel()

    async def result(self) -> TransferResult:
        payload = await self._task
        return _result_from_wire(payload)


def _result_from_wire(payload: dict[str, Any]) -> TransferResult:
    return TransferResult(
        target=payload["target"],
        file=payload["file"],
        check_step=payload.get("checkStep"),
        check=payload["check"],
        features=int(payload["features"]),
        log=payload.get("log"),
        detail=payload.get("detail"),
    )


async def status() -> TransferStatus:
    """Which targets are ready on this machine. Has no side effects."""
    response = await request("transfer-status")
    return TransferStatus(response["fusion"], response["solidworks"], response.get("detail") or {})


async def features(doc: str | Path | PartDocument) -> TransferFeatures:
    """Dry run: build the canonical feature JSON. Raises ``TRANSFER_UNSUPPORTED_OP`` for an op the targets cannot build."""
    response = await request("transfer-features", doc=_doc_path(doc))
    data = response.get("data") or {}
    return TransferFeatures(response["part"], int(response["features"]), response["path"], data)


async def export(
    doc: str | Path | PartDocument,
    *,
    target: str,
    output: str | Path | None = None,
    check: bool = True,
) -> TransferJob:
    """Start an export and return a job. ``await job.result()`` gives the ``TransferResult``.

    ``check=False`` is for debugging only; the result then says ``check='skipped'``.
    """
    if target not in TARGETS:
        raise _bad_request(f"target must be one of {list(TARGETS)}, got {target!r}")
    doc_relative = _doc_path(doc)
    suffix = _SUFFIX[target]
    requested = Path(output) if output is not None else Path("exports") / f"{Path(doc_relative).stem}{suffix}"
    _absolute, output_relative = project_path(requested, error_type="TransferError")
    if output_relative.suffix.lower() != suffix.lower():
        raise _bad_request(f"a {target} export must end in {suffix}, got {output_relative.as_posix()}")
    task = asyncio.create_task(
        request("transfer-export", doc=doc_relative, target=target, output=output_relative.as_posix(), check=bool(check))
    )
    return TransferJob(task, target)


snapshot.register(
    TransferResult,
    "cad.transfer",
    lambda value: {
        "target": value.target, "file": value.file, "checkStep": value.check_step, "check": value.check,
        "features": value.features, "log": value.log, "detail": value.detail,
    },
    _result_from_wire,
)
