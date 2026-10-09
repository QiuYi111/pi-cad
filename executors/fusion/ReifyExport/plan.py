"""Canonical feature JSON -> ordered build plan (pure, no adsk).

Every decision (plane choice, signs, operations, expression binding, unsupported features) is made
here so it can be unit tested and so that plan errors are raised BEFORE any Fusion call.
fusion_exec.py only executes the plan.

Plan = {"part", "steps": [...], "feature_names": [...], "parameters": [...], "material": {...}|None,
        "warnings": [...]}.  Steps (dicts, build order):
  sketch        {"kind","name","feature","plane":{"base","axis","offset_mm"}|{"face_ref"},"frame",
                 "geometry","loops","points","dimensions"}
  extrude       {"kind","name","type"(pad|pocket|hole),"sketch","operation"(new_body|join|cut),
                 "extent":{"type":"distance"|"all"|"to_face", "distance_mm","fx","face_ref"},
                 "midplane","direction_sign","direction"(world unit)}
  hole          native Fusion hole feature (P3)
  polar_pattern / linear_pattern / mirror / fillet / chamfer
direction_sign is relative to the CANONICAL sketch normal frame.n; fusion_exec flips it if Fusion's
real sketch normal is opposite. `fx` fields are Fusion expression strings (user-parameter binding)
or None (use the evaluated value).
"""
import math

import edgematch
import facematch
import params as parmod

SCHEMA = "reify.features/1"
ASSEMBLY_SCHEMA = "reify.assembly/1"

P0_TYPES = ("pad", "pocket")
P1_TYPES = ("hole", "polar_pattern")           # keep behind enable_p1
P2_TYPES = ("linear_pattern", "mirror")        # keep behind enable_p2
P3_TYPES = ("fillet", "chamfer")               # keep behind enable_p3

AXES = {"XY": ("Z", (0.0, 0.0, 1.0)), "XZ": ("Y", (0.0, 1.0, 0.0)), "YZ": ("X", (1.0, 0.0, 0.0))}
BASE_OF_AXIS = {"Z": "XY", "Y": "XZ", "X": "YZ"}
UNSUPPORTED_OPTION_KEYS = ("taper", "taper_angle", "draft_angle", "second_extent", "extent2",
                           "from_face", "offset_start")
TOL = 1e-6
SKETCH_DIM_KINDS = ("distance", "distance_x", "distance_y", "radius", "diameter", "angle")
SOLID_TYPES = ("pad", "pocket", "hole")


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


def _norm(v):
    n = math.sqrt(sum(c * c for c in v))
    if n < TOL:
        raise ValueError("zero vector")
    return [c / n for c in v]


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _world_axis(vec):
    """(name, sign) when vec is parallel to a world axis, else None."""
    d = _norm(vec)
    for nm, v in (("X", (1, 0, 0)), ("Y", (0, 1, 0)), ("Z", (0, 0, 1))):
        c = _dot(d, v)
        if abs(abs(c) - 1.0) <= 1e-6:
            return nm, (1 if c > 0 else -1)
    return None


class _Ctx(object):
    """Per-plan state: binder (parameters/expressions), warnings, sketch lookup."""

    def __init__(self, features, bind_params):
        self.warnings = []
        self.binder = parmod.Binder(features.get("parameters") or [], bind=bind_params, warnings=self.warnings)
        self.bind_params = bind_params

    def dim(self, x, kind, feature, what):
        v, expr, fx = self.binder.scalar(x, kind, feature, what)
        if v is None:
            raise _bad(feature, "%s: missing scalar dimension" % what)
        return v, expr, fx


# ---------------------------------------------------------------------------- sketches
def _face_ref(ref, feature):
    reason = facematch.validate_ref(ref)
    if reason:
        raise _bad(feature, reason)
    return {"origin": [float(c) for c in ref["origin"]], "normal": _norm(ref["normal"]), "area": float(ref["area"])}


