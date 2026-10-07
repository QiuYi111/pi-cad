"""Even-odd profile selection (pure, no adsk).

Canonical loops carry a nesting `depth` (protocol.md section 1). A region is a loop of
EVEN depth minus its direct children. Fusion produces one profile per region, plus one
per odd-depth loop (the "hole" discs). We must select only the profiles whose OUTER loop
matches a canonical loop of even depth. Selecting all profiles would fill the holes.

Inputs are in canonical sketch space (u, v) in mm. The Fusion layer converts the sampled
boundary points of each profile's outer loop back to canonical (u, v) before calling here.
"""
from geom import dist_point_geometry

TOL_MM = 1e-4


class ProfileMatchError(Exception):
    pass


def point_on_loop(p, loop, geometry, tol=TOL_MM):
    return min(dist_point_geometry(p, geometry[gid]) for gid in loop["geometry"]) <= tol


def match_loop(points, loops, geometry, tol=TOL_MM):
    """Return the canonical loop whose geometry carries ALL points, or None."""
    if not points:
        return None
    found = [lp for lp in loops if all(point_on_loop(p, lp, geometry, tol) for p in points)]
    if len(found) > 1:
        raise ProfileMatchError("profile outer loop matches several loops: %s" % [l["id"] for l in found])
    return found[0] if found else None


def select_profiles(loops, geometry, profile_points, tol=TOL_MM):
    """Return the indices of the Fusion profiles to extrude.

    loops: canonical loops (dicts with id, geometry, depth)
    geometry: dict geometry id -> geometry dict
    profile_points: per Fusion profile, points on its OUTER loop in (u, v) mm
    Raises ProfileMatchError when a profile matches no loop, two profiles match the same
    loop, or an even-depth loop has no profile. Never falls back to "select all".
    """
    selected = []
    seen = {}
    for idx, pts in enumerate(profile_points):
        lp = match_loop(pts, loops, geometry, tol)
        if lp is None:
            raise ProfileMatchError("profile %d: outer loop matches no canonical loop" % idx)
        if lp["id"] in seen:
            raise ProfileMatchError("profiles %d and %d both match loop %s" % (seen[lp["id"]], idx, lp["id"]))
        seen[lp["id"]] = idx
        if int(lp["depth"]) % 2 == 0:
            selected.append(idx)
    missing = [lp["id"] for lp in loops if int(lp["depth"]) % 2 == 0 and lp["id"] not in seen]
    if missing:
        raise ProfileMatchError("no Fusion profile found for even-depth loops %s" % missing)
    return selected
