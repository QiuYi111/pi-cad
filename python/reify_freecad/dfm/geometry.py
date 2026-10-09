"""Second layer: geometry and feature recognition (imports FreeCAD).

``evaluate_geometry`` builds one face table per solid unit, runs reify-asi (when installed)
on each unit's solid, then runs every rule whose layers include ``geometry``. ``merge`` combines
the lint and geometry results; ``marks`` builds the highlight and annotations of the errors and
warnings. See docs/dfm/implementation-plan.zh-CN.md section 7.
"""

from __future__ import annotations

import tempfile
import time
from pathlib import Path
from typing import Any

import FreeCAD as App

from .. import summary
from ..assembly import units
from ..errors import ReifyOpError
from ..roles import label_anchor
from .asi import find_reify_asi, run_asi
from .geometry_checks import GEOMETRY_CHECKS, NEEDS_ASI, BodyFaces, BudgetExceeded, face_info
from .issues import make_issue
from .profile import get_profile
from .rulepack import Rule, Rulepack, load_rulepack

ASI_CHECKS = ["holes", "blends", "thickness"]
MISMATCH_RULE = Rule(
    id="dfm.layer_mismatch", check="layer_mismatch", layers=("geometry",), severity="warn", params={},
    source={"page": 0, "quote": "lint and geometry verdicts differ"}, hint="lint and geometry disagree: {measured} vs {limit}",
)
_VALUE_TOL = 1e-6


def _coverage(rule: Rule, status: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {"rule": rule.id, "layer": "geometry", "status": status, "reason": reason, **extra}


def _match_index(face: Any, local_meta: list[tuple[Any, float]], tol: float) -> int | None:
    centre, area = face.CenterOfMass, face.Area
    for position, (c, a) in enumerate(local_meta, 1):
        if (c - centre).Length < tol and abs(a - area) < max(tol, 1e-4 * max(area, 1.0)):
            return position
    return None


def _feature_map(session: Any, unit: Any, local: Any, tol: float) -> dict[int, tuple[str, str]]:
    """1-based face index of the unit's local shape -> (feature path, role), from the role table."""
    roles = unit.roles(session)
    if roles is None:
        return {}
    local_meta = [(f.CenterOfMass, f.Area) for f in local.Faces]
    out: dict[int, tuple[str, str]] = {}
    for key, entries in roles.faces.items():
        feature, _, role = key.rpartition("/")
        for entry in entries:
            index = _match_index(entry.face, local_meta, tol)
            if index is not None and index not in out:
                out[index] = (feature, role)
    return out


def _build_body(session: Any, unit: Any) -> BodyFaces | None:
    local = unit.local_shape()
    if local.isNull() or not local.Solids:
        return None
    world = local.copy()
    world.Placement = unit.placement.multiply(world.Placement)
    tol = 1e-4 * max(world.BoundBox.DiagonalLength, 1.0)
    faces = [face_info(index, face) for index, face in enumerate(world.Faces, 1)]
    by_index = {face.idx: face for face in faces}
    for index, (feature, role) in _feature_map(session, unit, local, tol).items():
        if index in by_index:
            by_index[index].feature = feature
            by_index[index].role = role
    return BodyFaces(path=unit.path, kind=unit.kind, local=local, world=world, faces=faces, by_index=by_index, bbox=world.BoundBox)


def build_facts(session: Any, pack: Rulepack, profile: dict[str, Any], budget: Any) -> dict[str, Any]:
    found = units(session)
    bodies = []
    for unit in found:
        body = _build_body(session, unit)
        if body is not None:
            bodies.append(body)
    part = found[0].path if len(found) == 1 else session.fcstd.stem  # the same name as the lint facts
    bbox = None
    if bodies:
        union = App.BoundBox(bodies[0].bbox)
        for body in bodies[1:]:
            union.add(body.bbox)
        bbox = [union.XLength, union.YLength, union.ZLength]
    return {
        "session": session, "pack": pack, "profile": profile, "budget": budget, "bodies": bodies,
        "asi": None, "part": part, "bbox": bbox, "cache": {}, "_skipped": [],
    }


def _run_analyzer(facts: dict[str, Any], budget: Any) -> tuple[str, dict[str, Any] | None, dict[str, Any]]:
    """(analyzer name, reify-asi results per body path or None, status for the report)."""
    if find_reify_asi() is None:
        return "builtin", None, {"status": "unavailable", "message": "reify-asi is not installed or PI_CAD_ASI_BIN points to a missing file"}
    results: dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="reify-dfm-") as scratch:
        try:
            for position, body in enumerate(facts["bodies"]):
                brep = Path(scratch) / f"body-{position}.brep"
                body.local.exportBrep(str(brep))
                remaining = budget.remaining()
                timeout = 60.0 if remaining is None else max(1.0, 0.7 * remaining)
                data = run_asi(brep, ASI_CHECKS, timeout)
                if int(data.get("faces", -1)) != len(body.local.Faces):
                    raise ReifyOpError("DFM_ANALYZER_FAILED", "reify-asi counted a different number of faces",
                                       detail={"body": body.path, "faces": data.get("faces"), "expected": len(body.local.Faces)})
                results[body.path] = data
        except ReifyOpError as error:
            return "builtin", None, {"status": "failed", "message": error.message, **error.detail}
    if not results:
        return "builtin", None, {"status": "unavailable", "message": "no solid to analyze"}
    return "analysis_situs", results, {"status": "ran"}


