"""First layer: runs the lint rules of the document's rulepack (imports FreeCAD via extract).

``evaluate`` gives the summary block of an apply result; ``evaluate_full`` gives every issue
(info included) and the coverage of every lint rule. Both return None when no DFM profile is set.
"""

from __future__ import annotations

import json
import time
from typing import Any

from .extract import extract_facts
from .issues import summarize
from .lint_checks import LINT_CHECKS
from .profile import get_profile
from .rulepack import load_rulepack

#: Whole-part and requirement-only checks: they run even when the body has no feature tree.
_NO_FEATURE_TREE_NEEDED = frozenset({
    "stock_size_range", "stock_size_limited_material", "stock_thickness_range", "stock_standard_thickness",
    "stock_thin_plate_large", "stock_removal_ratio", "stock_surface_treatment", "tol_general",
})
BUDGET_S = 0.050


def _coverage(rule_id: str, status: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {"rule": rule_id, "layer": "lint", "status": status, "reason": reason, **extra}


def evaluate_full(ctx: Any) -> dict[str, Any] | None:
    profile = get_profile(ctx.session)
    if profile is None:
        return None
    started = time.perf_counter()
    pack = load_rulepack(profile["rulepack"])
    facts = extract_facts(ctx)
    issues: list[dict[str, Any]] = []
    coverage: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    passes = 0
    truncated = False
    for rule in pack.rules:
        if "lint" not in rule.layers:
            continue
        check = LINT_CHECKS.get(rule.check)
        if check is None:
            coverage.append(_coverage(rule.id, "skipped", "not_implemented"))
            continue
        if time.perf_counter() - started > BUDGET_S:
            truncated = True
            coverage.append(_coverage(rule.id, "skipped", "budget_exceeded"))
            continue
        if facts["bbox"] is None:
            coverage.append(_coverage(rule.id, "skipped", "no_geometry"))
            continue
        needs_features = rule.check not in _NO_FEATURE_TREE_NEEDED
        if needs_features and not facts["has_feature_tree"]:
            coverage.append(_coverage(rule.id, "skipped", "no_feature_tree"))
            continue
        if needs_features and facts["unreadable"]:
            coverage.append(_coverage(rule.id, "skipped", "unreadable_feature", detail=[u["path"] for u in facts["unreadable"]]))
            continue
        try:
            found = check(facts, rule, pack)
        except Exception as error:  # noqa: BLE001 - a broken check must not fail the apply; it is reported
            facts.pop("_skipped", None)
            coverage.append(_coverage(rule.id, "skipped", "check_failed", detail=f"{type(error).__name__}: {error}"))
            continue
        skipped = facts.pop("_skipped", [])
        kept = 0
        for issue in found:
            key = (issue["rule"], json.dumps(issue["target"], sort_keys=True))
            if key in seen:
                continue
            seen.add(key)
            issues.append(issue)
            kept += 1
        if skipped:
            coverage.append(_coverage(rule.id, "skipped", skipped[0]))
        else:
            coverage.append(_coverage(rule.id, "checked", "ok"))
            if kept == 0:
                passes += 1
    return {"issues": issues, "coverage": coverage, "passes": passes, "truncated": truncated, "profile": profile}


def evaluate(ctx: Any) -> dict[str, Any] | None:
    full = evaluate_full(ctx)
    if full is None:
        return None
    shown = summarize(full["issues"], full["passes"])
    profile = full["profile"]
    return {
        "rulepack": profile["rulepack"], "material": profile["material"], "layer": "lint",
        "counts": shown["counts"], "issues": shown["issues"], "truncated": full["truncated"],
        "geometry": {"state": "none", "last_rev": None},
    }
