"""Feature-level change summary pieces (pure Python)."""

from __future__ import annotations

from typing import Any

MAX_ANNOTATIONS = 8


def diff_params(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    changed = {}
    for name in sorted(set(before) | set(after)):
        if before.get(name) != after.get(name):
            changed[name] = [before.get(name), after.get(name)]
    return {"changed": changed}


def diff_features(before: set[str], after: set[str], recomputed: set[str]) -> dict[str, list[str]]:
    return {
        "recomputed": sorted((recomputed & before & after)),
        "added": sorted(after - before),
        "removed": sorted(before - after),
    }


def changed_role_paths(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """Role paths that are new or whose face signature changed."""
    return sorted(key for key, signature in after.items() if before.get(key) != signature)


def feature_of_role(key: str) -> str:
    """``bracket/mount_hole/wall`` -> ``bracket/mount_hole`` (role suffixes are the last segment)."""
    return key.rpartition("/")[0] or key
