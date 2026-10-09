"""Rulepack loading and validation (pure Python: stdlib and yaml, no FreeCAD)."""

from __future__ import annotations

import functools
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from ..errors import ReifyOpError

SCHEMA_ID = "reify.dfm.rulepack/1"
PACK_DIR = Path(__file__).resolve().parent / "rulepacks"
#: Folders searched before PACK_DIR, separated by os.pathsep. A pack in one of them with the same id wins.
SEARCH_ENV = "PI_CAD_DFM_RULEPACK_PATH"

_LAYERS = frozenset({"lint", "geometry"})
_SEVERITIES = frozenset({"error", "warn", "info"})
_REQUIRED_TOP = ("schema", "id", "title", "vendor", "source", "process", "materials", "defaults", "tables", "rules")
_REQUIRED_RULE = ("id", "check", "layers", "severity", "params", "source", "hint")
_RULE_ID = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$")
_CHECK = re.compile(r"^[a-z][a-z0-9_]*$")


@dataclass
class Rule:
    id: str
    check: str
    layers: tuple[str, ...]
    severity: str
    params: dict[str, Any]
    source: dict[str, Any]
    hint: str


@dataclass
class Rulepack:
    id: str
    title: str
    vendor: str
    source: dict[str, Any]
    process: dict[str, Any]
    materials: dict[str, dict[str, Any]]
    defaults: dict[str, Any]
    tables: dict[str, Any]
    rules: list[Rule] = field(default_factory=list)


_seen_search: tuple[str, Path] | None = None  # (environment value, built-in folder) the cache was filled for


def search_path() -> tuple[Path, ...]:
    """Folders searched for ``<id>.yaml``: those in ``PI_CAD_DFM_RULEPACK_PATH``, then the built-in folder.

    When the environment value or the built-in folder changes, the cached packs are dropped.
    """
    global _seen_search
    raw = os.environ.get(SEARCH_ENV, "")
    key = (raw, PACK_DIR)
    if key != _seen_search:
        _load.cache_clear()
        _seen_search = key
    folders = [Path(part) for part in raw.split(os.pathsep) if part.strip()]
    return (*folders, PACK_DIR)


def available_rulepacks() -> list[str]:
    """Ids of the rulepacks found in the search path (file stem is the id), sorted."""
    ids: set[str] = set()
    for folder in search_path():
        if folder.is_dir():
            ids.update(path.name[: -len(".yaml")] for path in folder.glob("*.yaml"))
    return sorted(ids)


def load_rulepack(rulepack_id: str) -> Rulepack:
    """Load and validate a rulepack from the search path (the first folder that has it). Cached per process."""
    if not isinstance(rulepack_id, str) or rulepack_id not in available_rulepacks():
        raise ReifyOpError(
            "DFM_RULEPACK_UNKNOWN",
            f"unknown rulepack {rulepack_id!r}",
            target=str(rulepack_id),
            hints=available_rulepacks(),
        )
    for folder in search_path():
        path = folder / f"{rulepack_id}.yaml"
        if path.is_file():
            return _load(str(path), rulepack_id)
    raise ReifyOpError("DFM_RULEPACK_UNKNOWN", f"unknown rulepack {rulepack_id!r}", target=str(rulepack_id), hints=available_rulepacks())


@functools.lru_cache(maxsize=None)
def _load(path_text: str, rulepack_id: str) -> Rulepack:
    path = Path(path_text)
    try:
        # libyaml's loader: about 10x faster than the pure one, which would eat the lint budget on first use
        with path.open(encoding="utf-8") as handle:
            data = yaml.load(handle, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))
    except (OSError, yaml.YAMLError) as error:
        raise _invalid(path, f"cannot parse YAML: {error}") from error
    return validate_rulepack(data, path=path, expected_id=rulepack_id)


