"""Canonical feature JSON -> ordered build plan (pure, no adsk).

Every decision (plane choice, signs, operations, unsupported features) is made here so it can
be unit tested. fusion_exec.py only executes the plan.

Plan steps (dicts, in build order):
  {"kind": "sketch", "name", "feature", "plane": {"base", "axis", "offset_mm"}, "frame",
   "geometry": [...], "loops": [...]}
  {"kind": "extrude", "name", "type" (pad|pocket|hole), "sketch", "operation"
   (new_body|join|cut), "extent": {"type": "distance"|"all", "distance_mm", "expr"},
   "midplane", "direction_sign"}
  {"kind": "polar_pattern", "name", "originals", "axis": {"name", "sign"}, "angle_deg",
   "angle_expr", "quantity", "full_circle"}

direction_sign is relative to the CANONICAL sketch normal frame.n (+1 same side, -1 opposite).
The Fusion layer measures the real sketch normal and flips if Fusion's normal is opposite.
`expr` fields are carried along but level 1 builds from the evaluated value only.
"""
import math

SCHEMA = "reify.features/1"

P0_TYPES = ("pad", "pocket")
P1_TYPES = ("hole", "polar_pattern")  # keep behind enable_p1 so they can be disabled

AXES = {"XY": ("Z", (0.0, 0.0, 1.0)), "XZ": ("Y", (0.0, 1.0, 0.0)), "YZ": ("X", (1.0, 0.0, 0.0))}
UNSUPPORTED_OPTION_KEYS = ("taper", "taper_angle", "draft_angle", "second_extent", "extent2",
                           "thread", "counterbore", "countersink", "from_face", "offset_start")
TOL = 1e-6


class PlanError(Exception):
    def __init__(self, message, feature=None, step="plan", code="UNSUPPORTED_OP", detail=None):
        Exception.__init__(self, message)
        self.message = message
        self.feature = feature
        self.step = step
        self.code = code
        self.detail = detail or {}


def _unsupported(feature, op, option, reason):
    return PlanError("unsupported feature %r (type %s%s): %s" % (
        feature, op, "" if not option else ", option " + option, reason),
        feature=feature, code="UNSUPPORTED_OP", detail={"op": op, "option": option, "reason": reason})


def _bad(feature, message):
    return PlanError(message, feature=feature, code="EXECUTOR_FAILED")


def dim(x, feature, what):
    """Scalar dimension -> (value, expr). Accepts {'value','expr'} or a bare number."""
    if isinstance(x, dict) and "value" in x:
        return float(x["value"]), x.get("expr")
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        return float(x), None
    raise _bad(feature, "%s: missing scalar dimension" % what)


def _norm(v):
    n = math.sqrt(sum(c * c for c in v))
    if n < TOL:
        raise ValueError("zero vector")
    return [c / n for c in v]


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _sketch_plane(sk, feature):
    plane = sk.get("plane") or {}
    base = plane.get("base")
    if base not in AXES:
        raise _bad(feature, "sketch %r: plane.base must be XY, XZ or YZ" % sk.get("name"))
    axis_name, axis = AXES[base]
    frame = sk.get("frame") or {}
    try:
        n = _norm(frame["n"])
        origin = [float(c) for c in frame["origin"]]
        u = _norm(frame["u"])
        v = _norm(frame["v"])
    except (KeyError, ValueError, TypeError):
        raise _bad(feature, "sketch %r: incomplete frame" % sk.get("name"))
    if abs(abs(_dot(n, axis)) - 1.0) > 1e-6:
        raise _bad(feature, "sketch %r: frame normal is not parallel to the %s axis of plane %s" % (sk.get("name"), axis_name, base))
    if abs(_dot(u, n)) > 1e-6 or abs(_dot(v, n)) > 1e-6:
        raise _bad(feature, "sketch %r: frame u/v not perpendicular to n" % sk.get("name"))
    # Signed offset along the +world axis, derived from the frame (unambiguous for XZ/YZ).
    world_offset = _dot(origin, axis)
    stated = plane.get("offset")
    if stated is not None and abs(abs(float(stated)) - abs(world_offset)) > 1e-4:
        raise _bad(feature, "sketch %r: plane.offset %s disagrees with frame origin (%s)" % (sk.get("name"), stated, world_offset))
    return ({"base": base, "axis": axis_name, "offset_mm": world_offset},
            {"origin": origin, "u": u, "v": v, "n": n})


def _clean_geometry(sk, feature):
    out = {}
    for g in sk.get("geometry", []):
        t = g.get("type")
        if t not in ("line", "arc", "circle", "polyline"):
            raise _unsupported(feature, "sketch", "geometry." + str(t), "sketch geometry type %r in %r" % (t, sk.get("name")))
        out[g["id"]] = dict(g)
    return out


