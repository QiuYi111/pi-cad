"""Structured errors returned to the Agent (pure Python)."""

from __future__ import annotations

from typing import Any

ERROR_CODES = frozenset({
    "FREECAD_NOT_INSTALLED", "FREECAD_WORKER_RESTARTED", "OP_SCHEMA_INVALID", "TARGET_NOT_FOUND",
    "TARGET_AMBIGUOUS", "NAME_CONFLICT", "HAS_DEPENDENTS", "PROP_NOT_ALLOWED", "EXPRESSION_INVALID",
    "SKETCH_CONFLICTING", "SKETCH_REDUNDANT", "SKETCH_MALFORMED", "SKETCH_PROFILE_NOT_CLOSED",
    "FEATURE_FAILED", "BOOLEAN_FAILED", "FILLET_FAILED", "CHAMFER_FAILED", "PATTERN_FAILED", "HOLE_FAILED",
    "RESULT_NOT_SOLID", "RESULT_MULTIPLE_SOLIDS", "IDENTITY_BIND_FAILED",
    "BUDGET_EXCEEDED", "BUDGET_EXCEEDS_LIMIT", "CANCELLED",
    "DOCUMENT_NOT_OPEN", "NOTHING_TO_UNDO", "BAD_REQUEST", "INTERNAL_ERROR",
})


class ReifyOpError(Exception):
    """An operation failed in a way the Agent can act on."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        target: str | None = None,
        detail: dict[str, Any] | None = None,
        hints: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        if code not in ERROR_CODES:
            raise ValueError(f"unknown error code {code}")
        self.code = code
        self.message = message
        self.target = target
        self.detail = detail or {}
        self.hints = hints or []
        self.rolled_back = False
        self.failed_op_index: int | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {"code": self.code, "message": self.message, "rolledBack": self.rolled_back}
        if self.target is not None:
            wire["target"] = self.target
        detail = dict(self.detail)
        if self.failed_op_index is not None:
            detail["failedOpIndex"] = self.failed_op_index
        if detail:
            wire["detail"] = detail
        if self.hints:
            wire["hints"] = self.hints
        return wire


# FreeCAD feature TypeId -> error code for a failed recompute of that feature.
_FEATURE_FAILURE = {
    "PartDesign::Fillet": "FILLET_FAILED",
    "PartDesign::Chamfer": "CHAMFER_FAILED",
    "PartDesign::Hole": "HOLE_FAILED",
    "PartDesign::LinearPattern": "PATTERN_FAILED",
    "PartDesign::PolarPattern": "PATTERN_FAILED",
    "PartDesign::Mirrored": "PATTERN_FAILED",
    "PartDesign::MultiTransform": "PATTERN_FAILED",
}

_FEATURE_HINTS = {
    "EXPRESSION_INVALID": ["write units in expressions, for example =width - 3 mm", "a parameter without unit is a plain number"],
    "FILLET_FAILED": ["reduce radius", "fillet before pocket"],
    "CHAMFER_FAILED": ["reduce size", "chamfer before pocket"],
    "HOLE_FAILED": ["check the diameter and depth", "the hole sketch must lie on a face"],
    "PATTERN_FAILED": ["check count and length", "the instances must overlap the base solid"],
    "BOOLEAN_FAILED": ["check the sketch overlaps the solid", "check the depth"],
}

_BOOLEAN_WORDS = ("boolean", "cut out of base", "fusion", "fuse", "result has multiple solids", "common")
_OPEN_PROFILE_WORDS = ("not closed", "open wire", "wire is not closed", "no wire", "sketch with")


def failure_code(feature_type: str, status: str) -> str:
    """Map a failed feature (TypeId plus FreeCAD status text) to an error code."""
    text = (status or "").lower()
    if "unit mismatch" in text or "in expression:" in text:
        return "EXPRESSION_INVALID"
    if any(word in text for word in _OPEN_PROFILE_WORDS) and feature_type in {"PartDesign::Pad", "PartDesign::Pocket", "PartDesign::Hole"}:
        return "SKETCH_PROFILE_NOT_CLOSED"
    if feature_type in _FEATURE_FAILURE:
        return _FEATURE_FAILURE[feature_type]
    if any(word in text for word in _BOOLEAN_WORDS):
        return "BOOLEAN_FAILED"
    return "FEATURE_FAILED"


def hints_for(code: str) -> list[str]:
    return list(_FEATURE_HINTS.get(code, []))