def _sketch_plane(sk, feature):
    plane = sk.get("plane") or {}
    frame = sk.get("frame") or {}
    try:
        n = _norm(frame["n"])
        origin = [float(c) for c in frame["origin"]]
        u = _norm(frame["u"])
        v = _norm(frame["v"])
    except (KeyError, ValueError, TypeError):
        raise _bad(feature, "sketch %r: incomplete frame" % sk.get("name"))
    if abs(_dot(u, n)) > 1e-6 or abs(_dot(v, n)) > 1e-6:
        raise _bad(feature, "sketch %r: frame u/v not perpendicular to n" % sk.get("name"))
    fr = {"origin": origin, "u": u, "v": v, "n": n}
    base = plane.get("base")
    axis_ok = base in AXES and abs(abs(_dot(n, AXES[base][1])) - 1.0) <= 1e-6
    if axis_ok:
        axis_name, axis = AXES[base]
        world_offset = _dot(origin, axis)   # signed along the +world axis (protocol section 1)
        stated = plane.get("offset")
        if stated is not None and abs(abs(float(stated)) - abs(world_offset)) > 1e-4:
            raise _bad(feature, "sketch %r: plane.offset %s disagrees with frame origin (%s)" % (sk.get("name"), stated, world_offset))
        return {"base": base, "axis": axis_name, "offset_mm": world_offset}, fr
    if sk.get("face_ref"):
        return {"face_ref": _face_ref(sk["face_ref"], feature)}, fr
    if base in AXES:
        raise _bad(feature, "sketch %r: frame normal is not parallel to the %s axis of plane %s" % (sk.get("name"), AXES[base][0], base))
    raise _bad(feature, "sketch %r: plane.base must be XY, XZ or YZ (or give face_ref for a tilted sketch)" % sk.get("name"))


def _clean_geometry(sk, feature):
    out = {}
    for g in sk.get("geometry", []):
        t = g.get("type")
        if t not in ("line", "arc", "circle", "polyline"):
            raise _unsupported(feature, "sketch", "geometry." + str(t), "sketch geometry type %r in %r" % (t, sk.get("name")))
        out[g["id"]] = dict(g)
    return out


def _dimensions(sk, geometry, feature, ctx):
    out = []
    for i, d in enumerate(sk.get("dimensions") or []):
        kind = d.get("kind")
        label = d.get("name") or "dim%d" % i
        if kind not in SKETCH_DIM_KINDS:
            raise _bad(feature, "sketch %r dimension %r: unknown kind %r" % (sk.get("name"), label, kind))
        refs = [tuple(r) for r in d.get("refs", [])]
        need = {"distance": (1, 2), "distance_x": (1, 2), "distance_y": (1, 2), "radius": (1, 1), "diameter": (1, 1), "angle": (2, 2)}[kind]
        if not (need[0] <= len(refs) <= need[1]) or any(len(r) != 2 for r in refs):
            raise _bad(feature, "sketch %r dimension %r: bad refs for kind %s" % (sk.get("name"), label, kind))
        for gid, pos in refs:
            if not (gid == -1 and pos == 1) and gid not in geometry:
                raise _bad(feature, "sketch %r dimension %r: unknown geometry %s" % (sk.get("name"), label, gid))
            if pos not in (0, 1, 2, 3):
                raise _bad(feature, "sketch %r dimension %r: bad position %s" % (sk.get("name"), label, pos))
        value, expr, fx = ctx.dim(d.get("value"), "angle" if kind == "angle" else "length", feature, "sketch dimension %s" % label)
        out.append({"name": label, "kind": kind, "refs": [list(r) for r in refs], "value": value, "expr": expr, "fx": fx})
    return out


def _sketch_step(sk, feature, ctx):
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
    stray = sorted(set(geometry) - used, key=str)
    if stray:
        raise _bad(feature, "sketch %r: geometry %s is in no loop" % (sk.get("name"), stray))
    return {"kind": "sketch", "name": sk["name"], "feature": feature, "plane": plane, "frame": frame,
            "geometry": list(geometry.values()), "loops": loops, "points": [],
            "dimensions": _dimensions(sk, geometry, feature, ctx)}