def validate_rulepack(data: Any, *, path: Path | str = "<memory>", expected_id: str | None = None) -> Rulepack:
    """Validate parsed rulepack data and build a Rulepack. Raises DFM_RULEPACK_INVALID."""
    path = Path(path)

    def fail(reason: str) -> ReifyOpError:
        return _invalid(path, reason)

    if not isinstance(data, dict):
        raise fail("top level must be a mapping")
    for key in _REQUIRED_TOP:
        if key not in data:
            raise fail(f"missing key {key!r}")
    if data["schema"] != SCHEMA_ID:
        raise fail(f"schema must be {SCHEMA_ID!r}, got {data['schema']!r}")

    rulepack_id = _nonempty_str(data["id"], "id", fail)
    if expected_id is not None and rulepack_id != expected_id:
        raise fail(f"id {rulepack_id!r} does not match file name {expected_id!r}")
    title = _nonempty_str(data["title"], "title", fail)
    vendor = _nonempty_str(data["vendor"], "vendor", fail)

    source = _mapping(data["source"], "source", fail)
    _nonempty_str(source.get("doc"), "source.doc", fail)
    if not isinstance(source.get("version"), str) or not source["version"]:
        raise fail("source.version must be a non-empty string (quote it in YAML, e.g. \"8.14\")")

    process = _mapping(data["process"], "process", fail)
    _nonempty_str(process.get("type"), "process.type", fail)

    materials = _mapping(data["materials"], "materials", fail)
    for name, material in materials.items():
        where = f"materials.{name}"
        material = _mapping(material, where, fail)
        density = material.get("density_g_cm3")
        if not _is_number(density) or density <= 0:
            raise fail(f"{where}.density_g_cm3 must be a positive number")
        if not isinstance(material.get("size_limited"), bool):
            raise fail(f"{where}.size_limited must be true or false")

    defaults = _mapping(data["defaults"], "defaults", fail)
    if "material" in defaults and defaults["material"] not in materials:
        raise fail(f"defaults.material {defaults['material']!r} is not in materials")

    tables = _mapping(data["tables"], "tables", fail)
    for name, table in tables.items():
        if not isinstance(table, (dict, list)):
            raise fail(f"tables.{name} must be a mapping or a list")
        values = table.values() if isinstance(table, dict) else table
        if not all(_is_number(value) for value in values):
            raise fail(f"tables.{name} must contain only numbers")

    rules_raw = data["rules"]
    if not isinstance(rules_raw, list):
        raise fail("rules must be a list")
    rules: list[Rule] = []
    seen: set[str] = set()
    for index, raw in enumerate(rules_raw):
        where = f"rules[{index}]"
        rule = _rule(raw, where, fail)
        if rule.id in seen:
            raise fail(f"duplicate rule id {rule.id!r}")
        seen.add(rule.id)
        rules.append(rule)

    return Rulepack(
        id=rulepack_id,
        title=title,
        vendor=vendor,
        source=source,
        process=process,
        materials=materials,
        defaults=defaults,
        tables=tables,
        rules=rules,
    )


def _rule(raw: Any, where: str, fail: Any) -> Rule:
    rule = _mapping(raw, where, fail)
    for key in _REQUIRED_RULE:
        if key not in rule:
            raise fail(f"{where}: missing key {key!r}")
    rule_id = rule["id"]
    if not isinstance(rule_id, str) or not _RULE_ID.match(rule_id):
        raise fail(f"{where}: id {rule_id!r} must look like 'area.name'")
    if not isinstance(rule["check"], str) or not _CHECK.match(rule["check"]):
        raise fail(f"{rule_id}: check must be a snake_case function name")

    layers = rule["layers"]
    if not isinstance(layers, list) or not layers:
        raise fail(f"{rule_id}: layers must be a non-empty list")
    for layer in layers:
        if layer not in _LAYERS:
            raise fail(f"{rule_id}: layer {layer!r} is not one of lint, geometry")
    if len(set(layers)) != len(layers):
        raise fail(f"{rule_id}: layers must not repeat")

    severity = rule["severity"]
    if severity not in _SEVERITIES:
        raise fail(f"{rule_id}: severity {severity!r} is not one of error, warn, info")

    params = _mapping(rule["params"], f"{rule_id}.params", fail)

    source = _mapping(rule["source"], f"{rule_id}.source", fail)
    page = source.get("page")
    if not isinstance(page, int) or isinstance(page, bool):
        raise fail(f"{rule_id}: source.page must be an integer")
    _nonempty_str(source.get("quote"), f"{rule_id}.source.quote", fail)
    if "pages" in source:
        pages = source["pages"]
        if not isinstance(pages, list) or not all(isinstance(p, int) and not isinstance(p, bool) for p in pages):
            raise fail(f"{rule_id}: source.pages must be a list of integers")
    inferred = source.get("inferred", False)
    if not isinstance(inferred, bool):
        raise fail(f"{rule_id}: source.inferred must be true or false")
    if inferred and severity == "error":
        raise fail(f"{rule_id}: inferred rules cannot have severity error")

    hint = _nonempty_str(rule["hint"], f"{rule_id}.hint", fail)
    return Rule(
        id=rule_id,
        check=rule["check"],
        layers=tuple(layers),
        severity=severity,
        params=params,
        source=source,
        hint=hint,
    )


def _invalid(path: Path, reason: str) -> ReifyOpError:
    return ReifyOpError(
        "DFM_RULEPACK_INVALID",
        f"rulepack {path.name} is invalid: {reason}",
        target=path.name,
        detail={"path": str(path), "reason": reason},
    )


def _mapping(value: Any, where: str, fail: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise fail(f"{where} must be a mapping")
    return value


def _nonempty_str(value: Any, where: str, fail: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise fail(f"{where} must be a non-empty string")
    return value


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
