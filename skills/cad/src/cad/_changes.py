from __future__ import annotations

"""Short text form of a build's change summary (``BuildChanges`` from the sidecar)."""

from typing import Any

MAX_LINES = 6


def _signed(value: float) -> str:
    text = f"{value:g}"
    return f"+{text}" if value > 0 else text


def describe_changes(changes: dict[str, Any] | None, highlighted: bool = False) -> list[str]:
    """At most six lines that say what this build changed against the previous one."""
    if not changes:
        return []
    if not changes.get("baseline"):
        return ["First build of this output: there is no previous build to compare."]
    parts: list[str] = []
    volume = (changes.get("volumeMm3") or {}).get("delta")
    if volume is not None:
        parts.append("volume unchanged" if volume == 0 else f"volume {_signed(volume)} mm³")
    faces = changes.get("faces") or {}
    if faces.get("new") is not None and faces.get("removed") is not None:
        parts.append(f"faces +{faces['new']}/-{faces['removed']}")
    bbox = changes.get("bboxMm") or {}
    if bbox.get("changed"):
        before = "×".join(f"{v:g}" for v in bbox.get("before") or [])
        after = "×".join(f"{v:g}" for v in bbox.get("after") or [])
        parts.append(f"bbox {before} → {after} mm")
    else:
        parts.append("bbox unchanged")
    lines = [f"Changes since previous build: {'; '.join(parts)}."]

    recomputed = (changes.get("features") or {}).get("recomputed") or []
    params = [
        f"{name} {pair[0]}→{pair[1]}"
        for name, pair in ((changes.get("params") or {}).get("changed") or {}).items()
    ]
    detail = []
    if recomputed:
        detail.append(f"Recomputed: {', '.join(recomputed[:6])}{', …' if len(recomputed) > 6 else ''}.")
    if params:
        detail.append(f"Params: {', '.join(params[:6])}.")
    if detail:
        lines.append(" ".join(detail))
    if highlighted:
        lines.append("Highlighted in orange: faces changed by this build.")
    for item in (changes.get("intent") or [])[:2]:
        value = ""
        if item.get("value") is not None:
            limit = f" vs {item['limit']}" if item.get("limit") is not None else ""
            value = f" ({item['value']}{limit})"
        lines.append(f"Intent: {item.get('path')} {item.get('status')}{value}.")
    warnings = changes.get("warnings") or []
    if warnings:
        lines.append("Warnings: " + "; ".join(f"{w.get('code')} {w.get('target') or ''}".strip() for w in warnings[:3]) + ".")
    return lines[:MAX_LINES]