def _hole_positions(sk, feat):
    if feat.get("positions"):
        return [list(map(float, p)) for p in feat["positions"]]
    circles = list(sk.get("geometry", []))
    if not circles or any(g.get("type") != "circle" for g in circles):
        raise _bad(feat["name"], "hole sketch %r must contain only circles (or give `positions`)" % sk.get("name"))
    return [list(map(float, g["center"])) for g in circles]


def _hole_sketch_step(sk, feat, diameter, ctx, native):
    """Hole sketch. Extrude-cut mode: circles of `diameter`. Native mode: sketch points only."""
    plane, frame = _sketch_plane(sk, feat["name"])
    centers = _hole_positions(sk, feat)
    if sk.get("dimensions"):
        ctx.warnings.append({"feature": feat["name"], "field": "sketch.dimensions", "expr": None,
                             "reason": "hole sketch %r is rebuilt from positions; its dimensions are not added" % sk.get("name")})
    base = {"kind": "sketch", "name": sk["name"], "feature": feat["name"], "plane": plane, "frame": frame, "dimensions": []}
    if native:
        base.update(geometry=[], loops=[], points=centers)
        return base
    r = diameter / 2.0
    for i in range(len(centers)):
        for j in range(i + 1, len(centers)):
            if math.hypot(centers[i][0] - centers[j][0], centers[i][1] - centers[j][1]) <= 2 * r + 1e-6:
                raise _bad(feat["name"], "hole circles %d and %d overlap or touch" % (i, j))
    base.update(geometry=[{"id": i, "type": "circle", "center": c, "radius": r} for i, c in enumerate(centers)],
                loops=[{"id": i, "geometry": [i], "closed": True, "depth": 0, "area": math.pi * r * r} for i in range(len(centers))],
                points=[])
    return base


def _check_options(feat):
    for k in UNSUPPORTED_OPTION_KEYS:
        if feat.get(k):
            raise _unsupported(feat["name"], feat["type"], k, "option not supported by the Fusion add-in")


def _direction(feat, frame):
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
    return (1 if c > 0 else -1), d


def _material(features):
    m = features.get("material")
    if not m:
        return None
    dens = m.get("density_kg_m3") if isinstance(m, dict) else None
    if not isinstance(dens, (int, float)) or isinstance(dens, bool) or dens <= 0:
        raise PlanError("material.density_kg_m3 must be a positive number", code="EXECUTOR_FAILED")
    return {"name": m.get("name") or "Reify material", "density_kg_m3": float(dens)}


# ---------------------------------------------------------------------------- build_plan
def build_plan(features, enable_p1=True, enable_p2=True, enable_p3=True, native_holes=True, bind_params=True):
    """Return the plan dict. Raises PlanError (nothing has touched Fusion yet)."""
    if features.get("schema") != SCHEMA:
        raise PlanError("unexpected feature schema %r" % features.get("schema"), code="EXECUTOR_FAILED")
    if features.get("units", "mm") != "mm":
        raise PlanError("units must be mm", code="EXECUTOR_FAILED")
    bodies = features.get("bodies") or []
    if len(bodies) != 1:
        name = bodies[1].get("name") if len(bodies) > 1 else None
        raise _unsupported(name, "body", None, "exactly one body is supported, got %d" % len(bodies))
    body = bodies[0]
    ctx = _Ctx(features, bind_params)
    native_holes = bool(native_holes and enable_p3)
    enabled = set(P0_TYPES)
    for flag, types in ((enable_p1, P1_TYPES), (enable_p2, P2_TYPES), (enable_p3, P3_TYPES)):
        if flag:
            enabled.update(types)
    sketches = {s["name"]: s for s in body.get("sketches", [])}
    feats = body.get("features", [])
    names = set()
    sketch_users = {}
    for f in feats:
        if f.get("sketch"):
            sketch_users.setdefault(f["sketch"], []).append(f)

    steps = []
    built = {}
    emitted = set()
    has_body = False
    for f in feats:
        name, ftype = f.get("name"), f.get("type")
        if not name:
            raise _bad(None, "feature without a name")
        if name in names:
            raise _bad(name, "duplicate feature name")
        names.add(name)
        if ftype not in enabled:
            raise _unsupported(name, ftype, None, "feature type %r is not supported by the Fusion add-in" % ftype)
        _check_options(f)

        if ftype in SOLID_TYPES:
            sk = sketches.get(f.get("sketch"))
            if sk is None:
                raise _bad(name, "unknown sketch %r" % f.get("sketch"))
            step, skstep, has_body = _solid_step(f, sk, sketch_users, ctx, has_body, native_holes, enable_p3)
            if sk["name"] not in emitted:
                steps.append(skstep)
                emitted.add(sk["name"])
            steps.append(step)
        elif ftype in ("polar_pattern", "linear_pattern", "mirror"):
            steps.append(_pattern_step(f, built, ctx))
        else:  # fillet / chamfer
            if not has_body:
                raise _bad(name, "%s needs an existing body" % ftype)
            steps.append(_edge_step(f, ctx))
        built[name] = ftype
    return {"part": features.get("part"), "steps": steps,
            "feature_names": [s["name"] for s in steps if s["kind"] != "sketch"],
            "parameters": list(ctx.binder.plan), "material": _material(features), "warnings": ctx.warnings}


