from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


@dataclass
class WorkPackage:
    authoritative: list[Path] = field(default_factory=list)
    current: list[Path] = field(default_factory=list)
    references: list[Path] = field(default_factory=list)
    editable: list[Path] = field(default_factory=list)


@dataclass
class PartWork:
    name: str
    specs: list[Any] = field(default_factory=list)
    references: list[Any] = field(default_factory=list)
    source: Path | None = None
    simulations: list[str] = field(default_factory=list)


@dataclass
class AssemblyWork:
    name: str = "assembly"
    parts: dict[str, Any] = field(default_factory=dict)
    interfaces: list[Any] = field(default_factory=list)
    checks: dict[str, Any] = field(default_factory=dict)


_REGISTRY: dict[str, tuple[Callable[..., Any], str]] = {
    "mechanical.work-package": (WorkPackage, "Organize authoritative, current, reference, and editable project material."),
    "mechanical.part-work": (PartWork, "Compact working structure for one mechanical part."),
    "mechanical.assembly-work": (AssemblyWork, "Compact working structure for assembly integration."),
}


def register(name: str, factory: Callable[..., Any], description: str = "") -> None:
    if not name or name in _REGISTRY:
        raise ValueError(f"duplicate or invalid template name: {name}")
    _REGISTRY[name] = (factory, description)


def load(name: str) -> Callable[..., Any]:
    try:
        return _REGISTRY[name][0]
    except KeyError as error:
        raise KeyError(f"unknown cad template: {name}") from error


def list() -> list[dict[str, str]]:  # noqa: A001 - public API mirrors the design
    return [{"name": name, "description": description} for name, (_, description) in sorted(_REGISTRY.items())]
