"""A minimal fake of the parts of adsk.core / adsk.fusion that fusion_exec.py uses.

WHAT THIS CATCHES: typos in attribute/method names we call, wrong call ORDER (document before
sketch, sketch before extrude, export before close, close(False)), unit conversions (cm vs mm),
sign handling for flipped Fusion planes, even-odd profile selection end to end, plan -> executor
wiring and error mapping.

WHAT THIS CANNOT CATCH: whether the real Fusion API has the members we assume, real parameter
types/overloads, real profile generation (the fake makes one profile per closed loop with only an
OUTER loop), real timeline behaviour, name restrictions, locale/units behaviour, STEP/F3D content,
and the real orientation of origin planes (the fake lets tests choose). Every member used here was
written from documentation, not from a running Fusion.
"""
import math
import sys
import types


def _r(x):
    return round(x, 6)


class Point3D(object):
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z

    @staticmethod
    def create(x, y, z):
        return Point3D(x, y, z)


class Vector3D(Point3D):
    pass


class ValueInput(object):
    def __init__(self, v):
        self.value = v

    @staticmethod
    def createByReal(v):
        return ValueInput(v)


class ObjectCollection(object):
    def __init__(self):
        self._l = []

    @staticmethod
    def create():
        return ObjectCollection()

    def add(self, o):
        self._l.append(o)

    @property
    def count(self):
        return len(self._l)

    def item(self, i):
        return self._l[i]


class _Enum(object):
    def __init__(self, *names):
        for n in names:
            setattr(self, n, n)


class Named(object):
    reject_slash = False

    def __setattr__(self, k, v):
        if k == "name" and "/" in v and FakeApp.current.reject_slash:
            raise RuntimeError("invalid name")
        object.__setattr__(self, k, v)


class Plane(Named):
    def __init__(self, normal, origin=(0, 0, 0), xdir=None, ydir=None, label=""):
        self.normal_t = normal
        self.origin_t = origin
        self.xdir, self.ydir = xdir, ydir
        self.label = label
        self.geometry = types.SimpleNamespace(normal=Vector3D(*normal))


class PlaneInput(object):
    def setByOffset(self, base, vi):
        n = base.normal_t
        d = vi.value  # cm along base normal
        self.plane = Plane(n, tuple(base.origin_t[i] + n[i] * d for i in range(3)), base.xdir, base.ydir)
        self.offset_cm = d


class ConstructionPlanes(object):
    def __init__(self, app):
        self.app = app

    def createInput(self):
        return PlaneInput()

    def add(self, inp):
        self.app.log.append("constructionPlane offset_cm=%s" % inp.offset_cm)
        self.app.planes.append(inp)
        return inp.plane


class _Curves(object):
    def __init__(self, sk):
        self.sketchLines = types.SimpleNamespace(addByTwoPoints=sk._line)
        self.sketchCircles = types.SimpleNamespace(addByCenterRadius=sk._circle)
        self.sketchArcs = types.SimpleNamespace(addByThreePoints=sk._arc)


class Sketch(Named):
    def __init__(self, app, plane):
        self.app = app
        self.plane = plane
        self.lines, self.circles, self.arcs = [], [], []
        self._deferred = False
        self.sketchCurves = _Curves(self)
        self.app.log.append("sketch.add")

    @property
    def isComputeDeferred(self):
        return self._deferred

    @isComputeDeferred.setter
    def isComputeDeferred(self, v):
        self._deferred = v

    def modelToSketchSpace(self, p):
        o, n = self.plane.origin_t, self.plane.normal_t
        x, y = self.plane.xdir, self.plane.ydir
        d = (p.x - o[0], p.y - o[1], p.z - o[2])
        dot = lambda a, b: sum(i * j for i, j in zip(a, b))
        return Point3D(dot(d, x), dot(d, y), dot(d, n))

    def _line(self, a, b):
        self._chk(a, b)
        self.lines.append((a, b))

    def _circle(self, c, r):
        self._chk(c)
        assert r > 0
        self.circles.append((c, r))

    def _arc(self, s, m, e):
        self._chk(s, m, e)
        self.arcs.append((s, m, e))

    def _chk(self, *pts):
        assert self._deferred, "curves must be drawn while compute is deferred"
        for p in pts:
            assert isinstance(p, Point3D) and abs(p.z) < 1e-12

    @property
    def profiles(self):
        assert not self._deferred
        return _Coll(self._make_profiles())

    # --- crude profile generation: one profile (outer loop only) per closed loop
    def _make_profiles(self):
        out = []
        for c, r in self.circles:
            out.append(_Profile([_Curve(("circle", (c.x, c.y), r))]))
        segs = [("line", (a.x, a.y), (b.x, b.y)) for a, b in self.lines]
        segs += [("arc",) + _arc3(s, m, e) for s, m, e in self.arcs]
        used = [False] * len(segs)
        ends = lambda sg: (sg[1], sg[2])
        for i in range(len(segs)):
            if used[i]:
                continue
            loop = [segs[i]]
            used[i] = True
            start, cur = ends(segs[i])[0], ends(segs[i])[1]
            while _r(cur[0]) != _r(start[0]) or _r(cur[1]) != _r(start[1]):
                nxt = None
                for j in range(len(segs)):
                    if used[j]:
                        continue
                    a, b = ends(segs[j])
                    if (_r(a[0]), _r(a[1])) == (_r(cur[0]), _r(cur[1])):
                        nxt, cur2 = j, b
                        break
                    if (_r(b[0]), _r(b[1])) == (_r(cur[0]), _r(cur[1])):
                        nxt, cur2 = j, a
                        break
                assert nxt is not None, "fake sketch: open loop"
                used[nxt] = True
                loop.append(segs[nxt])
                cur = cur2
            out.append(_Profile([_Curve(s) for s in loop]))
        return out


