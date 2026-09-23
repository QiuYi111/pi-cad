"""Reify identity protocol: one name for one engineering object.

Authors declare semantic paths; the build binds each path to the final STEP
geometry and writes a version-bound manifest; every consumer resolves through
the same index.

    from cadctl.identity import Assembly, IdentityIndex

    identity = Assembly("hifi-arm")
    identity.instance("arm/forearm", label="前臂", shape=forearm)

    index = IdentityIndex("arm.step")
    seat = index.resolve("arm/forearm/j3_bearing_seat", expect="one")

See ``docs/identity-protocol.md`` for the wire format and the rules.
"""

from .artifact import ArtifactModel
from .declaration import Assembly, current, reset
from .manifest import (
    build_manifest,
    identity_path,
    legacy_path,
    load_manifest,
    prune_stale_manifest,
    write_manifest,
)
from .protocol import (
    ENTITY_KINDS,
    IDENTITY_SUFFIX,
    LEGACY_SUFFIX,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    IdentityError,
    canonicalize_path,
    decode_segment,
    encode_segment,
    join_path,
    parent_path,
    split_path,
)
from .resolver import IdentityIndex, Resolution, ancestor_paths, resolve_many

__all__ = [
    "ArtifactModel",
    "Assembly",
    "ENTITY_KINDS",
    "IDENTITY_SUFFIX",
    "IdentityError",
    "IdentityIndex",
    "LEGACY_SUFFIX",
    "PROTOCOL_NAME",
    "PROTOCOL_VERSION",
    "Resolution",
    "ancestor_paths",
    "build_manifest",
    "canonicalize_path",
    "current",
    "decode_segment",
    "encode_segment",
    "identity_path",
    "join_path",
    "legacy_path",
    "load_manifest",
    "parent_path",
    "prune_stale_manifest",
    "reset",
    "resolve_many",
    "split_path",
    "write_manifest",
]
