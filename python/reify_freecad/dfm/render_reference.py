"""Render a rulepack as a Markdown reference.

Usage: python -m reify_freecad.dfm.render_reference <rulepack_id>
"""

from __future__ import annotations

import sys
from typing import Any

from .rulepack import Rule, Rulepack, load_rulepack

_GROUP_ORDER = ("stock", "tol", "hole", "cavity", "corner", "floor", "outer", "wall", "edge", "twoside", "surface", "ganging")
_LAYER_LETTER = {"lint": "L", "geometry": "G"}


def render(rulepack_id: str) -> str:
    pack = load_rulepack(rulepack_id)
    lines: list[str] = []
    lines.append(f"# {pack.title} ({pack.id}) 规则参考")
    lines.append("")
    lines.append(_source_line(pack))
    lines.append("")
    lines.append(f"Process: `{pack.process.get('type')}`" + (f" — {pack.process['setup']}" if pack.process.get("setup") else ""))
    lines.append("")

    lines.append("## Materials")
    lines.append("")
    if pack.materials:
        lines.append("| Material | Density (g/cm³) | Size limited |")
        lines.append("|---|---|---|")
        for name, material in pack.materials.items():
            default = " (default)" if pack.defaults.get("material") == name else ""
            limited = "yes" if material.get("size_limited") else "no"
            lines.append(f"| `{name}`{default} | {material.get('density_g_cm3')} | {limited} |")
    else:
        lines.append("_None defined._")
    lines.append("")

    lines.append("## Tables")
    lines.append("")
    if pack.tables:
        for name, table in pack.tables.items():
            lines.append(f"### {name}")
            lines.append("")
            lines.append(_table_body(table))
            lines.append("")
    else:
        lines.append("_None defined._")
        lines.append("")

    lines.append("## Rules")
    lines.append("")
    if not pack.rules:
        lines.append("_No rules in this rulepack yet._")
        lines.append("")
    for group, rules in _grouped(pack):
        lines.append(f"### {group}")
        lines.append("")
        lines.append("| ID | Layers | Severity | Rule (quote) | Limits | Page | Inferred |")
        lines.append("|---|---|---|---|---|---|---|")
        for rule in rules:
            lines.append(_rule_row(rule))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _source_line(pack: Rulepack) -> str:
    doc = pack.source.get("doc", "")
    version = pack.source.get("version", "")
    date = pack.source.get("date")
    parts = [f"Source: {pack.vendor} `{doc}`, version {version}"]
    if date:
        parts.append(f"dated {date}")
    return ", ".join(parts) + "."


def _table_body(table: Any) -> str:
    if isinstance(table, dict):
        rows = ["| Key | Value |", "|---|---|"]
        rows += [f"| `{key}` | {value} |" for key, value in table.items()]
        return "\n".join(rows)
    rows = ["| Value |", "|---|"]
    rows += [f"| {value} |" for value in table]
    return "\n".join(rows)


def _grouped(pack: Rulepack) -> list[tuple[str, list[Rule]]]:
    buckets: dict[str, list[Rule]] = {}
    for rule in pack.rules:
        buckets.setdefault(rule.id.split(".", 1)[0], []).append(rule)
    ordered = [(name, buckets.pop(name)) for name in _GROUP_ORDER if name in buckets]
    ordered += [(name, buckets[name]) for name in sorted(buckets)]
    return ordered


def _rule_row(rule: Rule) -> str:
    layers = "+".join(_LAYER_LETTER.get(layer, layer) for layer in rule.layers)
    pages = rule.source.get("pages") or [rule.source.get("page")]
    page = ", ".join(str(p) for p in pages)
    inferred = "yes" if rule.source.get("inferred") else ""
    quote = str(rule.source.get("quote", "")).replace("|", "\\|")
    return (
        f"| `{rule.id}` | {layers} | {rule.severity} | {quote} | {_params(rule.params)} | {page} | {inferred} |"
    )


def _params(params: dict[str, Any]) -> str:
    if not params:
        return "—"
    return "<br>".join(f"{key}={_value(value)}" for key, value in params.items())


def _value(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ", ".join(str(v) for v in value) + "]"
    return str(value)


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python -m reify_freecad.dfm.render_reference <rulepack_id>", file=sys.stderr)
        return 2
    sys.stdout.write(render(argv[0]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
