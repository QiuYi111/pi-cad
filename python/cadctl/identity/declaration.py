"""Author-facing declaration API.

A model source may declare what its objects *mean* without changing how it
builds geometry.  Declaring is optional: a model that only exposes a
build123d ``Shape`` keeps building, and its artifact simply has no semantic
manifest.

    from cadctl.identity import Assembly

    identity = Assembly("hifi-arm")
    identity.instance("arm/forearm", part="forearm", label="前臂", shape=forearm)
    identity.feature(
        "arm/forearm/j3_bearing_seat",
        owner="arm/forearm",
        kind="bearing_seat",
        selector={"entity": "face", "type": "cylinder", "radius": 6.0},
    )
    identity.axis("arm/j3/axis", owner="arm", origin=(0, 0, 0), direction=(0, 1, 0))

Selectors describe how to find the object again in the exported STEP; they are
not inferred from the shape.  A declaration whose selector does not match final
geometry fails the build instead of binding to the wrong thing.
"""

from __future__ import annotations

import math
from typing import Any

from .protocol import (
    COORDINATE_SPACES,
    IDENTITY_SUFFIX,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    IdentityError,
    canonicalize_path,
)
from .selectors import normalize as normalize_selector

_current: "Assembly | None" = None


def reset() -> None:
    """Forget the assembly declared by the previous model execution."""
    global _current
    _current = None


def current() -> "Assembly | None":
    """Assembly declared by the model currently being executed, if any."""
    return _current


