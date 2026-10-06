"""Semantic path validation, identical to ``cadctl.identity.protocol`` (pure Python).

The two implementations are tested against the same vectors in
``tests/fixtures/identity-paths.json``.
"""

from __future__ import annotations

import unicodedata

from .errors import ReifyOpError

_RESERVED = {"/": "%2F", "%": "%25"}
_UNRESERVED_HEX = {"2F": "/", "25": "%"}
_HEX_DIGITS = set("0123456789abcdefABCDEF")

#: Role names a feature reserves under its own path. A feature's last path
#: segment may not equal one of them, because ``<feature>/<role>`` would then
#: be ambiguous with a sibling.
ROLE_NAMES = frozenset({
    "top", "bottom", "side", "floor", "wall", "rim", "round", "bevel", "top_outer",
    "counterbore_floor", "counterbore_wall", "countersink",
})


class PathError(ValueError):
    def __init__(self, message: str, segment: str = "") -> None:
        super().__init__(message)
        self.segment = segment


def _unescape(raw: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(raw):
        char = raw[index]
        if char != "%":
            out.append(char)
            index += 1
            continue
        escape = raw[index + 1:index + 3]
        if len(escape) != 2 or any(d not in _HEX_DIGITS for d in escape):
            raise PathError(f"'{raw}' has a '%' that is not the escape '%25'", raw)
        decoded = _UNRESERVED_HEX.get(escape.upper())
        if decoded is None:
            raise PathError(f"'{raw}' uses the reserved escape '%{escape}'", raw)
        out.append(decoded)
        index += 3
    return "".join(out)


def _validate_segment(text: str, raw: str) -> str:
    if not text:
        raise PathError(f"'{raw}' is an empty path segment", raw)
    if any(unicodedata.category(char).startswith("C") for char in text):
        raise PathError(f"'{raw}' contains a control character", raw)
    if text in (".", ".."):
        raise PathError(f"'{raw}' is the reserved segment '{text}'", raw)
    if text != text.strip():
        raise PathError(f"'{raw}' has leading or trailing whitespace", raw)
    if text.isascii() and text.isdigit():
        raise PathError(f"'{raw}' is a bare number; name the object instead", raw)
    return unicodedata.normalize("NFC", text)


def _escape(text: str) -> str:
    return "".join(_RESERVED.get(char, char) for char in text)


def decode_segment(raw: str) -> str:
    return _validate_segment(_unescape(raw), raw)


def encode_segment(text: str) -> str:
    return _escape(_validate_segment(text, text))


def canonicalize_segment(raw: str) -> str:
    return encode_segment(decode_segment(raw))


def canonicalize_path(path: str) -> str:
    if not isinstance(path, str) or not path:
        raise PathError(f"'{path}' is not a non-empty path string")
    return "/".join(canonicalize_segment(segment) for segment in path.split("/"))


def split_path(path: str) -> list[str]:
    return canonicalize_path(path).split("/")


def parent_path(path: str) -> str | None:
    segments = canonicalize_path(path).split("/")
    return "/".join(segments[:-1]) if len(segments) > 1 else None


def checked_path(path: object, *, op_index: int | None = None, field: str = "name") -> str:
    """Canonical path, or an ``OP_SCHEMA_INVALID`` error naming the field."""
    try:
        return canonicalize_path(path)  # type: ignore[arg-type]
    except PathError as error:
        raise ReifyOpError(
            "OP_SCHEMA_INVALID",
            f"{field}: {error}",
            detail={"opIndex": op_index, "path": field, "reason": str(error)},
        ) from error


def check_not_role_name(path: str) -> None:
    last = path.split("/")[-1]
    if last in ROLE_NAMES or last.split(".")[0] in {"side", "wall"}:
        raise ReifyOpError(
            "NAME_CONFLICT",
            f"'{last}' is a reserved face role name and cannot end a feature path",
            target=path,
            hints=["rename the feature"],
        )
