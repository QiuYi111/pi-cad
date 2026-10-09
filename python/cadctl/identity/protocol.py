"""Reify identity protocol v1: names for parts, instances, features, and datums.

Three identity layers stay separate, because they fail in different ways.

``semantic path``
    Author-declared, version-stable name of one engineering object, for
    example ``arm/forearm/j3_bearing_seat``.  It survives a rebuild and does
    not depend on traversal order, display order, or array position.
``display label``
    Human-facing and mutable; may be Chinese.  Two objects may share a display
    label, and a repeated label never overrides semantic identity.
``artifact ref``
    Current-geometry handle bound to one exact STEP byte string, for example
    ``occ-<hash12>-0.1`` or ``surf-<hash10>``.  A rebuild invalidates it.

The wire form of a path is canonical: NFC-normalised UTF-8 segments joined by
``/``.  ``/`` and ``%`` inside one segment are percent-escaped, so a slash at
the wire level is always a separator.
"""

from __future__ import annotations

import unicodedata
from typing import Iterable

PROTOCOL_NAME = "reify-identity"
PROTOCOL_VERSION = 1

#: Sidecar written next to ``foo.step`` as ``foo.step.identity.json``.
IDENTITY_SUFFIX = ".identity.json"
#: Legacy sidecar consumed by ``cadctl.mesh``; migrated, never extended.
LEGACY_SUFFIX = ".assembly.json"

#: Entity kinds accepted by the v1 protocol.  ``part`` is the definition of a
#: component, ``instance`` is one placement of it; the two never share a path.
ENTITY_KINDS = (
    "assembly",
    "part",
    "instance",
    "solid",
    "feature",
    "faces",
    "edges",
    "axis",
    "datum",
)

#: Kinds whose bindings point at concrete artifact geometry.
GEOMETRIC_KINDS = ("instance", "solid", "feature", "faces", "edges")

#: Location spaces a declaration may be written in.
COORDINATE_SPACES = ("local", "world")

_RESERVED = {"/": "%2F", "%": "%25"}
_UNRESERVED_HEX = {"2F": "/", "25": "%"}
_HEX_DIGITS = set("0123456789abcdefABCDEF")


class IdentityError(Exception):
    """Actionable identity failure.

    ``code`` is stable so callers and downstream packages can branch on it
    instead of matching prose.  Every message names what was asked for and
    what to do next; the resolver never silently falls back to a first match.
    """

    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def as_payload(self) -> dict[str, object]:
        return {"code": self.code, "message": self.message, **self.details}


def _escape(text: str) -> str:
    out: list[str] = []
    for char in text:
        if char in _RESERVED:
            out.append(_RESERVED[char])
        else:
            out.append(char)
    return "".join(out)


def _unescape(raw: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(raw):
        char = raw[index]
        if char != "%":
            out.append(char)
            index += 1
            continue
        escape = raw[index + 1 : index + 3]
        if len(escape) != 2 or any(digit not in _HEX_DIGITS for digit in escape):
            raise IdentityError(
                "malformed-path",
                f"'{raw}' has a '%' that is not the escape '%25'; encode a literal "
                "percent sign as %25",
                segment=raw,
            )
        decoded = _UNRESERVED_HEX.get(escape.upper())
        if decoded is None:
            raise IdentityError(
                "malformed-path",
                f"'{raw}' uses the reserved escape '%{escape}'; only %2F (slash) "
                "and %25 (percent) are defined",
                segment=raw,
            )
        out.append(decoded)
        index += 3
    return "".join(out)


def _validate_segment(text: str, raw: str) -> str:
    if not text:
        raise IdentityError(
            "malformed-path",
            f"'{raw}' is an empty path segment",
            segment=raw,
        )
    if any(unicodedata.category(char).startswith("C") for char in text):
        raise IdentityError(
            "malformed-path",
            f"'{raw}' contains a control character",
            segment=raw,
        )
    if text in (".", ".."):
        raise IdentityError(
            "malformed-path",
            f"'{raw}' is the reserved segment '{text}'",
            segment=raw,
        )
    if text != text.strip():
        raise IdentityError(
            "malformed-path",
            f"'{raw}' has leading or trailing whitespace",
            segment=raw,
        )
    if text.isascii() and text.isdigit():
        raise IdentityError(
            "malformed-path",
            f"'{raw}' is a bare number; an array position is not a semantic "
            "identity. Name the object instead",
            segment=raw,
        )
    return unicodedata.normalize("NFC", text)


def decode_segment(raw: str) -> str:
    """Decode one wire segment to its canonical name."""
    return _validate_segment(_unescape(raw), raw)


def encode_segment(text: str) -> str:
    """Encode one canonical name to its wire segment."""
    return _escape(_validate_segment(text, text))


def canonicalize_segment(raw: str) -> str:
    """Canonical wire spelling of a segment; equal to ``raw`` when already canonical."""
    return encode_segment(decode_segment(raw))


def canonicalize_path(path: str) -> str:
    """Canonical wire spelling of a whole path.

    Non-canonical spellings (an uppercase-vs-lowercase escape, a decomposed
    accented character) normalise to one form, so two spellings of the same
    path collide instead of creating two identities.
    """
    if not isinstance(path, str) or not path:
        raise IdentityError("malformed-path", f"'{path}' is not a non-empty path string")
    segments = path.split("/")
    return "/".join(canonicalize_segment(segment) for segment in segments)


def split_path(path: str) -> list[str]:
    """Canonical names of every segment of ``path``."""
    return [decode_segment(segment) for segment in canonicalize_path(path).split("/")]


def join_path(segments: Iterable[str]) -> str:
    """Canonical path built from canonical names."""
    values = [encode_segment(segment) for segment in segments]
    if not values:
        raise IdentityError("malformed-path", "a path needs at least one segment")
    return "/".join(values)


def parent_path(path: str) -> str | None:
    segments = canonicalize_path(path).split("/")
    if len(segments) == 1:
        return None
    return "/".join(segments[:-1])


def is_descendant(owner: str, candidate: str) -> bool:
    """True when ``candidate`` lies inside ``owner`` (owner itself excluded)."""
    owner_segments = canonicalize_path(owner).split("/")
    candidate_segments = canonicalize_path(candidate).split("/")
    return (
        len(candidate_segments) > len(owner_segments)
        and candidate_segments[: len(owner_segments)] == owner_segments
    )
