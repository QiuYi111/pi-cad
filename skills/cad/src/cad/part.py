from __future__ import annotations

"""FreeCAD part documents: edit a parametric model with small JSON ops.

    doc = await cad.part.open("parts/bracket.FCStd", output="build/bracket.step", create=True, body="bracket")
    r = await doc.apply([
        {"op": "param", "name": "width", "value": 40, "unit": "mm"},
        {"op": "sketch", "name": "bracket/base_profile", "plane": "XY",
         "shapes": [{"rect": {"center": [0, 0], "size": ["=width", 20]}}]},
        {"op": "pad", "name": "bracket/base", "sketch": "bracket/base_profile", "length": 5},
    ])

Every ``open``, ``apply``, ``undo`` and ``try_`` attaches the seven mandatory
views (changed faces in orange, features named) and returns what changed. The
backend is optional: without ``npm run setup:freecad`` every call raises
``CadApiError`` with ``code == "FREECAD_NOT_INSTALLED"``.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import snapshot
from .client import CadApiError, project_path, request
from .model import _attach_images
from .refs import ArtifactRef


def _path(value: str | Path) -> tuple[Path, Path]:
    return project_path(value, error_type="PartError")



@dataclass(frozen=True, repr=False)
class PartResult:
    """What one ``open``, ``apply``, ``undo`` or ``try_`` did."""

    rev: int
    artifact: ArtifactRef | None
    changes: dict[str, Any] | None
    part: dict[str, Any] = field(default_factory=dict, compare=False)
    highlighted: bool = False
    applied: bool = True

    @property
    def features(self) -> dict[str, Any]:
        return self.part.get("features") or {}

    @property
    def params(self) -> dict[str, Any]:
        return (self.part.get("params") or {}).get("changed") or {}

    @property
    def intent(self) -> list[dict[str, Any]]:
        return self.part.get("intent") or []

    @property
    def warnings(self) -> list[dict[str, Any]]:
        return self.part.get("warnings") or []

    def __repr__(self) -> str:
        pieces = [f"rev={self.rev}"]
        if not self.applied:
            pieces.append("not applied")
        if self.artifact is not None:
            pieces.append(f"artifact={self.artifact!r}")
        changes = self.changes or {}
        volume = (changes.get("volumeMm3") or {}).get("delta")
        if volume:
            pieces.append(f"volume {volume:+g} mm³")
        faces = changes.get("faces") or {}
        if faces.get("new") is not None:
            pieces.append(f"faces +{faces['new']}/-{faces['removed']}")
        if self.warnings:
            pieces.append(f"warnings={len(self.warnings)}")
        failed = [item for item in self.intent if item.get("status") != "pass"]
        if failed:
            pieces.append(f"intent failing={len(failed)}")
        return f"PartResult({', '.join(pieces)})"


class PartDocument:
    """Handle on one ``.FCStd`` document. Holds only paths; the model lives in the FreeCAD worker."""

    def __init__(self, path: Path, output: Path, body: str | None = None) -> None:
        self.path = path
        self.output = output
        self.body = body

    def __repr__(self) -> str:
        return f"PartDocument(path={str(self.path)!r}, output={str(self.output)!r})"

    def __cad_snapshot__(self) -> dict[str, Any]:
        return {"kind": "part-document", "path": str(self.path), "output": str(self.output), **({"body": self.body} if self.body else {})}

    def _wire(self) -> dict[str, Any]:
        return {"doc": self.path.as_posix(), "output": self.output.as_posix()}

    async def _present(self, response: dict[str, Any], what: str, *, applied: bool = True) -> PartResult:
        part = response.get("part") or {}
        changes = response.get("changes")
        artifact = response.get("artifact")
        ref = ArtifactRef(Path(artifact["path"]), artifact.get("sha256"), "candidate", changes) if artifact else None
        images = response.get("images") or []
        rev = int(part.get("rev", 0))
        if images:
            await _attach_images(
                images, ref, changes=changes, highlighted=bool(response.get("highlighted")),
                subject=f"Part {self.path.as_posix()} rev {rev} {what}" + (f": {ref!r}" if ref is not None else ""),
            )
        return PartResult(rev, ref, changes, part, bool(response.get("highlighted")), applied)

    async def apply(
        self,
        ops: list[dict[str, Any]],
        *,
        message: str | None = None,
        validation: str = "auto",
        budget_s: float | None = None,
    ) -> PartResult:
        """Run ops in one transaction; commit, rebuild, and attach the views, or raise with nothing changed."""
        _check_ops(ops)
        response = await request(
            "part-apply", **self._wire(), ops=ops, validation=validation,
            **({"message": message} if message else {}), **({"budgetS": budget_s} if budget_s else {}),
        )
        return await self._present(response, "built")

    async def try_(self, ops: list[dict[str, Any]], *, budget_s: float | None = None) -> PartResult:
        """Run ops, show the result and the change summary, then throw the change away."""
        _check_ops(ops)
        response = await request("part-try", **self._wire(), ops=ops, **({"budgetS": budget_s} if budget_s else {}))
        return await self._present(response, "trial (not applied)", applied=False)

    async def undo(self, *, validation: str = "auto") -> PartResult:
        response = await request("part-undo", **self._wire(), validation=validation)
        return await self._present(response, "after undo")

    async def tree(self) -> dict[str, Any]:
        """Compact feature tree: parameters, expressions, sketches (with DoF), roles, requirements."""
        return await request("part-tree", **self._wire())

    async def query(self, target: str, what: list[str] | None = None) -> dict[str, Any]:
        """Read parameters and geometry facts of a body, feature, or role path (no STEP export)."""
        return await request("part-query", **self._wire(), target=target, **({"what": what} if what else {}))

    async def check(self, kind: str, *, budget_s: float | None = None, **args: Any) -> dict[str, Any]:
        """``clearance(a, b)``, ``interference(pairs=... | all=True)``, ``wall_thickness(target, samples)``, ``mass(target)``."""
        return await request("part-check", **self._wire(), kind=kind, args=args, **({"budgetS": budget_s} if budget_s else {}))

    async def sweep(
        self,
        param: str,
        range: tuple[float, float],  # noqa: A002 -- the documented keyword
        *,
        step: float,
        check: tuple[str, dict[str, Any]],
        refine: bool = False,
        budget_s: float | None = None,
    ) -> dict[str, Any]:
        """Vary one parameter, run ``check`` at every sample, and show the worst pose."""
        kind, args = check
        response = await request(
            "part-sweep", **self._wire(), param=param, range=[range[0], range[1]], step=step,
            check={"kind": kind, "args": args}, refine=refine, **({"budgetS": budget_s} if budget_s else {}),
        )
        images = response.get("images") or []
        summary = response.get("sweep") or {}
        if images:
            await _attach_images(
                images, None, subject=f"Part {self.path.as_posix()} sweep of {param}: worst pose at {summary.get('worstPose')}",
            )
        return summary


def _check_ops(ops: Any) -> None:
    if not isinstance(ops, list) or not ops or not all(isinstance(item, dict) for item in ops):
        raise CadApiError("ops must be a non-empty list of op dicts", error_type="PartError", code="OP_SCHEMA_INVALID")


async def open(  # noqa: A001 -- the documented name: cad.part.open
    doc: str | Path,
    *,
    output: str | Path | None = None,
    create: bool = False,
    body: str | None = None,
    validation: str = "auto",
) -> PartDocument:
    """Open a ``.FCStd`` document (``create=True`` starts a new one). An existing model is shown at once."""
    doc_path, doc_relative = _path(doc)
    requested = Path(output) if output is not None else Path("build") / f"{doc_path.stem}.step"
    _output_path, output_relative = _path(requested)
    handle = PartDocument(doc_relative, output_relative, body)
    response = await request(
        "part-open", doc=doc_relative.as_posix(), output=output_relative.as_posix(), create=create, validation=validation,
        **({"body": body} if body else {}),
    )
    await handle._present(response, "opened")
    return handle


snapshot.register(
    PartDocument,
    "cad.part",
    lambda value: value.__cad_snapshot__(),
    lambda payload: PartDocument(Path(payload["path"]), Path(payload["output"]), payload.get("body")),
)