def _solid_step(f, sk, sketch_users, ctx, has_body, native_holes, enable_p3):
    name, ftype = f["name"], f["type"]
    ext = f.get("extent") or {}
    etype = ext.get("type")
    midplane = bool(f.get("midplane", False))
    skstep = None
    hole_extra = None
    if ftype == "hole":
        if len(sketch_users[sk["name"]]) > 1:
            raise _bad(name, "hole sketch %r is shared with another feature" % sk["name"])
        diameter, dexpr, dfx = ctx.dim(f.get("diameter"), "length", name, "diameter")
        if diameter <= 0:
            raise _bad(name, "hole diameter must be > 0")
        hole_extra = _hole_options(f, ext, etype, diameter, native_holes, enable_p3, ctx)
        skstep = _hole_sketch_step(sk, f, diameter, ctx, native_holes)
    else:
        if ftype == "pad" and etype not in ("length", "up_to_face"):
            raise _unsupported(name, ftype, "extent.type", "pad supports length and up_to_face, got %r" % etype)
        if ftype == "pocket" and etype not in ("length", "through_all"):
            raise _unsupported(name, ftype, "extent.type", "extent %r not supported" % etype)
        if etype == "up_to_face" and not enable_p3:
            raise _unsupported(name, ftype, "extent.type", "up_to_face is a P3 feature (disabled)")
        skstep = _sketch_step(sk, name, ctx)
    frame = skstep["frame"]

    if etype == "length":
        dist, dexpr2, dfx2 = ctx.dim(ext.get("length"), "length", name, "extent.length")
        if dist <= 0:
            raise _bad(name, "extent length must be > 0")
        extent = {"type": "distance", "distance_mm": dist, "expr": dexpr2, "fx": dfx2}
    elif etype == "up_to_face":
        if midplane:
            raise _unsupported(name, ftype, "midplane", "up_to_face cannot be combined with midplane")
        extent = {"type": "to_face", "distance_mm": None, "expr": None, "fx": None, "face_ref": _face_ref(ext.get("face_ref"), name)}
    else:
        extent = {"type": "all", "distance_mm": None, "expr": None, "fx": None}

    if ftype == "pad":
        operation = "join" if has_body else "new_body"
        has_body = True
    else:
        if not has_body:
            raise _bad(name, "%s needs an existing body to cut from" % ftype)
        operation = "cut"
    sign, world_dir = (1, [c for c in frame["n"]]) if midplane else _direction(f, frame)
    if ftype == "hole" and native_holes:
        step = {"kind": "hole", "name": name, "type": "hole", "sketch": sk["name"], "operation": "cut",
                "direction_sign": sign, "direction": world_dir, "diameter_mm": diameter, "diameter_expr": dexpr,
                "diameter_fx": dfx, "positions": skstep["points"]}
        step.update(hole_extra)
        return step, skstep, has_body
    step = {"kind": "extrude", "name": name, "type": ftype, "sketch": sk["name"], "operation": operation,
            "extent": extent, "midplane": midplane, "direction_sign": sign, "direction": world_dir}
    if ftype == "hole":
        step.update(diameter_mm=diameter, diameter_expr=dexpr, diameter_fx=dfx,
                    positions=[g["center"] for g in skstep["geometry"]])
    return step, skstep, has_body