def _sketch_step(sk, feature):
    plane, frame = _sketch_plane(sk, feature)
    geometry = _clean_geometry(sk, feature)
    loops = [dict(l) for l in sk.get("loops", [])]
    if not loops:
        raise _bad(feature, "sketch %r has no loops" % sk.get("name"))
    used = set()
    for lp in loops:
        if not lp.get("closed", True):
            raise _bad(feature, "sketch %r: open loop %s" % (sk.get("name"), lp.get("id")))
        for gid in lp["geometry"]:
            if gid not in geometry:
                raise _bad(feature, "sketch %r: loop %s refers to unknown geometry %s" % (sk.get("name"), lp.get("id"), gid))
            used.add(gid)
    stray = sorted(set(geometry) - used)
    if stray:
        raise _bad(feature, "sketch %r: geometry %s is in no loop" % (sk.get("name"), stray))
    return {"kind": "sketch", "name": sk["name"], "feature": feature, "plane": plane, "frame": frame,
            "geometry": list(geometry.values()),
            "loops": loops}


def _hole_sketch_step(sk, feat, diameter):
    """Hole sketch = circles of `diameter` at feat['positions'] (or at the sketch's circle centers)."""
    plane, frame = _sketch_plane(sk, feat["name"])
    if feat.get("positions"):
        centers = [list(map(float, p)) for p in feat["positions"]]
    else:
        circles = [g for g in sk.get("geometry", [])]
        if not circles or any(g.get("type") != "circle" for g in circles):
            raise _bad(feat["name"], "hole sketch %r must contain only circles (or give `positions`)" % sk.get("name"))
        centers = [list(map(float, g["center"])) for g in circles]
    r = diameter / 2.0
    for i in range(len(centers)):
        for j in range(i + 1, len(centers)):
            if math.hypot(centers[i][0] - centers[j][0], centers[i][1] - centers[j][1]) <= 2 * r + 1e-6:
                raise _bad(feat["name"], "hole circles %d and %d overlap or touch" % (i, j))
    geometry = [{"id": i, "type": "circle", "center": c, "radius": r} for i, c in enumerate(centers)]
    loops = [{"id": i, "geometry": [i], "closed": True, "depth": 0, "area": math.pi * r * r} for i in range(len(centers))]
    return {"kind": "sketch", "name": sk["name"], "feature": feat["name"], "plane": plane, "frame": frame,
            "geometry": geometry, "loops": loops}


def _check_options(feat):
    for k in UNSUPPORTED_OPTION_KEYS:
        if feat.get(k):
            raise _unsupported(feat["name"], feat["type"], k, "option not supported by the Fusion add-in")


def _direction_sign(feat, frame):
    d = feat.get("direction")
    if d is None:
        raise _bad(feat["name"], "missing direction")
    try:
        d = _norm(d)
    except ValueError:
        raise _bad(feat["name"], "zero direction")
    c = _dot(d, frame["n"])
    if abs(abs(c) - 1.0) > 1e-6:
        raise _bad(feat["name"], "direction is not parallel to the sketch normal (dot=%.6f)" % c)
    return 1 if c > 0 else -1


