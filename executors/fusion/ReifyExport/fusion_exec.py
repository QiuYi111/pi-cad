"""Thin Fusion API layer. Executes a plan built by plan.py.

All decisions live in plan.py / profiles.py / geom.py. This file must only be called on the
Fusion MAIN thread (from the custom event handler). Units: the Fusion API works in cm,
the plan in mm; every conversion is done in `_cm()` / `_mm()`.

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

import geom
import profiles
from jobs import ExecError

SAMPLES_PER_CURVE = 9
_BASE_PLANES = {"XY": "xYConstructionPlane", "XZ": "xZConstructionPlane", "YZ": "yZConstructionPlane"}
_BASE_AXES = {"X": "xConstructionAxis", "Y": "yConstructionAxis", "Z": "zConstructionAxis"}
_AXIS_VEC = {"Z": (0.0, 0.0, 1.0), "Y": (0.0, 1.0, 0.0), "X": (1.0, 0.0, 0.0)}


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
            return self._build(design, plan, outbox, native, check_step, log, deadline, progress)
        finally:
            if doc is not None:
                try:
                    doc.close(False)  # False = do not save; the doc was never saved anywhere
                    log("document closed without saving")
                except Exception as e:  # noqa: BLE001
                    log("WARN doc.close(False) failed: %s" % e)

    # ------------------------------------------------------------------ build
    def _build(self, design, plan, outbox, native, check_step, log, deadline, progress):
        root = design.rootComponent
        sketches = {}   # sketch step name -> context dict
        features = {}   # reify feature name -> Fusion feature
        volumes = []
        for step in plan["steps"]:
            if time.time() > deadline:
                raise ExecError("job timeout exceeded", feature=step["name"], step="timeout")
            kind = step["kind"]
            progress["feature"] = step["feature"] if kind == "sketch" else step["name"]
            log("step %s %s" % (kind, step["name"]))
            if kind == "sketch":
                sketches[step["name"]] = self._sketch(root, step, log)
            elif kind == "extrude":
                features[step["name"]] = self._extrude(root, step, sketches[step["sketch"]], log)
                volumes.append({"name": step["name"], "volume_mm3": self._volume_mm3(root)})
            elif kind == "polar_pattern":
                features[step["name"]] = self._pattern(root, step, features, log)
                volumes.append({"name": step["name"], "volume_mm3": self._volume_mm3(root)})
            else:
                raise ExecError("unknown plan step %r" % kind, feature=step.get("name"), step="plan")
        progress["feature"] = None
        self._export(design, root, outbox, native, check_step, log)
        return {"features_built": len(volumes), "feature_volumes": volumes}

    def _volume_mm3(self, root):
        # physicalProperties.volume is cm^3 -> mm^3 (x1000). Sum over all bodies in the root.
        return sum(b.physicalProperties.volume for b in _items(root.bRepBodies)) * 1000.0

    # ------------------------------------------------------------------ sketch
    def _p3(self, aff, u, v):
        x, y = aff.apply(u, v)
        return adsk.core.Point3D.create(_cm(x), _cm(y), 0.0)

    def _sketch(self, root, step, log):
        plane = step["plane"]
        base = getattr(root, _BASE_PLANES[plane["base"]])
        entity = base
        if abs(plane["offset_mm"]) > 1e-9:
            # Offset sign is relative to the world axis; Fusion's plane normal may be the opposite.
            nrm = base.geometry.normal
            s = nrm.x * _AXIS_VEC[plane["axis"]][0] + nrm.y * _AXIS_VEC[plane["axis"]][1] + nrm.z * _AXIS_VEC[plane["axis"]][2]
            signed = plane["offset_mm"] * (1.0 if s >= 0 else -1.0)
            cin = root.constructionPlanes.createInput()
            cin.setByOffset(base, adsk.core.ValueInput.createByReal(_cm(signed)))
            entity = root.constructionPlanes.add(cin)
            _set_name(entity, step["name"] + "_plane", log)
        sk = root.sketches.add(entity)
        _set_name(sk, step["name"], log)

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
        ctx = {"sketch": sk, "aff": aff, "flip": flip, "step": step}

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
                curves.sketchLines.addByTwoPoints(pt(g["start"]), pt(g["end"]))
            elif t == "polyline":
                for a, b in geom.polyline_segments(g):
                    curves.sketchLines.addByTwoPoints(pt(a), pt(b))
            elif t == "circle":
                curves.sketchCircles.addByCenterRadius(pt(g["center"]), _cm(float(g["radius"])))
            elif t == "arc":
                sweep = geom.arc_sweep(g)
                a0 = float(g["start_angle"])
                start = tuple(g["start"]) if "start" in g else geom.arc_point(g, a0)
                end = tuple(g["end"]) if "end" in g else geom.arc_point(g, a0 + sweep)
                mid = geom.arc_point(g, a0 + sweep / 2.0)
                # three-point arc is independent of the sketch handedness
                curves.sketchArcs.addByThreePoints(pt(start), pt(mid), pt(end))
        sk.isComputeDeferred = False
        return ctx

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

    # ------------------------------------------------------------------ extrude
    def _extrude(self, root, step, ctx, log):
        selected = self._select_profiles(ctx, log)
        coll = adsk.core.ObjectCollection.create()
        for p in selected:
            coll.add(p)
        ops = {"new_body": adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
               "join": adsk.fusion.FeatureOperations.JoinFeatureOperation,
               "cut": adsk.fusion.FeatureOperations.CutFeatureOperation}
        inp = root.features.extrudeFeatures.createInput(coll, ops[step["operation"]])
        # Direction in Fusion terms: canonical sign x handedness flip of the real sketch normal.
        positive = (step["direction_sign"] * ctx["flip"]) > 0
        d = adsk.fusion.ExtentDirections
        direction = d.PositiveExtentDirection if positive else d.NegativeExtentDirection
        ext = step["extent"]
        if ext["type"] == "all":
            inp.setAllExtent(d.SymmetricExtentDirection if step["midplane"] else direction)
        else:
            # Level 1: evaluated value, not the Reify `expr`. Using `expr` (a user parameter) is a
            # later step: it needs Reify params mapped to Fusion user parameters.
            dist = adsk.core.ValueInput.createByReal(_cm(ext["distance_mm"]))  # cm, locale independent
            if step["midplane"]:
                inp.setSymmetricExtent(dist, True)  # total length, like FreeCAD Midplane
            else:
                inp.setOneSideExtent(adsk.fusion.DistanceExtentDefinition.create(dist), direction)
        try:
            feat = root.features.extrudeFeatures.add(inp)
        except Exception as e:  # noqa: BLE001
            raise ExecError("extrude failed: %s" % e, feature=step["name"], step="extrude")
        _set_name(feat, step["name"], log)
        return feat

    # ------------------------------------------------------------------ pattern
    def _pattern(self, root, step, features, log):
        coll = adsk.core.ObjectCollection.create()
        for o in step["originals"]:
            coll.add(features[o])
        axis = getattr(root, _BASE_AXES[step["axis"]["name"]])
        inp = root.features.circularPatternFeatures.createInput(coll, axis)
        inp.quantity = adsk.core.ValueInput.createByReal(step["quantity"])
        inp.totalAngle = adsk.core.ValueInput.createByReal(math.radians(step["angle_deg"] * step["axis"]["sign"]))
        inp.isSymmetric = False
        try:
            feat = root.features.circularPatternFeatures.add(inp)
        except Exception as e:  # noqa: BLE001
            raise ExecError("polar pattern failed: %s" % e, feature=step["name"], step="pattern")
        _set_name(feat, step["name"], log)
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
                em.execute(em.createSTEPExportOptions(stp, root))
            except Exception as e:  # noqa: BLE001
                raise ExecError("STEP export failed: %s" % e, step="export")
        for p in [f3d] + ([os.path.join(outbox, check_step)] if check_step else []):
            if not os.path.isfile(p) or os.path.getsize(p) == 0:
                raise ExecError("export produced no file %s" % os.path.basename(p), step="export")
        log("exported %s%s" % (native, " + " + check_step if check_step else ""))