def _hole_options(f, ext, etype, diameter, native, enable_p3, ctx):
    """Validate hole options. Returns the native-hole fields (also validates in extrude mode)."""
    name = f["name"]
    for key in ("counterbore", "countersink", "thread", "drill_point"):
        if f.get(key) and not native:
            raise _unsupported(name, "hole", key, "%s needs native hole features (P3)" % key)
    if etype == "through_all":
        extent = {"type": "all", "distance_mm": None, "expr": None, "fx": None}
    elif etype == "blind":
        if not native:
            raise _unsupported(name, "hole", "extent.type", "blind holes need native hole features (P3)")
        d, e, fx = ctx.dim(ext.get("depth"), "length", name, "extent.depth")
        if d <= 0:
            raise _bad(name, "blind hole depth must be > 0")
        extent = {"type": "distance", "distance_mm": d, "expr": e, "fx": fx}
    else:
        raise _unsupported(name, "hole", "extent.type", "hole supports through_all and blind, got %r" % etype)
    if f.get("counterbore") and f.get("countersink"):
        raise _bad(name, "hole has both counterbore and countersink")
    out = {"extent": extent, "hole_type": "simple", "counterbore": None, "countersink": None,
           "drill_point": None, "thread": None}
    if not native:
        return out
    cb = f.get("counterbore")
    if cb:
        cd, ce, cfx = ctx.dim(cb.get("diameter"), "length", name, "counterbore.diameter")
        cdep, cde, cdfx = ctx.dim(cb.get("depth"), "length", name, "counterbore.depth")
        if cd <= diameter or cdep <= 0:
            raise _bad(name, "counterbore needs diameter > hole diameter and depth > 0")
        out["hole_type"] = "counterbore"
        out["counterbore"] = {"diameter_mm": cd, "diameter_fx": cfx, "depth_mm": cdep, "depth_fx": cdfx}
    cs = f.get("countersink")
    if cs:
        sd, se, sfx = ctx.dim(cs.get("diameter"), "length", name, "countersink.diameter")
        ang, ae, afx = ctx.dim(cs.get("angle_deg", cs.get("angle")), "angle", name, "countersink.angle")
        if sd <= diameter or not (0 < ang < 180):
            raise _bad(name, "countersink needs diameter > hole diameter and 0 < angle < 180")
        out["hole_type"] = "countersink"
        out["countersink"] = {"diameter_mm": sd, "diameter_fx": sfx, "angle_deg": ang, "angle_fx": afx}
    dp = f.get("drill_point")
    if dp:
        if dp.get("type") not in ("flat", "angled"):
            raise _bad(name, "drill_point.type must be flat or angled")
        if extent["type"] == "all":
            raise _bad(name, "drill_point only applies to blind holes")
        out["drill_point"] = {"type": dp["type"], "angle_deg": float(dp.get("angle_deg", 118.0)) if dp["type"] == "angled" else None}
    th = f.get("thread")
    if th:
        if th.get("modeled"):
            raise _unsupported(name, "hole", "thread.modeled", "modeled threads are not supported (cosmetic only)")
        out["thread"] = {"standard": th.get("standard"), "size": th.get("size"), "pitch_mm": th.get("pitch_mm")}
        ctx.warnings.append({"feature": name, "field": "thread", "expr": th.get("size"),
                             "reason": "cosmetic thread not created in Fusion (a tapped hole would change the hole diameter); hole diameter kept"})
    return out


