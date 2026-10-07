"""Planar face reference matching (pure). protocol.md section 7 "Face references".

Candidates: {"origin": [x,y,z] (a point on the plane), "normal": [x,y,z], "area": mm2}, world mm.
"""
import math

import edgematch


class FaceMatchError(Exception):
    pass


def _unit(v):
    n = math.sqrt(sum(c * c for c in v))
    if n < 1e-12:
        raise ValueError("zero normal")
    return [c / n for c in v]


def validate_ref(ref):
    if not isinstance(ref, dict):
        return "face_ref must be an object"
    for k in ("origin", "normal"):
        v = ref.get(k)
        if not (isinstance(v, (list, tuple)) and len(v) == 3):
            return "face_ref.%s must be [x,y,z]" % k
    try:
        _unit(ref["normal"])
    except ValueError:
        return "face_ref.normal is zero"
    a = ref.get("area")
    if not isinstance(a, (int, float)) or isinstance(a, bool) or a <= 0:
        return "face_ref.area must be > 0"
    return None


def matches(ref, cand, tol):
    n1, n2 = _unit(ref["normal"]), _unit(cand["normal"])
    if abs(abs(sum(a * b for a, b in zip(n1, n2))) - 1.0) > 1e-6:
        return False
    if abs(sum((a - b) * c for a, b, c in zip(ref["origin"], cand["origin"], n2))) > tol:
        return False
    return abs(cand["area"] - ref["area"]) <= 1e-4 * ref["area"]


def match_face(ref, candidates, diagonal):
    reason = validate_ref(ref)
    if reason:
        raise FaceMatchError(reason)
    tol = edgematch.tolerance(diagonal)
    found = [i for i, c in enumerate(candidates) if matches(ref, c, tol)]
    if not found:
        raise FaceMatchError("no planar face matches origin %s normal %s area %s" % (ref["origin"], ref["normal"], ref["area"]))
    if len(found) > 1:
        raise FaceMatchError("%d planar faces match origin %s normal %s area %s" % (len(found), ref["origin"], ref["normal"], ref["area"]))
    return found[0]