def evaluate_geometry(ctx: Any, budget: Any) -> dict[str, Any] | None:
    session = ctx.session
    profile = get_profile(session)
    if profile is None:
        return None
    started = time.perf_counter()
    pack = load_rulepack(profile["rulepack"])
    facts = build_facts(session, pack, profile, budget)
    analyzer, asi, asi_status = _run_analyzer(facts, budget)
    facts["asi"] = asi
    issues: list[dict[str, Any]] = []
    coverage: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for rule in pack.rules:
        if "geometry" not in rule.layers:
            continue
        check = GEOMETRY_CHECKS.get(rule.check)
        if check is None:
            coverage.append(_coverage(rule, "skipped", "not_implemented"))
            continue
        if not facts["bodies"]:
            coverage.append(_coverage(rule, "skipped", "no_geometry"))
            continue
        if rule.check in NEEDS_ASI and asi is None:
            coverage.append(_coverage(rule, "skipped", "analysis_situs_unavailable"))
            continue
        if budget.expired():
            coverage.append(_coverage(rule, "skipped", "budget_exceeded"))
            continue
        facts["_skipped"] = []
        try:
            found = check(facts, rule, pack)
        except BudgetExceeded:
            coverage.append(_coverage(rule, "skipped", "budget_exceeded"))
            continue
        except Exception as error:  # noqa: BLE001 - a broken check must not fail the command; it is reported
            coverage.append(_coverage(rule, "skipped", "check_failed", detail=f"{type(error).__name__}: {error}"))
            continue
        if facts["_skipped"]:
            coverage.append(_coverage(rule, "skipped", facts["_skipped"][0]))
            continue
        coverage.append(_coverage(rule, "checked", "ok"))
        for issue in found:
            key = (issue["rule"], _key(issue["target"]))
            if key not in seen:
                seen.add(key)
                issues.append(issue)
    return {
        "issues": issues, "coverage": coverage, "analyzer": analyzer, "asi": asi_status,
        "elapsedMs": int((time.perf_counter() - started) * 1000),
    }


def _key(target: Any) -> str:
    return repr(sorted(target.items())) if isinstance(target, dict) else str(target)