def _check_originals(f, built):
    allowed = SOLID_TYPES + ("polar_pattern", "linear_pattern", "mirror") if f["type"] == "mirror" else SOLID_TYPES
    name = f["name"]
    origs = f.get("originals") or []
    if not origs:
        raise _bad(name, "%s without originals" % f["type"])
    for o in origs:
        if o not in built:
            raise _bad(name, "%s original %r is not an earlier feature" % (f["type"], o))
        if built[o] not in allowed:
            raise _unsupported(name, f["type"], "originals", "original %r is a %s; only %s can be %s" % (
                o, built[o], "/".join(allowed), "mirrored" if f["type"] == "mirror" else "patterned"))
    return list(origs)


def _pattern_step(f, built, ctx):
    name, ftype = f["name"], f["type"]
    origs = _check_originals(f, built)
    if ftype == "mirror":
        pl = f.get("plane") or {}
        try:
            n = _norm(pl["normal"])
            o = [float(c) for c in pl["origin"]]
        except (KeyError, ValueError, TypeError):
            raise _bad(name, "mirror plane incomplete")
        ax = _world_axis(n)
        if ax is None:
            raise _unsupported(name, "mirror", "plane.normal",
                               "mirror plane is not parallel to a world plane (XY/XZ/YZ); tilted planes are not supported")
        return {"kind": "mirror", "name": name, "originals": origs,
                "plane": {"base": BASE_OF_AXIS[ax[0]], "axis": ax[0], "offset_mm": _dot(o, AXES[BASE_OF_AXIS[ax[0]]][1])}}
    qty = f.get("occurrences")
    if not isinstance(qty, int) or isinstance(qty, bool) or qty < 2:
        raise _bad(name, "occurrences must be an integer >= 2")
    if ftype == "linear_pattern":
        try:
            ax = _world_axis(f["direction"])
        except (KeyError, ValueError, TypeError):
            raise _bad(name, "linear_pattern direction missing")
        if ax is None:
            raise _unsupported(name, ftype, "direction", "direction is not parallel to a world axis; only X/Y/Z are supported")
        length, lexpr, lfx = ctx.dim(f.get("length"), "length", name, "length")
        if f.get("spacing") is not None:
            spacing = ctx.dim(f["spacing"], "length", name, "spacing")[0]
        else:
            spacing = length / (qty - 1)
        if length <= 0 or spacing <= 0:
            raise _bad(name, "linear_pattern length/spacing must be > 0")
        if abs(spacing * (qty - 1) - length) > 1e-6 * max(1.0, length):
            raise _bad(name, "linear_pattern spacing x (occurrences-1) != length")
        sfx = "(%s) / %d" % (lfx, qty - 1) if lfx else None
        return {"kind": "linear_pattern", "name": name, "originals": origs, "axis": {"name": ax[0], "sign": ax[1]},
                "quantity": qty, "length_mm": length, "spacing_mm": spacing, "spacing_fx": sfx}
    axis = _pattern_axis(f)
    angle, aexpr, afx = ctx.dim(f.get("angle", {"value": 360.0}), "angle", name, "angle")
    full = bool(f.get("full_circle", abs(angle - 360.0) < 1e-9))
    if full:
        angle, afx = 360.0, None
    return {"kind": "polar_pattern", "name": name, "originals": origs, "axis": axis, "angle_deg": angle,
            "angle_expr": aexpr, "angle_fx": afx, "quantity": qty, "full_circle": full}


def _edge_step(f, ctx):
    name, ftype = f["name"], f["type"]
    edges = f.get("edges") or []
    if not edges:
        raise _bad(name, "%s without edges" % ftype)
    for i, ref in enumerate(edges):
        reason = edgematch.validate_ref(ref)
        if reason:
            raise _bad(name, "edge %d: %s" % (i, reason))
    key = "radius" if ftype == "fillet" else "size"
    v, e, fx = ctx.dim(f.get(key), "length", name, key)
    if v <= 0:
        raise _bad(name, "%s %s must be > 0" % (ftype, key))
    return {"kind": ftype, "name": name, "edges": [dict(r) for r in edges], "size_mm": v, "expr": e, "fx": fx}