def _point(value: Any, key: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise IdentityError("bad-declaration", f"'{key}' needs three coordinates", key=key)
    try:
        return [float(value[0]), float(value[1]), float(value[2])]
    except (TypeError, ValueError) as error:
        raise IdentityError("bad-declaration", f"'{key}' is not numeric: {value}", key=key) from error


def _unit(value: list[float], key: str) -> list[float]:
    length = math.sqrt(sum(component * component for component in value))
    if length <= 1e-12:
        raise IdentityError("bad-declaration", f"'{key}' must be a non-zero direction", key=key)
    return [round(component / length, 12) for component in value]


def _display(label: str | None, display: dict[str, str] | None) -> dict[str, str] | None:
    merged: dict[str, str] = {}
    if display:
        for key, value in display.items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise IdentityError("bad-declaration", "display names must map language tags to strings")
            merged[key] = value
    if label is not None:
        if not isinstance(label, str) or not label:
            raise IdentityError("bad-declaration", "label must be a non-empty string")
        merged.setdefault("zh", label)
    return merged or None


def _expectation(value: Any, *, default: int | str) -> dict[str, Any]:
    value = default if value is None else value
    if isinstance(value, bool):
        raise IdentityError("bad-declaration", "cardinality cannot be a boolean")
    if value == "none":
        return {"min": 0, "max": 0, "label": "none"}
    if isinstance(value, int):
        if value < 0:
            raise IdentityError("bad-declaration", f"cardinality must not be negative; got {value}")
        return {"min": value, "max": value, "label": str(value)}
    if value == "one":
        return {"min": 1, "max": 1, "label": "one"}
    if value == "many":
        return {"min": 1, "max": None, "label": "many"}
    if isinstance(value, dict):
        low = int(value.get("min", 0))
        high = value.get("max")
        return {
            "min": low,
            "max": None if high is None else int(high),
            "label": f"{low}..{high if high is not None else 'n'}",
        }
    raise IdentityError(
        "bad-declaration",
        f"cardinality must be an integer, 'one', 'many', or {{min,max}}; got {value!r}",
    )


def _shape_selector(shape: Any, tolerance: float) -> dict[str, Any]:
    box = shape.bounding_box()
    selector: dict[str, Any] = {"entity": "solid"}
    if len(shape.solids()) == 1:
        selector.update(
            {
                "bounds": [
                    [float(box.min.X), float(box.min.Y), float(box.min.Z)],
                    [float(box.max.X), float(box.max.Y), float(box.max.Z)],
                ],
                "volume": float(shape.volume),
            }
        )
    else:
        selector["members"] = []
        for solid in shape.solids():
            solid_box = solid.bounding_box()
            selector["members"].append(
                {
                    "bounds": [
                        [float(solid_box.min.X), float(solid_box.min.Y), float(solid_box.min.Z)],
                        [float(solid_box.max.X), float(solid_box.max.Y), float(solid_box.max.Z)],
                    ],
                    "volume": float(solid.volume),
                }
            )
    selector["tolerance"] = tolerance
    return selector


class Assembly:
    """One declared naming protocol attached to one built artifact."""

    def __init__(self, name: str | None = None, *, label: str | None = None, version: int = PROTOCOL_VERSION) -> None:
        global _current
        if _current is not None:
            raise IdentityError(
                "duplicate-assembly",
                "one model execution may declare only one Assembly",
            )
        if version != PROTOCOL_VERSION:
            raise IdentityError(
                "unsupported-version",
                f"identity protocol version {version} is not supported; this build speaks {PROTOCOL_VERSION}",
            )
        _current = self
        self.version = version
        self.name = canonicalize_path(name) if name else None
        self.entities: list[dict[str, Any]] = []
        self._by_path: dict[str, dict[str, Any]] = {}
        if self.name:
            self._add(
                {
                    "path": self.name,
                    "kind": "assembly",
                    "label": label,
                    "display": _display(label, None),
                }
            )

    # -- internals -------------------------------------------------------

    def _add(self, record: dict[str, Any]) -> dict[str, Any]:
        path = record["path"]
        if path in self._by_path:
            raise IdentityError(
                "duplicate-path",
                f"path '{path}' is declared twice; every semantic path is unique",
                path=path,
            )
        record.setdefault("label", None)
        record.setdefault("display", None)
        record.setdefault("owner", None)
        record.setdefault("part", None)
        record.setdefault("selector", None)
        record.setdefault("expect", None)
        record.setdefault("coordinate", "world")
        record.setdefault("origin", None)
        record.setdefault("direction", None)
        record.setdefault("axes", None)
        record.setdefault("featureKind", None)
        record.setdefault("shapeVolume", None)
        self._by_path[path] = record
        self.entities.append(record)
        return record

    def _prepare(
        self,
        path: str,
        *,
        kind: str,
        owner: str | None,
        shape: Any,
        selector: dict[str, Any] | None,
        expect: Any,
        default_expect: int | str,
        coordinate: str,
    ) -> dict[str, Any]:
        canonical = canonicalize_path(path)
        if canonical in self._by_path:
            raise IdentityError(
                "duplicate-path",
                f"path '{canonical}' is declared twice; every semantic path is unique",
                path=canonical,
            )
        if coordinate not in COORDINATE_SPACES:
            raise IdentityError(
                "bad-declaration",
                f"coordinate must be one of {COORDINATE_SPACES}; got {coordinate!r}",
            )
        owner_path = canonicalize_path(owner) if owner else None
        if owner_path == canonical:
            raise IdentityError("bad-declaration", f"'{canonical}' cannot own itself")
        if shape is not None and selector is not None:
            raise IdentityError(
                "bad-declaration",
                f"'{canonical}' declares both shape= and selector=; give one",
            )
        resolved_expect = expect
        if shape is not None:
            selector = _shape_selector(shape, 1e-6)
            solids = len(list(shape.solids()))
            if resolved_expect is None:
                resolved_expect = max(solids, 1)
                default_expect = resolved_expect
        if selector is not None:
            selector = normalize_selector(selector)
        return {
            "path": canonical,
            "kind": kind,
            "owner": owner_path,
            "selector": selector,
            "expect": _expectation(resolved_expect, default=default_expect),
            "coordinate": coordinate,
            "shapeVolume": round(float(shape.volume), 9) if shape is not None else None,
        }

    # -- declarations ----------------------------------------------------

    def part(
        self,
        path: str,
        *,
        label: str | None = None,
        display: dict[str, str] | None = None,
        shape: Any = None,
        selector: dict[str, Any] | None = None,
        expect: Any = None,
        owner: str | None = None,
        coordinate: str = "world",
    ) -> dict[str, Any]:
        record = self._prepare(
            path,
            kind="part",
            owner=owner,
            shape=shape,
            selector=selector,
            expect=expect,
            default_expect=1,
            coordinate=coordinate,
        )
        record["label"] = label
        record["display"] = _display(label, display)
        return self._add(record)

    def instance(
        self,
        path: str,
        *,
        part: str | None = None,
        label: str | None = None,
        display: dict[str, str] | None = None,
        shape: Any = None,
        selector: dict[str, Any] | None = None,
        expect: Any = None,
        coordinate: str = "world",
    ) -> dict[str, Any]:
        record = self._prepare(
            path,
            kind="instance",
            owner=None,
            shape=shape,
            selector=selector,
            expect=expect,
            default_expect=1,
            coordinate=coordinate,
        )
        record["label"] = label
        record["display"] = _display(label, display)
        record["part"] = canonicalize_path(part) if part else None
        return self._add(record)

    def solid(
        self,
        path: str,
        *,
        owner: str | None = None,
        label: str | None = None,
        display: dict[str, str] | None = None,
        shape: Any = None,
        selector: dict[str, Any] | None = None,
        expect: Any = None,
        coordinate: str = "world",
    ) -> dict[str, Any]:
        record = self._prepare(
            path,
            kind="solid",
            owner=owner,
            shape=shape,
            selector=selector,
            expect=expect,
            default_expect=1,
            coordinate=coordinate,
        )
        record["label"] = label
        record["display"] = _display(label, display)
        return self._add(record)

    def feature(
        self,
        path: str,
        *,
        kind: str,
        owner: str | None = None,
        label: str | None = None,
        display: dict[str, str] | None = None,
        shape: Any = None,
        selector: dict[str, Any] | None = None,
        expect: Any = None,
        coordinate: str = "world",
    ) -> dict[str, Any]:
        if not isinstance(kind, str) or not kind.strip():
            raise IdentityError("bad-declaration", f"'{path}' needs a non-empty engineering kind")
        record = self._prepare(
            path,
            kind="feature",
            owner=owner,
            shape=shape,
            selector=selector,
            expect=expect,
            default_expect=1,
            coordinate=coordinate,
        )
        record["label"] = label
        record["display"] = _display(label, display)
        record["featureKind"] = kind.strip()
        record["target"] = (record["selector"] or {}).get("entity")
        return self._add(record)

    def faces(
        self,
        path: str,
        *,
        selector: dict[str, Any],
        owner: str | None = None,
        label: str | None = None,
        display: dict[str, str] | None = None,
        expect: Any = None,
        coordinate: str = "world",
    ) -> dict[str, Any]:
        record = self._prepare(
            path,
            kind="faces",
            owner=owner,
            shape=None,
            selector={**selector, "entity": "face"},
            expect=expect,
            default_expect="many",
            coordinate=coordinate,
        )
        record["label"] = label
        record["display"] = _display(label, display)
        return self._add(record)

    def edges(
        self,
        path: str,
        *,
        selector: dict[str, Any],
        owner: str | None = None,
        label: str | None = None,
        display: dict[str, str] | None = None,
        expect: Any = None,
        coordinate: str = "world",
    ) -> dict[str, Any]:
        record = self._prepare(
            path,
            kind="edges",
            owner=owner,
            shape=None,
            selector={**selector, "entity": "edge"},
            expect=expect,
            default_expect="many",
            coordinate=coordinate,
        )
        record["label"] = label
        record["display"] = _display(label, display)
        return self._add(record)

    def axis(
        self,
        path: str,
        *,
        origin: Any,
        direction: Any,
        owner: str | None = None,
        label: str | None = None,
        display: dict[str, str] | None = None,
        coordinate: str = "world",
    ) -> dict[str, Any]:
        record = self._prepare(
            path,
            kind="axis",
            owner=owner,
            shape=None,
            selector=None,
            expect=None,
            default_expect="none",
            coordinate=coordinate,
        )
        record.update(
            label=label,
            display=_display(label, display),
            origin=_point(origin, "origin"),
            direction=_unit(_point(direction, "direction"), "direction"),
        )
        return self._add(record)

    def datum(
        self,
        path: str,
        *,
        origin: Any,
        zAxis: Any = None,
        xAxis: Any = None,
        yAxis: Any = None,
        owner: str | None = None,
        label: str | None = None,
        display: dict[str, str] | None = None,
        coordinate: str = "world",
    ) -> dict[str, Any]:
        axes = {
            key: _unit(_point(value, key), key)
            for key, value in (("x", xAxis), ("y", yAxis), ("z", zAxis))
            if value is not None
        }
        record = self._prepare(
            path,
            kind="datum",
            owner=owner,
            shape=None,
            selector=None,
            expect=None,
            default_expect="none",
            coordinate=coordinate,
        )
        record.update(
            label=label,
            display=_display(label, display),
            origin=_point(origin, "origin"),
            axes=axes or None,
        )
        return self._add(record)


__all__ = [
    "Assembly",
    "IDENTITY_SUFFIX",
    "PROTOCOL_NAME",
    "PROTOCOL_VERSION",
    "current",
    "reset",
]