def _differs(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        return abs(float(a) - float(b)) > _VALUE_TOL
    return False


def _mismatch(lint_issue: dict[str, Any], geometry_issue: dict[str, Any] | None) -> dict[str, Any]:
    lint_value = {"severity": lint_issue["severity"], "measured": lint_issue.get("measured")}
    geo_value = None if geometry_issue is None else {"severity": geometry_issue["severity"], "measured": geometry_issue.get("measured")}
    if geo_value is None:
        message = f"{lint_issue['rule']}: lint reports it, geometry does not"
    else:
        message = f"{lint_issue['rule']}: lint says {lint_value['severity']} ({lint_value['measured']}), geometry says {geo_value['severity']} ({geo_value['measured']})"
    issue = make_issue(MISMATCH_RULE, layer="geometry", target=lint_issue["target"], message=message,
                       hints=["the geometry value is used; check the feature the lint layer read"],
                       extra={"lint": lint_value, "geometry": geo_value, "checked_rule": lint_issue["rule"]})
    issue["rule"] = MISMATCH_RULE.id
    issue["source"] = "dfm merge (not in the rulepack)"
    return issue


def merge(lint_full: dict[str, Any] | None, geometry: dict[str, Any] | None) -> dict[str, Any]:
    """Lint and geometry as one list. A rule the geometry layer ran replaces the lint issues of that rule;
    where the two disagree (an issue on one side only, or a different severity or value) a
    ``dfm.layer_mismatch`` warning is added with both values."""
    lint_issues = lint_full["issues"] if lint_full else []
    lint_coverage = lint_full["coverage"] if lint_full else []
    geo_issues = geometry["issues"] if geometry else []
    geo_coverage = geometry["coverage"] if geometry else []
    ran = {c["rule"] for c in geo_coverage if c["status"] == "checked"}
    by_key = {(i["rule"], _key(i["target"])): i for i in geo_issues}
    kept: list[dict[str, Any]] = []
    mismatches: list[dict[str, Any]] = []
    for issue in lint_issues:
        if issue["rule"] not in ran:
            kept.append(issue)
            continue
        other = by_key.get((issue["rule"], _key(issue["target"])))
        if other is None:
            mismatches.append(_mismatch(issue, None))
        elif other["severity"] != issue["severity"] or _differs(other.get("measured"), issue.get("measured")):
            mismatches.append(_mismatch(issue, other))
    merged = kept + geo_issues + mismatches
    checked = {c["rule"] for c in lint_coverage + geo_coverage if c["status"] == "checked"}
    flagged = {i["rule"] for i in merged}
    return {"issues": merged, "coverage": lint_coverage + geo_coverage, "passes": len(checked - flagged)}


def _anchor(session: Any, target: Any) -> list[float] | None:
    if isinstance(target, dict):
        return list(target.get("centre") or []) or None
    best: tuple[float, Any] | None = None
    for unit in units(session):
        roles = unit.roles(session)
        if roles is None:
            continue
        for key, entries in roles.faces.items():
            if key.rpartition("/")[0] != target:
                continue
            for entry in entries:
                point, weight = label_anchor(entry.face)
                score = entry.face.Area * weight
                if best is None or score > best[0]:
                    best = (score, roles.point_to_world(point))
    if best is None:
        return None
    point = best[1]
    return [round(point.x, 4), round(point.y, 4), round(point.z, 4)]


def marks(session: Any, issues: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Highlight paths and annotations of the error and warning issues (the same shape ``session._annotations`` gives)."""
    paths: list[str] = []
    annotations: list[dict[str, Any]] = []
    seen: set[tuple[str, tuple[float, ...]]] = set()
    for issue in issues:
        if issue["severity"] not in ("error", "warn"):
            continue
        target = issue["target"]
        if isinstance(target, str) and target not in paths:
            paths.append(target)
        at = _anchor(session, target)
        if at is None:
            continue
        key = (issue["rule"], tuple(at))
        if key in seen:
            continue
        seen.add(key)
        annotations.append({"text": issue["rule"], "at": at})
    return {"paths": paths}, annotations[: summary.MAX_ANNOTATIONS]
