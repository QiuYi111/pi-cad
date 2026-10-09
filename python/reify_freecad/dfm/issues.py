"""Issue and summary-block builders (pure Python, no FreeCAD)."""

from __future__ import annotations

import re
from typing import Any

from .rulepack import Rule, Rulepack

_SEVERITIES = ("error", "warn", "info")
_LAYERS = ("lint", "geometry")
_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def make_issue(
    rule: Rule,
    *,
    layer: str,
    target: Any,
    measured: Any = None,
    limit: Any = None,
    unit: str = "mm",
    severity: str | None = None,
    message: str | None = None,
    hints: list[str] | None = None,
    extra: dict[str, Any] | None = None,
    rulepack: Rulepack | None = None,
) -> dict[str, Any]:
    """Build one issue dict (see docs/dfm/contract.md, "Issue").

    `severity` defaults to the rule's severity. Inferred rules never produce `error`
    (capped to `warn`). `source` reads "<vendor> v<version> p.<page>" when `rulepack` is
    given, otherwise "p.<page>", with " (inferred)" appended for inferred rules.
    """
    if layer not in _LAYERS:
        raise ValueError(f"layer must be one of {_LAYERS}, got {layer!r}")
    if not (isinstance(target, str) or isinstance(target, dict)):
        raise ValueError("target must be a string or a dict")
    level = severity or rule.severity
    if level not in _SEVERITIES:
        raise ValueError(f"severity must be one of {_SEVERITIES}, got {level!r}")
    inferred = bool(rule.source.get("inferred", False))
    if inferred and level == "error":
        level = "warn"

    values = {"measured": measured, "limit": limit, "unit": unit}
    text_hint = _fill(rule.hint, values)
    if message is None:
        if measured is not None or limit is not None:
            message = f"{rule.id}: measured {measured} {unit}, limit {limit} {unit}"
        else:
            message = rule.id
    if hints is None:
        hints = [text_hint]

    page = f"p.{rule.source.get('page')}"
    if rulepack is not None:
        label = f"{rulepack.vendor} v{rulepack.source.get('version')} {page}"
    else:
        label = page
    if inferred:
        label += " (inferred)"

    issue: dict[str, Any] = {
        "rule": rule.id,
        "severity": level,
        "layer": layer,
        "target": target,
        "measured": measured,
        "limit": limit,
        "unit": unit,
        "message": message,
        "hints": list(hints),
        "source": label,
    }
    for key, value in (extra or {}).items():
        issue.setdefault(key, value)
    return issue


def summarize(issues: list[dict[str, Any]], passes: int, *, max_items: int = 8) -> dict[str, Any]:
    """Build the summary block fields `counts`, `issues`, `truncated`.

    `counts` covers all issues (info included) plus `pass`. `issues` holds only error and
    warn items, errors first, at most `max_items`. The caller adds rulepack, material,
    layer and geometry.
    """
    counts = {"error": 0, "warn": 0, "info": 0, "pass": int(passes)}
    for issue in issues:
        level = issue.get("severity")
        if level not in _SEVERITIES:
            raise ValueError(f"issue has invalid severity {level!r}")
        counts[level] += 1
    shown = [issue for issue in issues if issue["severity"] == "error"]
    shown += [issue for issue in issues if issue["severity"] == "warn"]
    truncated = len(shown) > max_items
    return {"counts": counts, "issues": shown[:max_items], "truncated": truncated}


def _fill(template: str, values: dict[str, Any]) -> str:
    """Replace {measured}, {limit}, {unit}; unknown or missing values stay as '?'."""

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in values or values[name] is None:
            return "?" if name in ("measured", "limit") else match.group(0)
        return str(values[name])

    return _PLACEHOLDER.sub(replace, template)
