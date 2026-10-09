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



def _number(value: Any) -> str:
    return f"{value:g}" if isinstance(value, (int, float)) and not isinstance(value, bool) else str(value)


def _dfm_target(target: Any) -> str:
    if isinstance(target, dict):
        body = target.get("body") or "?"
        return f"{body}#face{target['face']}" if target.get("face") is not None else str(body)
    return str(target) if target else "?"


def _dfm_issue_line(issue: dict[str, Any]) -> str:
    measured, limit = issue.get("measured"), issue.get("limit")
    unit = issue.get("unit") or "mm"
    if measured is not None and limit is not None:
        figures = f" ({_number(measured)}/{_number(limit)} {unit})"
    elif measured is not None:
        figures = f" ({_number(measured)} {unit})"
    else:
        figures = ""
    source = f" — {issue['source']}" if issue.get("source") else ""
    return f"- [{issue.get('severity')}] {issue.get('rule')} {_dfm_target(issue.get('target'))}: {issue.get('message', '')}{figures}{source}"


def _flagged(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Error and warning issues, errors first, in the order the worker gave them."""
    flagged = [issue for issue in issues if issue.get("severity") in ("error", "warn")]
    return sorted(flagged, key=lambda issue: issue.get("severity") != "error")


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

    @property
    def dfm(self) -> dict[str, Any] | None:
        """The DFM summary of this revision: ``counts``, the first error and warning ``issues``, and ``geometry`` state. None without a profile."""
        return self.part.get("dfm") or None

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
        lines = [f"PartResult({', '.join(pieces)})"]
        if self.dfm:
            counts = self.dfm.get("counts") or {}
            state = (self.dfm.get("geometry") or {}).get("state", "none")
            layer = self.dfm.get("layer", "lint")
            lines.append(
                f"DFM ({self.dfm.get('rulepack')}, {layer}): {counts.get('error', 0)} error, {counts.get('warn', 0)} warn"
                f" — geometry {state}; run doc.dfm() for the geometry check"
            )
            lines.extend(_dfm_issue_line(issue) for issue in _flagged(self.dfm.get("issues") or [])[:3])
        return "\n".join(lines)


@dataclass(frozen=True, repr=False)
class DfmReport:
    """What ``doc.dfm()`` found: the lint and geometry layers merged, with the report file and the attached views."""

    rulepack: str
    material: str
    rev: int
    analyzer: str | None
    #: Every issue, ``info`` included; each has ``rule``, ``severity``, ``layer``, ``target``, ``message``, ``source``.
    issues: list[dict[str, Any]]
    counts: dict[str, int]
    #: Per rule: ``status`` is ``checked`` or ``skipped`` (with ``reason``). A skipped rule is not a pass.
    coverage: list[dict[str, Any]]
    report_path: str | None = None
    #: True when the views show highlighted error or warning faces.
    highlighted: bool = False
    #: Names of the attached views, in order.
    views: tuple[str, ...] = ()

    def __repr__(self) -> str:
        counts = self.counts
        lines = [
            f"DFM ({self.rulepack}, {self.analyzer or 'lint'}): {counts.get('error', 0)} error, "
            f"{counts.get('warn', 0)} warn, {counts.get('info', 0)} info"
        ]
        lines.extend(_dfm_issue_line(issue) for issue in _flagged(self.issues)[:8])
        skipped = sum(1 for item in self.coverage if item.get("status") == "skipped")
        if skipped:
            lines.append(f"skipped: {skipped} rules (see coverage)")
        return "\n".join(lines)


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
        observe: bool = True,
    ) -> PartResult:
        """Run ops in one transaction; commit, rebuild, and attach the views, or raise with nothing changed.

        ``observe=False`` commits the revision and returns at once, with no views, no change summary and no STEP.
        Use it for the batches of ``link`` ops that build up an assembly, and let the last apply observe: rendering
        the whole assembly after every batch costs more than the batch.

        A pad, pocket, hole or pattern that does not change the solid's volume fails with ``FEATURE_NO_EFFECT``
        (volumes and a ``reversed`` hint in the error); a middle feature can be deleted, its successors are relinked.
        """
        _check_ops(ops)
        response = await request(
            "part-apply", **self._wire(), ops=ops, validation=validation,
            **({"message": message} if message else {}), **({"budgetS": budget_s} if budget_s else {}),
            **({} if observe else {"observe": False}),
        )
        return await self._present(response, "built" if observe else "built (not observed yet)")

    async def try_(self, ops: list[dict[str, Any]], *, budget_s: float | None = None) -> PartResult:
        """Run ops, show the result and the change summary, then throw the change away."""
        _check_ops(ops)
        response = await request("part-try", **self._wire(), ops=ops, **({"budgetS": budget_s} if budget_s else {}))
        return await self._present(response, "trial (not applied)", applied=False)

    async def undo(self, *, to_empty: bool = False, validation: str = "auto") -> PartResult:
        """Go back one revision. A failed ``apply`` is already rolled back: do not undo it.

        Undoing the only revision would leave an empty document, so it raises
        ``UNDO_WOULD_EMPTY`` unless ``to_empty=True``.
        """
        response = await request("part-undo", **self._wire(), validation=validation, **({"toEmpty": True} if to_empty else {}))
        return await self._present(response, "after undo")

    async def tree(self) -> dict[str, Any]:
        """Compact feature tree: parameters, expressions, sketches (with DoF), roles, requirements."""
        return await request("part-tree", **self._wire())

    async def query(self, target: str, what: list[str] | None = None) -> dict[str, Any]:
        """Read parameters and geometry facts of a body, feature, or role path (no STEP export)."""
        return await request("part-query", **self._wire(), target=target, **({"what": what} if what else {}))

    async def dfm(self, *, layers: tuple[str, ...] = ("lint", "geometry"), budget_s: float | None = None) -> DfmReport:
        """Run the DFM check against the last applied revision: ``lint`` (feature rules) and ``geometry`` (analysis of the shape).

        Needs a ``dfm_profile`` op in the document. Writes ``build/dfm/rev-<n>.json`` and attaches the views, with
        error and warning faces highlighted and labelled by rule id. ``geometry`` is slower and its rules are
        ``skipped`` (never passed) when the analyzer is unavailable; ``coverage`` says which.
        """
        wanted = tuple(layers)
        if not wanted or any(layer not in ("lint", "geometry") for layer in wanted):
            raise CadApiError("layers must be a non-empty subset of ('lint', 'geometry')", error_type="PartError", code="OP_SCHEMA_INVALID")
        response = await request(
            "part-dfm", **self._wire(), layers=list(wanted), **({"budgetS": budget_s} if budget_s else {}),
        )
        report = response.get("report") or {}
        images = response.get("images") or []
        highlighted = bool(response.get("highlighted"))
        counts = report.get("counts") or {}
        await _attach_images(
            images, None, highlighted=highlighted,
            subject=(
                f"Part {self.path.as_posix()} DFM rev {report.get('rev')} ({report.get('rulepack')}): "
                f"{counts.get('error', 0)} error, {counts.get('warn', 0)} warn; report {report.get('report_path')}"
            ),
        )
        return DfmReport(
            rulepack=report.get("rulepack", ""), material=report.get("material", ""), rev=int(report.get("rev", 0)),
            analyzer=report.get("analyzer"), issues=list(report.get("issues") or []), counts=dict(counts),
            coverage=list(report.get("coverage") or []), report_path=report.get("report_path"),
            highlighted=highlighted, views=tuple(str(image.get("name") or "") for image in images),
        )

    async def check(self, kind: str, *, budget_s: float | None = None, **args: Any) -> dict[str, Any]:
        """``clearance(a, b)``, ``interference(pairs=... | all=True, tolerance=1e-3, contact_tol=0.2)`` (B-Rep ``common``: ``interferences`` have volume, ``contacts`` touch or are closer than ``contact_tol`` mm; ``value`` is the worst interference volume), ``wall_thickness(target, samples)``, ``mass(target)``."""
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
