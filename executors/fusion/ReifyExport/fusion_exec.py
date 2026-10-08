"""Thin Fusion API layer. Executes a plan built by plan.py (parts and assemblies).

All decisions live in plan.py / profiles.py / edgematch.py / facematch.py / params.py / geom.py.
This file must only be called on the Fusion MAIN thread (from the custom event handler). Units: the
Fusion API works in cm (and radians), the plan in mm (and degrees); conversions are `_cm()` / `_mm()`.

Items marked UNVERIFIED were written from the API documentation without a Fusion install.
"""
import math
import os
import time

try:  # guarded so the pure modules and tests can import this package without Fusion
    import adsk.core
    import adsk.fusion
except ImportError:  # pragma: no cover
    adsk = None

import edgematch
import facematch
import geom
import profiles
from jobs import ExecError

SAMPLES_PER_CURVE = 9
_BASE_PLANES = {"XY": "xYConstructionPlane", "XZ": "xZConstructionPlane", "YZ": "yZConstructionPlane"}
_BASE_AXES = {"X": "xConstructionAxis", "Y": "yConstructionAxis", "Z": "zConstructionAxis"}
_AXIS_VEC = {"Z": (0.0, 0.0, 1.0), "Y": (0.0, 1.0, 0.0), "X": (1.0, 0.0, 0.0)}
_CURVE_OF = {"adsk::core::Line3D": "line", "adsk::core::Circle3D": "circle", "adsk::core::Arc3D": "arc"}


def _cm(mm):
    return mm / 10.0


def _mm(cm):
    return cm * 10.0


def _items(coll):
    return [coll.item(i) for i in range(coll.count)]


def _set_name(obj, name, log):
    """Rename a timeline feature/sketch/plane. UNVERIFIED: whether '/' is accepted in names."""
    try:
        obj.name = name
    except Exception as e:  # noqa: BLE001
        alt = name.replace("/", "_")
        log("WARN name %r rejected (%s); using %r" % (name, e, alt))
        obj.name = alt


def _plane_entity(comp, plane, name, log):
    """Origin plane, or an offset construction plane. Sign is measured against Fusion's real normal."""
    base = getattr(comp, _BASE_PLANES[plane["base"]])
    if abs(plane["offset_mm"]) <= 1e-9:
        return base
    nrm = base.geometry.normal
    av = _AXIS_VEC[plane["axis"]]
    s = nrm.x * av[0] + nrm.y * av[1] + nrm.z * av[2]
    signed = plane["offset_mm"] * (1.0 if s >= 0 else -1.0)
    cin = comp.constructionPlanes.createInput()
    cin.setByOffset(base, adsk.core.ValueInput.createByReal(_cm(signed)))
    ent = comp.constructionPlanes.add(cin)
    _set_name(ent, name, log)
    return ent


def _has_fx(obj):
    if isinstance(obj, dict):
        return any((k.endswith("fx") and v) or _has_fx(v) for k, v in obj.items())
    if isinstance(obj, (list, tuple)):
        return any(_has_fx(v) for v in obj)
    return False


def _v3(p):
    return [_mm(p.x), _mm(p.y), _mm(p.z)]


class _SkipDimension(Exception):
    pass


class _Bc(object):
    """Per-job build context."""

    def __init__(self, design, log, deadline, progress):
        self.design, self.log, self.deadline, self.progress = design, log, deadline, progress
        self.warnings = []

    def warn(self, feature, field, expr, reason):
        self.warnings.append({"feature": feature, "field": field, "expr": expr, "reason": reason})
        self.log("WARN %s %s: %s" % (feature, field, reason))