def _arc3(s, m, e):
    (x1, y1), (x2, y2), (x3, y3) = (s.x, s.y), (m.x, m.y), (e.x, e.y)
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
    uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d
    r = math.hypot(x1 - ux, y1 - uy)
    a1, a2, a3 = (math.atan2(y - uy, x - ux) for (x, y) in ((x1, y1), (x2, y2), (x3, y3)))
    ccw = ((a2 - a1) % (2 * math.pi)) < ((a3 - a1) % (2 * math.pi))
    sweep = (a3 - a1) % (2 * math.pi) if ccw else -((a1 - a3) % (2 * math.pi))
    return ((x1, y1), (x3, y3), (ux, uy), r, a1, sweep)


class _Coll(object):
    def __init__(self, l):
        self.l = l

    @property
    def count(self):
        return len(self.l)

    def item(self, i):
        return self.l[i]


class _Evaluator(object):
    def __init__(self, spec):
        self.s = spec

    def getParameterExtents(self):
        return True, 0.0, 1.0

    def getPointAtParameter(self, t):
        s = self.s
        if s[0] == "line":
            a, b = s[1], s[2]
            return True, Point3D(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0)
        if s[0] == "circle":
            (cx, cy), r = s[1], s[2]
            ang = 2 * math.pi * t
            return True, Point3D(cx + r * math.cos(ang), cy + r * math.sin(ang), 0)
        # arc: ("arc", start, end, center, r, a0, sweep)
        (cx, cy), r, a0, sw = s[3], s[4], s[5], s[6]
        ang = a0 + sw * t
        return True, Point3D(cx + r * math.cos(ang), cy + r * math.sin(ang), 0)


class _Curve(object):
    def __init__(self, spec):
        self.geometry = types.SimpleNamespace(evaluator=_Evaluator(spec))


class _Profile(object):
    def __init__(self, curves):
        loop = types.SimpleNamespace(isOuter=True, profileCurves=_Coll(curves))
        self.profileLoops = _Coll([loop])


class Sketches(object):
    def __init__(self, app):
        self.app = app

    def add(self, plane):
        assert isinstance(plane, Plane)
        return Sketch(self.app, plane)


class ExtrudeInput(object):
    def __init__(self, profiles, op):
        self.profiles, self.op = profiles, op
        self.extent = None

    def setOneSideExtent(self, edef, direction, taper=None):
        self.extent = ("one_side", edef.distance.value, direction)

    def setSymmetricExtent(self, vi, full):
        self.extent = ("symmetric", vi.value, full)

    def setAllExtent(self, direction):
        self.extent = ("all", None, direction)


class _Feature(Named):
    pass


class ExtrudeFeatures(object):
    def __init__(self, app):
        self.app = app

    def createInput(self, coll, op):
        assert isinstance(coll, ObjectCollection) and coll.count > 0
        return ExtrudeInput(coll, op)

    def add(self, inp):
        assert inp.extent is not None, "extent not set"
        f = _Feature()
        f.input = inp
        self.app.features.append(f)
        self.app.log.append("extrude %s" % inp.op)
        return f


class PatternInput(object):
    def __init__(self, ents, axis):
        self.entities, self.axis = ents, axis
        self.quantity = self.totalAngle = None
        self.isSymmetric = None


class PatternFeatures(object):
    def __init__(self, app):
        self.app = app

    def createInput(self, ents, axis):
        for i in range(ents.count):
            assert isinstance(ents.item(i), _Feature)
        return PatternInput(ents, axis)

    def add(self, inp):
        assert inp.quantity is not None and inp.totalAngle is not None
        f = _Feature()
        f.input = inp
        self.app.features.append(f)
        self.app.log.append("pattern")
        return f


class Body(object):
    def __init__(self, app):
        self.app = app

    @property
    def physicalProperties(self):
        return types.SimpleNamespace(volume=0.5 * len(self.app.features))  # fake: 0.5 cm3 per feature