def _pattern_axis(f):
    """Axis must be a world X/Y/Z axis through the origin (Fusion origin axis). Negative direction => sign -1."""
    ax = f.get("axis") or {}
    try:
        o = [float(c) for c in ax["origin"]]
        found = _world_axis(ax["direction"])
    except (KeyError, ValueError, TypeError):
        raise _bad(f["name"], "polar_pattern axis incomplete")
    if found is None:
        raise _unsupported(f["name"], "polar_pattern", "axis.direction",
                           "axis is not parallel to a world axis; only X/Y/Z origin axes are supported")
    vec = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}[found[0]]
    off = [o[i] - _dot(o, vec) * vec[i] for i in range(3)]
    if max(abs(x) for x in off) > 1e-4:
        raise _unsupported(f["name"], "polar_pattern", "axis.origin",
                           "axis does not pass through the world origin (off by %s)" % off)
    return {"name": found[0], "sign": found[1]}


# ---------------------------------------------------------------------------- assemblies
def build_assembly_plan(asm, **opts):
    """Plan for a `reify.assembly/1` job: one component per occurrence, same feature plan inside."""
    if not isinstance(asm, dict) or asm.get("schema") != ASSEMBLY_SCHEMA:
        raise PlanError("unexpected assembly schema %r" % (asm or {}).get("schema") if isinstance(asm, dict) else "assembly missing",
                        code="EXECUTOR_FAILED")
    if asm.get("units", "mm") != "mm":
        raise PlanError("units must be mm", code="EXECUTOR_FAILED")
    parts = {p.get("ref"): p for p in asm.get("parts", [])}
    occs = asm.get("occurrences") or []
    if not occs:
        raise PlanError("assembly has no occurrences", code="EXECUTOR_FAILED")
    warnings, out, seen, warned = [], [], set(), set()
    opts = dict(opts, bind_params=False)  # user parameters are design-global; not bound in assemblies
    for oc in occs:
        oname = oc.get("name")
        if not oname or oname in seen:
            raise PlanError("occurrence name missing or duplicated: %r" % oname, feature=oname, code="EXECUTOR_FAILED")
        seen.add(oname)
        part = parts.get(oc.get("part"))
        if part is None:
            raise PlanError("occurrence %r refers to unknown part %r" % (oname, oc.get("part")), feature=oname, code="EXECUTOR_FAILED")
        tr = oc.get("transform") or {}
        try:
            o = [float(c) for c in tr["origin"]]
            R = [[float(c) for c in row] for row in tr["rotation"]]
            assert len(o) == 3 and len(R) == 3 and all(len(r) == 3 for r in R)
        except (KeyError, TypeError, ValueError, AssertionError):
            raise PlanError("occurrence %r: bad transform" % oname, feature=oname, code="EXECUTOR_FAILED")
        for i in range(3):
            for j in range(3):
                if abs(sum(R[k][i] * R[k][j] for k in range(3)) - (1.0 if i == j else 0.0)) > 1e-6:
                    raise PlanError("occurrence %r: rotation is not orthonormal" % oname, feature=oname, code="EXECUTOR_FAILED")
        det = (R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0])
               + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]))
        if det < 0:
            raise _unsupported(oname, "occurrence", "transform", "mirrored (left-handed) transforms are not supported")
        feats = part.get("features") or {}
        pplan = build_plan(feats, **opts)
        if feats.get("parameters") and part.get("ref") not in warned:
            warned.add(part.get("ref"))
            warnings.append({"feature": part.get("name") or part.get("ref"), "field": "parameters", "expr": None,
                             "reason": "user parameters are not created in assembly jobs; feature values were used"})
        warnings.extend(pplan["warnings"])
        out.append({"name": oname, "part": oc.get("part"), "transform": {"origin": o, "rotation": R}, "plan": pplan})
    return {"kind": "assembly", "name": asm.get("name"), "occurrences": out, "warnings": warnings,
            "feature_names": [o["name"] for o in out]}