class FusionExecutor(object):
    def __init__(self, app=None):
        self.app = app or adsk.core.Application.get()

    # ------------------------------------------------------------------ public
    def app_version(self):
        try:
            return "Fusion " + str(self.app.version)
        except Exception:  # noqa: BLE001
            return "Fusion"

    def run(self, plan, outbox, native, check_step, log, deadline, progress):
        doc = None
        prefs = None
        prev_orient = None
        try:
            # Reify is Z-up. A Y-up Fusion document would rotate the exported STEP.
            # UNVERIFIED: generalPreferences.defaultModelingOrientation applies to documents.add.
            try:
                prefs = self.app.preferences.generalPreferences
                prev_orient = prefs.defaultModelingOrientation
                prefs.defaultModelingOrientation = adsk.core.DefaultModelingOrientations.ZUpModelingOrientation
            except Exception as e:  # noqa: BLE001
                prefs = None
                log("WARN could not force Z-up modeling orientation: %s" % e)
            progress["feature"] = None
            try:
                doc = self.app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
            finally:
                if prefs is not None:
                    try:
                        prefs.defaultModelingOrientation = prev_orient
                    except Exception:  # noqa: BLE001
                        pass
            design = adsk.fusion.Design.cast(self.app.activeProduct)
            if design is None:
                raise ExecError("active product is not a Fusion design", step="document")
            design.designType = adsk.fusion.DesignTypes.ParametricDesignType
            try:
                design.fusionUnitsManager.distanceDisplayUnits = adsk.fusion.DistanceUnits.MillimeterDistanceUnits
            except Exception as e:  # noqa: BLE001
                log("WARN could not set display units to mm (internal unit stays cm): %s" % e)
            bc = _Bc(design, log, deadline, progress)
            if plan.get("kind") == "assembly":
                res = self._build_assembly(bc, plan)
            else:
                res = self._build_part(bc, plan)
            self._export(design, design.rootComponent, outbox, native, check_step, log)
            res["warnings"] = bc.warnings
            return res
        finally:
            if doc is not None:
                try:
                    doc.close(False)  # False = do not save; the doc was never saved anywhere
                    log("document closed without saving")
                except Exception as e:  # noqa: BLE001
                    log("WARN doc.close(False) failed: %s" % e)

    # ------------------------------------------------------------------ part / assembly
    def _build_part(self, bc, plan):
        root = bc.design.rootComponent
        self._create_parameters(bc, plan.get("parameters", []))
        volumes = self._run_steps(bc, root, plan, per_feature_volumes=True)
        self._apply_material(bc, root, plan.get("material"))
        bc.progress["feature"] = None
        return {"features_built": len(volumes), "feature_volumes": volumes}

    def _build_assembly(self, bc, plan):
        root = bc.design.rootComponent
        volumes, built = [], 0
        for oc in plan["occurrences"]:
            bc.progress["feature"] = oc["name"]
            bc.log("occurrence %s (part %s)" % (oc["name"], oc["part"]))
            # UNVERIFIED: the sketches below are built in component-local coordinates and
            # modelToSketchSpace is assumed to work in that same local space (not assembly space).
            m = self._matrix(oc["transform"])
            try:
                occ = root.occurrences.addNewComponent(m)
            except Exception as e:  # noqa: BLE001
                raise ExecError("addNewComponent failed: %s" % e, feature=oc["name"], step="occurrence")
            comp = occ.component
            _set_name(comp, oc["name"], bc.log)
            self._run_steps(bc, comp, oc["plan"], per_feature_volumes=False)
            self._apply_material(bc, comp, oc["plan"].get("material"))
            built += len(oc["plan"]["feature_names"])
            volumes.append({"name": oc["name"], "volume_mm3": self._volume_mm3(comp)})
        bc.progress["feature"] = None
        return {"features_built": built, "feature_volumes": volumes}

    def _matrix(self, tr):
        R, o = tr["rotation"], tr["origin"]
        m = adsk.core.Matrix3D.create()
        # The JSON rotation is rounded to 6 decimals; Fusion rejects a frame that is not orthonormal.
        x, y = geom.orthonormal_frame([R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]])
        z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]  # columns = images of the part axes
        vec = lambda c: adsk.core.Vector3D.create(c[0], c[1], c[2])
        m.setWithCoordinateSystem(adsk.core.Point3D.create(_cm(o[0]), _cm(o[1]), _cm(o[2])), vec(x), vec(y), vec(z))
        return m

    def _run_steps(self, bc, comp, plan, per_feature_volumes):
        sketches, features, volumes = {}, {}, []
        for step in plan["steps"]:
            if time.time() > bc.deadline:
                raise ExecError("job timeout exceeded", feature=step["name"], step="timeout")
            kind = step["kind"]
            bc.progress["feature"] = step["feature"] if kind == "sketch" else step["name"]
            bc.log("step %s %s" % (kind, step["name"]))
            if kind == "sketch":
                sketches[step["name"]] = self._sketch(bc, comp, step)
                continue
            if kind == "extrude":
                feat = self._with_fx(bc, step, lambda fx: self._extrude(bc, comp, step, sketches[step["sketch"]], fx))
            elif kind == "hole":
                feat = self._with_fx(bc, step, lambda fx: self._hole(bc, comp, step, sketches[step["sketch"]], fx))
            elif kind == "polar_pattern":
                feat = self._with_fx(bc, step, lambda fx: self._polar(bc, comp, step, features, fx))
            elif kind == "linear_pattern":
                feat = self._with_fx(bc, step, lambda fx: self._linear(bc, comp, step, features, fx))
            elif kind == "mirror":
                feat = self._mirror(bc, comp, step, features)
            elif kind in ("fillet", "chamfer"):
                feat = self._with_fx(bc, step, lambda fx: self._edge_feature(bc, comp, step, fx))
            else:
                raise ExecError("unknown plan step %r" % kind, feature=step.get("name"), step="plan")
            features[step["name"]] = feat
            if per_feature_volumes:
                volumes.append({"name": step["name"], "volume_mm3": self._volume_mm3(comp)})
        return volumes

    def _with_fx(self, bc, step, fn):
        """Try with parameter expressions; if Fusion rejects them, rebuild from the values + warning."""
        if not _has_fx(step):
            return fn(False)
        try:
            return fn(True)
        except Exception as e:  # noqa: BLE001
            bc.warn(step["name"], "expression", None, "Fusion rejected the parameter expression (%s); evaluated value used" % e)
            return fn(False)

    def _volume_mm3(self, comp):
        # physicalProperties.volume is cm^3 -> mm^3 (x1000). Sum over all bodies of the component.
        return sum(b.physicalProperties.volume for b in _items(comp.bRepBodies)) * 1000.0

    # ------------------------------------------------------------------ value inputs
    def _len(self, mm, fx, use_fx):
        if use_fx and fx:
            return adsk.core.ValueInput.createByString(fx)
        return adsk.core.ValueInput.createByReal(_cm(mm))

    def _ang(self, deg, fx, use_fx):
        if use_fx and fx:
            return adsk.core.ValueInput.createByString(fx)
        return adsk.core.ValueInput.createByReal(math.radians(deg))

    # ------------------------------------------------------------------ parameters / material
    def _create_parameters(self, bc, plist):
        for p in plist:
            bc.progress["feature"] = None
            if p["fx"]:
                vi = adsk.core.ValueInput.createByString(p["fx"])
            elif p["unit"] == "mm":
                vi = adsk.core.ValueInput.createByReal(_cm(p["value"]))
            elif p["unit"] == "deg":
                vi = adsk.core.ValueInput.createByReal(math.radians(p["value"]))
            else:
                vi = adsk.core.ValueInput.createByReal(p["value"])
            try:
                bc.design.userParameters.add(p["name"], vi, p["unit"], "")
            except Exception as e:  # noqa: BLE001
                raise ExecError("cannot create user parameter %r: %s" % (p["name"], e), step="parameters")
            bc.log("user parameter %s" % p["name"])

    def _apply_material(self, bc, comp, mat):
        """Set the body density through a copied library material. UNVERIFIED end to end."""
        if not mat:
            return
        try:
            base = None
            for lib in _items(self.app.materialLibraries):
                for m in _items(lib.materials):
                    if m.materialProperties.itemById("structural_Density") is not None:
                        base = m
                        break
                if base is not None:
                    break
            if base is None:
                raise RuntimeError("no library material with a density property found")
            newm = bc.design.materials.addByCopy(base, mat["name"])
            newm.materialProperties.itemById("structural_Density").value = mat["density_kg_m3"] / 1.0e6  # kg/cm^3
            for b in _items(comp.bRepBodies):
                b.material = newm
            bc.log("material %s density %s kg/m3" % (mat["name"], mat["density_kg_m3"]))
        except Exception as e:  # noqa: BLE001
            bc.warn(None, "material", None, "density not applied: %s" % e)

    # ------------------------------------------------------------------ b-rep lookups
    def _diagonal(self, comp):
        lo, hi = None, None
        for b in _items(comp.bRepBodies):
            bb = b.boundingBox
            a, c = _v3(bb.minPoint), _v3(bb.maxPoint)
            lo = a if lo is None else [min(x, y) for x, y in zip(lo, a)]
            hi = c if hi is None else [max(x, y) for x, y in zip(hi, c)]
        return 1.0 if lo is None else math.sqrt(sum((h - l) ** 2 for h, l in zip(hi, lo)))

    def _edge_candidates(self, comp):
        ents, descs = [], []
        for body in _items(comp.bRepBodies):
            for e in _items(body.edges):
                g = e.geometry  # None for edges Fusion cannot express as a curve (e.g. some seams)
                curve = _CURVE_OF.get(g.objectType) if g is not None else None
                if curve is None:
                    continue
                ev = e.evaluator
                ok, p0, p1 = ev.getParameterExtents()
                ok, mid = ev.getPointAtParameter((p0 + p1) / 2.0)
                d = {"curve": curve, "midpoint": _v3(mid), "length": _mm(e.length)}
                try:
                    d["start"], d["end"] = _v3(e.startVertex.geometry), _v3(e.endVertex.geometry)
                except Exception:  # noqa: BLE001
                    pass
                if curve in ("circle", "arc"):
                    d["centre"] = _v3(e.geometry.center)
                    d["radius"] = _mm(e.geometry.radius)
                    n = e.geometry.normal
                    d["axis"] = [n.x, n.y, n.z]
                ents.append(e)
                descs.append(d)
        return ents, descs

    def _find_face(self, comp, ref, feature):
        ents, descs = [], []
        for body in _items(comp.bRepBodies):
            for f in _items(body.faces):
                g = f.geometry
                if g.objectType != "adsk::core::Plane":
                    continue
                ents.append(f)
                descs.append({"origin": _v3(g.origin), "normal": [g.normal.x, g.normal.y, g.normal.z], "area": f.area * 100.0})
        try:
            return ents[facematch.match_face(ref, descs, self._diagonal(comp))]
        except facematch.FaceMatchError as e:
            raise ExecError("face_ref: %s" % e, feature=feature, step="face_ref")

    # ------------------------------------------------------------------ sketch
    def _p3(self, aff, u, v):
        x, y = aff.apply(u, v)
        return adsk.core.Point3D.create(_cm(x), _cm(y), 0.0)

    def _sketch(self, bc, comp, step):
        plane = step["plane"]
        if "face_ref" in plane:
            entity = self._find_face(comp, plane["face_ref"], step["feature"])
        else:
            entity = _plane_entity(comp, plane, step["name"] + "_plane", bc.log)
        sk = comp.sketches.add(entity)
        _set_name(sk, step["name"], bc.log)
        # Fusion can auto-project the edges of the face it sketches on (a preference); they would become
        # extra profiles that match no canonical loop.
        for c in [c for c in _items(sk.sketchCurves) if getattr(c, "isReference", False)]:
            try:
                c.deleteMe()
            except Exception:  # noqa: BLE001
                bc.warn(step["feature"], "sketch", None, "could not remove an auto-projected edge from sketch %r" % step["name"])

        fr = step["frame"]
        o, u, v, n = fr["origin"], fr["u"], fr["v"], fr["n"]

        def to_sketch(pt):
            p = sk.modelToSketchSpace(adsk.core.Point3D.create(_cm(pt[0]), _cm(pt[1]), _cm(pt[2])))
            return (_mm(p.x), _mm(p.y), _mm(p.z))

        def world(a, b):
            return [o[i] + a * u[i] + b * v[i] for i in range(3)]

        s0, su, sv = to_sketch(world(0, 0)), to_sketch(world(1, 0)), to_sketch(world(0, 1))
        aff = geom.Affine2.from_basis(s0[:2], su[:2], sv[:2])
        sn = to_sketch([o[i] + n[i] for i in range(3)])
        flip = 1 if (sn[2] - s0[2]) > 0 else -1  # sign of dot(fusion sketch normal, canonical n)
        ctx = {"sketch": sk, "aff": aff, "flip": flip, "step": step, "ents": {}, "points": []}

        sk.isComputeDeferred = True
        pcache = {}

        def pt(p):
            key = (round(p[0], 6), round(p[1], 6))
            if key not in pcache:
                pcache[key] = self._p3(aff, p[0], p[1])
            return pcache[key]

        curves = sk.sketchCurves
        for g in step["geometry"]:
            t = g["type"]
            if t == "line":
                ctx["ents"][g["id"]] = [curves.sketchLines.addByTwoPoints(pt(g["start"]), pt(g["end"]))]
            elif t == "polyline":
                ctx["ents"][g["id"]] = [curves.sketchLines.addByTwoPoints(pt(a), pt(b)) for a, b in geom.polyline_segments(g)]
            elif t == "circle":
                ctx["ents"][g["id"]] = [curves.sketchCircles.addByCenterRadius(pt(g["center"]), _cm(float(g["radius"])))]
            elif t == "arc":
                sweep = geom.arc_sweep(g)
                a0 = float(g["start_angle"])
                start = tuple(g["start"]) if "start" in g else geom.arc_point(g, a0)
                end = tuple(g["end"]) if "end" in g else geom.arc_point(g, a0 + sweep)
                mid = geom.arc_point(g, a0 + sweep / 2.0)
                # three-point arc is independent of the sketch handedness
                ctx["ents"][g["id"]] = [curves.sketchArcs.addByThreePoints(pt(start), pt(mid), pt(end))]
        for p in step.get("points", []):
            ctx["points"].append(sk.sketchPoints.add(pt(p)))
        sk.isComputeDeferred = False
        if step.get("dimensions"):
            self._dimensions(bc, ctx)
        return ctx

    # --- level-1 sketch dimensions
    def _sk_point(self, ctx, gid, pos):
        if gid == -1:
            return ctx["sketch"].originPoint
        ents = ctx["ents"].get(gid)
        if not ents or len(ents) != 1:
            raise RuntimeError("geometry %s cannot carry a dimension" % gid)
        e = ents[0]
        attr = {1: "startSketchPoint", 2: "endSketchPoint", 3: "centerSketchPoint"}.get(pos)
        if attr is None or not hasattr(e, attr):
            raise RuntimeError("geometry %s has no position %s" % (gid, pos))
        return getattr(e, attr)

    def _sk_entity(self, ctx, gid):
        ents = ctx["ents"].get(gid)
        if not ents or len(ents) != 1:
            raise RuntimeError("geometry %s cannot carry a dimension" % gid)
        return ents[0]

    def _orientation(self, ctx, kind):
        a = ctx["aff"]
        o = adsk.fusion.DimensionOrientations
        same = abs(a.b) < 1e-6 and abs(a.c) < 1e-6
        swapped = abs(a.a) < 1e-6 and abs(a.d) < 1e-6
        if kind == "distance":
            return o.AlignedDimensionOrientation
        if not (same or swapped):
            raise _SkipDimension("sketch axes are rotated against the canonical u/v; horizontal/vertical is undefined")
        horizontal = (kind == "distance_x") == same
        return o.HorizontalDimensionOrientation if horizontal else o.VerticalDimensionOrientation

    def _dimensions(self, bc, ctx):
        step, sk = ctx["step"], ctx["sketch"]
        dims = sk.sketchDimensions
        P = adsk.core.Point3D.create
        for d in step["dimensions"]:
            try:
                kind, refs = d["kind"], d["refs"]
                if kind in ("distance", "distance_x", "distance_y"):
                    if len(refs) == 1:
                        p1, p2 = self._sk_point(ctx, refs[0][0], 1), self._sk_point(ctx, refs[0][0], 2)
                    else:
                        p1, p2 = self._sk_point(ctx, *refs[0]), self._sk_point(ctx, *refs[1])
                    a, b = p1.geometry, p2.geometry
                    txt = P((a.x + b.x) / 2.0 + 0.5, (a.y + b.y) / 2.0 + 0.5, 0)
                    dim = dims.addDistanceDimension(p1, p2, self._orientation(ctx, kind), txt)
                elif kind in ("radius", "diameter"):
                    e = self._sk_entity(ctx, refs[0][0])
                    c = e.centerSketchPoint.geometry
                    txt = P(c.x + e.radius * 1.5, c.y + e.radius * 1.5, 0)
                    dim = dims.addRadialDimension(e, txt) if kind == "radius" else dims.addDiameterDimension(e, txt)
                else:  # angle
                    l1, l2 = self._sk_entity(ctx, refs[0][0]), self._sk_entity(ctx, refs[1][0])
                    a = l1.startSketchPoint.geometry
                    dim = dims.addAngularDimension(l1, l2, P(a.x + 0.5, a.y + 0.5, 0))
                if d.get("fx"):
                    if kind != "angle" and (d.get("value") or 0) < 0:
                        # Fusion keeps a dimension's magnitude, so a negative expression would flip the geometry.
                        bc.warn(step["feature"], "sketch.dimensions", d.get("name"),
                                "dimension %r is negative; its expression is not bound" % d["name"])
                    else:
                        dim.parameter.expression = d["fx"]
            except _SkipDimension as e:
                # Not a failure: Fusion chose sketch axes that are rotated against ours (typical on tilted faces).
                bc.warn(step["feature"], "sketch.dimensions", d.get("name"),
                        "dimension %r of sketch %r not added: %s" % (d["name"], step["name"], e))
            except Exception as e:  # noqa: BLE001
                if "OVER_CONSTRAINT" in str(e):
                    # Fusion already holds this geometry in place (for example concentric circles share their centre,
                    # and aligned rectangles inherit constraints from each other). The dimension adds nothing: the
                    # sketch is already where the canonical geometry puts it, and the equivalence check proves it.
                    bc.warn(step["feature"], "sketch.dimensions", d.get("name"),
                            "dimension %r of sketch %r is redundant: Fusion already constrains that geometry" % (d["name"], step["name"]))
                    continue
                raise ExecError("sketch %r: dimension %r (%s) failed: %s" % (step["name"], d["name"], d["kind"], e),
                                feature=step["feature"], step="dimension")

    # ------------------------------------------------------------------ profiles
    def _profile_points_uv(self, profile, ctx, interpretation):
        sk, aff = ctx["sketch"], ctx["aff"]
        inv = aff.inverse()
        outer = [lp for lp in _items(profile.profileLoops) if lp.isOuter]
        if len(outer) != 1:
            raise ExecError("profile has %d outer loops" % len(outer), step="profile")
        pts = []
        for pc in _items(outer[0].profileCurves):
            ev = pc.geometry.evaluator
            ok, p0, p1 = ev.getParameterExtents()
            for i in range(SAMPLES_PER_CURVE):
                ok, p = ev.getPointAtParameter(p0 + (p1 - p0) * i / (SAMPLES_PER_CURVE - 1.0))
                if interpretation == "model":
                    p = sk.modelToSketchSpace(p)
                pts.append(inv.apply(_mm(p.x), _mm(p.y)))
        return pts

    def _select_profiles(self, ctx, log):
        step = ctx["step"]
        profs = _items(ctx["sketch"].profiles)
        geometry = {g["id"]: g for g in step["geometry"]}
        last = None
        # UNVERIFIED: ProfileCurve.geometry is in sketch space. Fall back to model space if no match.
        for interp in ("sketch", "model"):
            try:
                pts = [self._profile_points_uv(p, ctx, interp) for p in profs]
                idx = profiles.select_profiles(step["loops"], geometry, pts)
                if interp == "model":
                    log("WARN profile curve geometry was in MODEL space, not sketch space (assumption failed)")
                log("sketch %s: %d profiles, selected %s" % (step["name"], len(profs), idx))
                return [profs[i] for i in idx]
            except profiles.ProfileMatchError as e:
                last = e
        raise ExecError("profile selection failed: %s" % last, feature=step["feature"], step="profile")

    def _direction(self, step, ctx):
        positive = (step["direction_sign"] * ctx["flip"]) > 0
        d = adsk.fusion.ExtentDirections
        return d.PositiveExtentDirection if positive else d.NegativeExtentDirection

    # ------------------------------------------------------------------ extrude
    def _extrude(self, bc, comp, step, ctx, use_fx):
        selected = self._select_profiles(ctx, bc.log)
        coll = adsk.core.ObjectCollection.create()
        for p in selected:
            coll.add(p)
        ops = {"new_body": adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
               "join": adsk.fusion.FeatureOperations.JoinFeatureOperation,
               "cut": adsk.fusion.FeatureOperations.CutFeatureOperation}
        inp = comp.features.extrudeFeatures.createInput(coll, ops[step["operation"]])
        d = adsk.fusion.ExtentDirections
        direction = self._direction(step, ctx)
        ext = step["extent"]
        if ext["type"] == "all":
            inp.setAllExtent(d.SymmetricExtentDirection if step["midplane"] else direction)
        elif ext["type"] == "to_face":
            face = self._find_face(comp, ext["face_ref"], step["name"])
            # ExtrudeFeatureInput has no setOneSideToExtent (only holes and revolves do): use the extent definition.
            inp.setOneSideExtent(adsk.fusion.ToEntityExtentDefinition.create(face, False), direction)
        else:
            # Level 1 uses the evaluated value; level 2 (use_fx) binds the Reify expression through
            # user parameters. createByReal is in cm (locale independent).
            dist = self._len(ext["distance_mm"], ext.get("fx"), use_fx)
            if step["midplane"]:
                inp.setSymmetricExtent(dist, True)  # total length, like FreeCAD Midplane
            else:
                inp.setOneSideExtent(adsk.fusion.DistanceExtentDefinition.create(dist), direction)
        try:
            feat = comp.features.extrudeFeatures.add(inp)
        except Exception as e:  # noqa: BLE001
            raise ExecError("extrude failed: %s" % e, feature=step["name"], step="extrude")
        _set_name(feat, step["name"], bc.log)
        return feat

    # ------------------------------------------------------------------ native hole
    def _hole(self, bc, comp, step, ctx, use_fx):
        holes = comp.features.holeFeatures
        dvi = self._len(step["diameter_mm"], step.get("diameter_fx"), use_fx)
        ht = step["hole_type"]
        try:
            if ht == "counterbore":
                cb = step["counterbore"]
                inp = holes.createCounterboreInput(dvi, self._len(cb["diameter_mm"], cb.get("diameter_fx"), use_fx),
                                                   self._len(cb["depth_mm"], cb.get("depth_fx"), use_fx))
            elif ht == "countersink":
                cs = step["countersink"]
                inp = holes.createCountersinkInput(dvi, self._len(cs["diameter_mm"], cs.get("diameter_fx"), use_fx),
                                                   self._ang(cs["angle_deg"], cs.get("angle_fx"), use_fx))
            else:
                inp = holes.createSimpleInput(dvi)
            coll = adsk.core.ObjectCollection.create()
            for p in ctx["points"]:
                coll.add(p)
            inp.setPositionBySketchPoints(coll)
            ext = step["extent"]
            # Verified in Fusion 2705: a hole's default direction is opposite to the sketch normal,
            # and PositiveExtentDirection means that default direction (not the normal's).
            against_normal = (step["direction_sign"] * ctx["flip"]) < 0
            if ext["type"] == "all":
                d = adsk.fusion.ExtentDirections
                inp.setAllExtent(d.PositiveExtentDirection if against_normal else d.NegativeExtentDirection)
            else:
                inp.setDistanceExtent(self._len(ext["distance_mm"], ext.get("fx"), use_fx))
                inp.isDefaultDirection = against_normal
            dp = step.get("drill_point")
            if dp:
                # Verified in Fusion 2705: a flat bottom is tipAngle 180 deg (0 is rejected); angled is the cone angle.
                tip = 180.0 if dp["type"] == "flat" else dp["angle_deg"]
                inp.tipAngle = adsk.core.ValueInput.createByReal(math.radians(tip))
            feat = holes.add(inp)
        except Exception as e:  # noqa: BLE001
            raise ExecError("hole failed: %s" % e, feature=step["name"], step="hole")
        _set_name(feat, step["name"], bc.log)
        return feat

    # ------------------------------------------------------------------ patterns / mirror
    def _collect(self, names, features):
        coll = adsk.core.ObjectCollection.create()
        for o in names:
            coll.add(features[o])
        return coll

    def _polar(self, bc, comp, step, features, use_fx):
        axis = getattr(comp, _BASE_AXES[step["axis"]["name"]])
        inp = comp.features.circularPatternFeatures.createInput(self._collect(step["originals"], features), axis)
        inp.quantity = adsk.core.ValueInput.createByReal(step["quantity"])
        if use_fx and step.get("angle_fx") and step["axis"]["sign"] > 0:
            inp.totalAngle = adsk.core.ValueInput.createByString(step["angle_fx"])
        else:
            inp.totalAngle = adsk.core.ValueInput.createByReal(math.radians(step["angle_deg"] * step["axis"]["sign"]))
        inp.isSymmetric = False
        try:
            feat = comp.features.circularPatternFeatures.add(inp)
        except Exception as e:  # noqa: BLE001
            raise ExecError("polar pattern failed: %s" % e, feature=step["name"], step="pattern")
        _set_name(feat, step["name"], bc.log)
        return feat

    def _linear(self, bc, comp, step, features, use_fx):
        axis = getattr(comp, _BASE_AXES[step["axis"]["name"]])
        sign = step["axis"]["sign"]
        if use_fx and step.get("spacing_fx"):
            dist = adsk.core.ValueInput.createByString(step["spacing_fx"] if sign > 0 else "-(%s)" % step["spacing_fx"])
        else:
            dist = adsk.core.ValueInput.createByReal(_cm(step["spacing_mm"]) * sign)  # negative = against the axis
        try:
            inp = comp.features.rectangularPatternFeatures.createInput(
                self._collect(step["originals"], features), axis,
                adsk.core.ValueInput.createByReal(step["quantity"]), dist,
                adsk.fusion.PatternDistanceType.SpacingPatternDistanceType)
            feat = comp.features.rectangularPatternFeatures.add(inp)
        except Exception as e:  # noqa: BLE001
            raise ExecError("linear pattern failed: %s" % e, feature=step["name"], step="pattern")
        _set_name(feat, step["name"], bc.log)
        return feat

    def _mirror(self, bc, comp, step, features):
        plane = _plane_entity(comp, step["plane"], step["name"] + "_plane", bc.log)
        try:
            inp = comp.features.mirrorFeatures.createInput(self._collect(step["originals"], features), plane)
            feat = comp.features.mirrorFeatures.add(inp)
        except Exception as e:  # noqa: BLE001
            raise ExecError("mirror failed: %s" % e, feature=step["name"], step="mirror")
        _set_name(feat, step["name"], bc.log)
        return feat

    # ------------------------------------------------------------------ fillet / chamfer
    def _edge_feature(self, bc, comp, step, use_fx):
        ents, descs = self._edge_candidates(comp)
        diag = self._diagonal(comp)
        coll = adsk.core.ObjectCollection.create()
        seen = set()
        for i, ref in enumerate(step["edges"]):
            try:
                idx = edgematch.match_edge(ref, descs, diag)
            except edgematch.EdgeMatchError as e:
                raise ExecError("edge %d: %s" % (i, e), feature=step["name"], step="edge_ref")
            if idx in seen:
                raise ExecError("edge %d resolves to the same edge as an earlier reference" % i, feature=step["name"], step="edge_ref")
            seen.add(idx)
            coll.add(ents[idx])
        size = self._len(step["size_mm"], step.get("fx"), use_fx)
        try:
            if step["kind"] == "fillet":
                inp = comp.features.filletFeatures.createInput()
                inp.addConstantRadiusEdgeSet(coll, size, False)  # isTangentChain False: refs are explicit
                feat = comp.features.filletFeatures.add(inp)
            else:
                inp = comp.features.chamferFeatures.createInput2()
                inp.chamferEdgeSets.addEqualDistanceChamferEdgeSet(coll, size, False)
                feat = comp.features.chamferFeatures.add(inp)
        except Exception as e:  # noqa: BLE001
            raise ExecError("%s failed: %s" % (step["kind"], e), feature=step["name"], step=step["kind"])
        _set_name(feat, step["name"], bc.log)
        return feat

    # ------------------------------------------------------------------ export
    def _export(self, design, root, outbox, native, check_step, log):
        em = design.exportManager
        f3d = os.path.join(outbox, native)
        try:
            em.execute(em.createFusionArchiveExportOptions(f3d))
        except Exception as e:  # noqa: BLE001
            raise ExecError("f3d export failed: %s" % e, step="export")
        if check_step:
            stp = os.path.join(outbox, check_step)
            try:
                em.execute(em.createSTEPExportOptions(stp, root))  # root = whole assembly
            except Exception as e:  # noqa: BLE001
                raise ExecError("STEP export failed: %s" % e, step="export")
        for p in [f3d] + ([os.path.join(outbox, check_step)] if check_step else []):
            if not os.path.isfile(p) or os.path.getsize(p) == 0:
                raise ExecError("export produced no file %s" % os.path.basename(p), step="export")
        log("exported %s%s" % (native, " + " + check_step if check_step else ""))
