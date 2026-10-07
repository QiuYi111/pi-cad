"""Edge reference matching (pure). protocol.md section 7 "Edge references".

Candidates are descriptors of the live BRep edges, in world mm:
  {"curve": "line"|"circle"|"arc", "midpoint": [x,y,z], "length": mm, "start"?, "end"?, "centre"?, "radius"?, "axis"?}
"""
import math

REF_CURVES = ("line", "circle", "arc")


class EdgeMatchError(Exception):
    pass


def validate_ref(ref):
    """Return a reason string when the ref is malformed, else None."""
    if not isinstance(ref, dict) or ref.get("curve") not in REF_CURVES:
        return "edge_ref.curve must be line, circle or arc"
    mp = ref.get("midpoint")
    if not (isinstance(mp, (list, tuple)) and len(mp) == 3):
        return "edge_ref.midpoint must be [x,y,z]"
    ln = ref.get("length")
    if not isinstance(ln, (int, float)) or isinstance(ln, bool) or ln <= 0:
        return "edge_ref.length must be > 0"
    return None


def _d(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def tolerance(diagonal):
    return 1e-4 * max(float(diagonal), 1.0)


def matches(ref, cand, tol):
    if ref["curve"] != cand["curve"]:
        return False
    if _d(ref["midpoint"], cand["midpoint"]) > tol:
        return False
    if abs(float(ref["length"]) - cand["length"]) > tol:
        return False
    if ref.get("radius") is not None and cand.get("radius") is not None and abs(ref["radius"] - cand["radius"]) > tol:
        return False
    if ref.get("centre") is not None and cand.get("centre") is not None and _d(ref["centre"], cand["centre"]) > tol:
        return False
    if ref.get("axis") is not None and cand.get("axis") is not None:
        a, b = ref["axis"], cand["axis"]
        na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(x * x for x in b))
        if na > 0 and nb > 0 and abs(abs(sum(x * y for x, y in zip(a, b)) / (na * nb)) - 1.0) > 1e-6:
            return False
    if ref["curve"] != "circle" and ref.get("start") is not None and ref.get("end") is not None \
            and cand.get("start") is not None and cand.get("end") is not None:
        same = _d(ref["start"], cand["start"]) <= tol and _d(ref["end"], cand["end"]) <= tol
        swapped = _d(ref["start"], cand["end"]) <= tol and _d(ref["end"], cand["start"]) <= tol
        if not (same or swapped):
            return False
    return True


def match_edge(ref, candidates, diagonal):
    """Return the index of the single matching candidate. Zero or several matches raise EdgeMatchError."""
    reason = validate_ref(ref)
    if reason:
        raise EdgeMatchError(reason)
    tol = tolerance(diagonal)
    found = [i for i, c in enumerate(candidates) if matches(ref, c, tol)]
    if not found:
        raise EdgeMatchError("no edge matches %s at %s (length %s)" % (ref["curve"], ref["midpoint"], ref["length"]))
    if len(found) > 1:
        raise EdgeMatchError("%d edges match %s at %s (length %s)" % (len(found), ref["curve"], ref["midpoint"], ref["length"]))
    return found[0]