def build_plan(features, enable_p1=True):
    """Return {'part', 'steps': [...], 'feature_names': [...]}. Raises PlanError."""
    if features.get("schema") != SCHEMA:
        raise PlanError("unexpected feature schema %r" % features.get("schema"), code="EXECUTOR_FAILED")
    if features.get("units", "mm") != "mm":
        raise PlanError("units must be mm", code="EXECUTOR_FAILED")
    bodies = features.get("bodies") or []
    if len(bodies) != 1:
        name = bodies[1].get("name") if len(bodies) > 1 else None
        raise _unsupported(name, "body", None, "exactly one body is supported, got %d" % len(bodies))
    body = bodies[0]
    sketches = {s["name"]: s for s in body.get("sketches", [])}
    feats = body.get("features", [])
    names = set()
    sketch_users = {}
    for f in feats:
        if f.get("sketch"):
            sketch_users.setdefault(f["sketch"], []).append(f)

    steps = []
    built = {}  # feature name -> type
    emitted = set()
    has_body = False
    for f in feats:
        name, ftype = f.get("name"), f.get("type")
        if not name:
            raise _bad(None, "feature without a name")
        if name in names:
            raise _bad(name, "duplicate feature name")
        names.add(name)
        if ftype not in P0_TYPES + P1_TYPES or (ftype in P1_TYPES and not enable_p1):
            raise _unsupported(name, ftype, None, "feature type %r is not supported by the Fusion add-in" % ftype)
        _check_options(f)

        if ftype in ("pad", "pocket", "hole"):
            sk = sketches.get(f.get("sketch"))
            if sk is None:
                raise _bad(name, "unknown sketch %r" % f.get("sketch"))
            ext = f.get("extent") or {}
            etype = ext.get("type")
            midplane = bool(f.get("midplane", False))
            diameter = None
            if ftype == "hole":
                if len(sketch_users[sk["name"]]) > 1:
                    raise _bad(name, "hole sketch %r is shared with another feature" % sk["name"])
                if etype != "through_all":
                    raise _unsupported(name, ftype, "extent.type", "hole supports only through_all, got %r" % etype)
                diameter, dexpr = dim(f.get("diameter"), name, "diameter")
                if diameter <= 0:
                    raise _bad(name, "hole diameter must be > 0")
                skstep = _hole_sketch_step(sk, f, diameter)
            else:
                if ftype == "pad" and etype != "length":
                    raise _unsupported(name, ftype, "extent.type", "pad supports only length, got %r" % etype)
                if etype not in ("length", "through_all"):
                    raise _unsupported(name, ftype, "extent.type", "extent %r not supported" % etype)
                skstep = None
            if sk["name"] not in emitted:
                steps.append(skstep or _sketch_step(sk, name))
                emitted.add(sk["name"])
            frame = _sketch_plane(sk, name)[1]
            if etype == "length":
                dist, dexpr = dim(ext.get("length"), name, "extent.length")
                if dist <= 0:
                    raise _bad(name, "extent length must be > 0")
                extent = {"type": "distance", "distance_mm": dist, "expr": dexpr}
            else:
                extent = {"type": "all", "distance_mm": None, "expr": None}
            if ftype == "pad":
                operation = "join" if has_body else "new_body"
                has_body = True
            else:
                if not has_body:
                    raise _bad(name, "%s needs an existing body to cut from" % ftype)
                operation = "cut"
            sign = 1 if midplane else _direction_sign(f, frame)
            step = {"kind": "extrude", "name": name, "type": ftype, "sketch": sk["name"], "operation": operation,
                    "extent": extent, "midplane": midplane, "direction_sign": sign}
            if ftype == "hole":
                step["diameter_mm"] = diameter
                step["diameter_expr"] = dexpr
                step["positions"] = [g["center"] for g in skstep["geometry"]]
            steps.append(step)
            built[name] = ftype
        else:  # polar_pattern
            origs = f.get("originals") or []
            if not origs:
                raise _bad(name, "polar_pattern without originals")
            for o in origs:
                if o not in built:
                    raise _bad(name, "polar_pattern original %r is not an earlier feature" % o)
                if built[o] == "polar_pattern":
                    raise _unsupported(name, ftype, "originals", "pattern of a pattern is not supported")
            axis = _pattern_axis(f)
            angle, aexpr = dim(f.get("angle", {"value": 360.0}), name, "angle")
            qty = f.get("occurrences")
            if not isinstance(qty, int) or isinstance(qty, bool) or qty < 2:
                raise _bad(name, "occurrences must be an integer >= 2")
            full = bool(f.get("full_circle", abs(angle - 360.0) < 1e-9))
            if full:
                angle = 360.0
            steps.append({"kind": "polar_pattern", "name": name, "originals": list(origs), "axis": axis,
                          "angle_deg": angle, "angle_expr": aexpr, "quantity": qty, "full_circle": full})
            built[name] = ftype
    return {"part": features.get("part"), "steps": steps,
            "feature_names": [s["name"] for s in steps if s["kind"] != "sketch"]}


def _pattern_axis(f):
    """Axis must be a world axis (X/Y/Z) through the origin: maps to a Fusion origin axis.

    Limits: axes not through (0,0,0) or not parallel to a world axis are rejected (would need a
    construction axis built from geometry, not implemented at 0.1.0). Negative direction => sign -1.
    """
    ax = f.get("axis") or {}
    try:
        o = [float(c) for c in ax["origin"]]
        d = _norm(ax["direction"])
    except (KeyError, ValueError, TypeError):
        raise _bad(f["name"], "polar_pattern axis incomplete")
    for nm, vec in (("X", (1, 0, 0)), ("Y", (0, 1, 0)), ("Z", (0, 0, 1))):
        c = _dot(d, vec)
        if abs(abs(c) - 1.0) <= 1e-6:
            off = [o[i] - _dot(o, vec) * vec[i] for i in range(3)]
            if max(abs(x) for x in off) > 1e-4:
                raise _unsupported(f["name"], "polar_pattern", "axis.origin",
                                   "axis does not pass through the world origin (off by %s)" % off)
            return {"name": nm, "sign": 1 if c > 0 else -1}
    raise _unsupported(f["name"], "polar_pattern", "axis.direction",
                       "axis is not parallel to a world axis; only X/Y/Z origin axes are supported")