class Root(object):
    def __init__(self, app):
        self.app = app
        s = -1 if app.flip_xy else 1
        # XY: normal +/-Z. XZ: normal -Y (x=X, y=Z). YZ: normal +X (x=Y, y=Z).
        self.xYConstructionPlane = Plane((0, 0, s), xdir=(1, 0, 0), ydir=(0, s, 0), label="XY")
        self.xZConstructionPlane = Plane((0, -1, 0), xdir=(1, 0, 0), ydir=(0, 0, 1), label="XZ")
        self.yZConstructionPlane = Plane((1, 0, 0), xdir=(0, 1, 0), ydir=(0, 0, 1), label="YZ")
        self.xConstructionAxis = types.SimpleNamespace(label="X")
        self.yConstructionAxis = types.SimpleNamespace(label="Y")
        self.zConstructionAxis = types.SimpleNamespace(label="Z")
        self.constructionPlanes = ConstructionPlanes(app)
        self.sketches = Sketches(app)
        self.features = types.SimpleNamespace(extrudeFeatures=ExtrudeFeatures(app),
                                              circularPatternFeatures=PatternFeatures(app))

    @property
    def bRepBodies(self):
        return _Coll([Body(self.app)] if self.app.features else [])


class ExportManager(object):
    def __init__(self, app):
        self.app = app

    def createFusionArchiveExportOptions(self, path):
        return types.SimpleNamespace(kind="f3d", path=path)

    def createSTEPExportOptions(self, path, comp):
        assert comp is self.app.design.rootComponent
        return types.SimpleNamespace(kind="step", path=path)

    def execute(self, opts):
        assert not self.app.closed, "export after close"
        self.app.log.append("export " + opts.kind)
        if not (self.app.fail_step and opts.kind == "step"):
            with open(opts.path, "w") as fh:
                fh.write("fake " + opts.kind)


class Design(object):
    def __init__(self, app):
        self.app = app
        self.designType = None
        self.fusionUnitsManager = types.SimpleNamespace(distanceDisplayUnits=None)
        self.rootComponent = Root(app)
        self.exportManager = ExportManager(app)


class Doc(object):
    def __init__(self, app):
        self.app = app

    def close(self, save):
        self.app.log.append("close save=%s" % save)
        self.app.closed = True
        self.app.close_args = save


class FakeApp(object):
    current = None

    def __init__(self, flip_xy=False, reject_slash=False, fail_step=False):
        self.flip_xy, self.reject_slash, self.fail_step = flip_xy, reject_slash, fail_step
        self.log, self.features, self.planes = [], [], []
        self.closed = False
        self.close_args = None
        self.version = "2.0.test"
        self.design = None
        self.activeProduct = None
        self.preferences = types.SimpleNamespace(generalPreferences=types.SimpleNamespace(defaultModelingOrientation="Y"))
        app = self
        self.documents = types.SimpleNamespace(add=lambda t: app._add(t))
        FakeApp.current = self

    def _add(self, doctype):
        assert doctype == "FusionDesignDocumentType"
        self.log.append("documents.add orient=%s" % self.preferences.generalPreferences.defaultModelingOrientation)
        self.design = Design(self)
        self.activeProduct = self.design
        return Doc(self)


def install(**kw):
    """Install fake adsk modules into sys.modules; return the FakeApp. Call uninstall() after."""
    app = FakeApp(**kw)
    core = types.ModuleType("adsk.core")
    core.Point3D, core.Vector3D, core.ValueInput, core.ObjectCollection = Point3D, Vector3D, ValueInput, ObjectCollection
    core.Application = types.SimpleNamespace(get=lambda: app)
    core.DocumentTypes = _Enum("FusionDesignDocumentType")
    core.DefaultModelingOrientations = _Enum("ZUpModelingOrientation", "YUpModelingOrientation")
    fus = types.ModuleType("adsk.fusion")
    fus.Design = types.SimpleNamespace(cast=lambda x: x)
    fus.DesignTypes = _Enum("ParametricDesignType", "DirectDesignType")
    fus.DistanceUnits = _Enum("MillimeterDistanceUnits")
    fus.FeatureOperations = _Enum("NewBodyFeatureOperation", "JoinFeatureOperation", "CutFeatureOperation")
    fus.ExtentDirections = _Enum("PositiveExtentDirection", "NegativeExtentDirection", "SymmetricExtentDirection")
    fus.DistanceExtentDefinition = types.SimpleNamespace(create=lambda vi: types.SimpleNamespace(distance=vi))
    pkg = types.ModuleType("adsk")
    pkg.core, pkg.fusion = core, fus
    sys.modules.update({"adsk": pkg, "adsk.core": core, "adsk.fusion": fus})
    return app


def uninstall():
    for k in ("adsk", "adsk.core", "adsk.fusion", "fusion_exec"):
        sys.modules.pop(k, None)
