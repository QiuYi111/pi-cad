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

P2/P3 additions: user parameters (recorded, expression strings are NOT evaluated), sketch dimensions
(recorded), hole/fillet/chamfer/rectangular-pattern/mirror features (recorded, no geometry), occurrences
(a component per addNewComponent, transform recorded, never applied), materials, and a BRep that the
TEST supplies (app.brep_edges / app.brep_faces) because the fake has no solid modelling. The fake does
not know that a feature changed the body, so edge/face matching is only as real as the test fixture.
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
    text = None

    def __init__(self, v):
        self.value = v

    @staticmethod
    def createByReal(v):
        return ValueInput(v)

    @staticmethod
    def createByString(t):
        assert isinstance(t, str)
        v = ValueInput(None)
        v.text = t
        return v


class Matrix3D(object):
    @staticmethod
    def create():
        return Matrix3D()

    def setWithCoordinateSystem(self, origin, x, y, z):
        self.origin, self.axes = origin, (x, y, z)


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


class Face(Plane):
    """Planar BRep face (also usable as a sketch plane). Built by make_plane_face()."""


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
        self.count = 0  # no auto-projected (reference) curves in the fake


class SkPoint(object):
    def __init__(self, x, y, z=0.0):
        self.geometry = Point3D(x, y, z)


class SkLine(object):
    def __init__(self, a, b):
        self.startSketchPoint, self.endSketchPoint = SkPoint(a.x, a.y), SkPoint(b.x, b.y)


class SkCircle(object):
    def __init__(self, c, r):
        self.centerSketchPoint, self.radius = SkPoint(c.x, c.y), r


class SkArc(object):
    def __init__(self, s, m, e):
        sp, ep, c, r, _a, _sw = _arc3(s, m, e)
        self.startSketchPoint, self.endSketchPoint = SkPoint(*sp), SkPoint(*ep)
        self.centerSketchPoint, self.radius = SkPoint(*c), r


class Dim(object):
    def __init__(self, kind, *args):
        self.kind, self.args = kind, args
        self.parameter = types.SimpleNamespace(expression=None)


class Sketch(Named):
    def __init__(self, app, plane):
        self.app = app
        self.plane = plane
        self.lines, self.circles, self.arcs = [], [], []
        self.dims, self.points = [], []
        self.originPoint = SkPoint(0, 0)
        self.sketchPoints = types.SimpleNamespace(add=self._point)
        self.sketchDimensions = types.SimpleNamespace(
            addDistanceDimension=lambda p1, p2, orient, txt: self._dim("distance", p1, p2, orient),
            addRadialDimension=lambda e, txt: self._dim("radius", e),
            addDiameterDimension=lambda e, txt: self._dim("diameter", e),
            addAngularDimension=lambda a, b, txt: self._dim("angle", a, b))
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
        return SkLine(a, b)

    def _circle(self, c, r):
        self._chk(c)
        assert r > 0
        self.circles.append((c, r))
        return SkCircle(c, r)

    def _arc(self, s, m, e):
        self._chk(s, m, e)
        self.arcs.append((s, m, e))
        return SkArc(s, m, e)

    def _point(self, p):
        self._chk(p)
        sp = SkPoint(p.x, p.y)
        self.points.append(sp)
        return sp

    def _dim(self, kind, *args):
        assert not self._deferred
        d = Dim(kind, *args)
        self.dims.append(d)
        return d

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
        assert hasattr(plane, "normal_t")
        sk = Sketch(self.app, plane)
        self.app.all_sketches.append(sk)
        return sk


def _val(vi):
    """Plain number for createByReal inputs, the ValueInput itself for expression inputs."""
    return vi if vi.text is not None else vi.value


class ExtrudeInput(object):
    def __init__(self, profiles, op):
        self.profiles, self.op = profiles, op
        self.extent = None

    def setOneSideExtent(self, edef, direction, taper=None):
        if hasattr(edef, "entity"):  # ToEntityExtentDefinition (the real ExtrudeFeatureInput has no setOneSideToExtent)
            assert isinstance(edef.entity, Face)
            self.extent = ("to_face", edef.entity, direction)
            return
        self.extent = ("one_side", _val(edef.distance), direction)

    def setSymmetricExtent(self, vi, full):
        self.extent = ("symmetric", _val(vi), full)

    def setAllExtent(self, direction):
        self.extent = ("all", None, direction)


class _Feature(Named):
    pass


class ExtrudeFeatures(object):
    def __init__(self, app, comp):
        self.app, self.comp = app, comp

    def createInput(self, coll, op):
        assert isinstance(coll, ObjectCollection) and coll.count > 0
        return ExtrudeInput(coll, op)

    def add(self, inp):
        assert inp.extent is not None, "extent not set"
        f = _Feature()
        f.input = inp
        self.comp.feature_list.append(f)
        self.app.features.append(f)
        self.app.log.append("extrude %s" % inp.op)
        return f


class PatternInput(object):
    def __init__(self, ents, axis):
        self.entities, self.axis = ents, axis
        self.quantity = self.totalAngle = None
        self.isSymmetric = None


class PatternFeatures(object):
    def __init__(self, app, comp):
        self.app, self.comp = app, comp

    def createInput(self, ents, axis):
        for i in range(ents.count):
            assert isinstance(ents.item(i), _Feature)
        return PatternInput(ents, axis)

    def add(self, inp):
        assert inp.quantity is not None and inp.totalAngle is not None
        f = _Feature()
        f.input = inp
        self.comp.feature_list.append(f)
        self.app.features.append(f)
        self.app.log.append("pattern")
        return f


class Body(object):
    def __init__(self, comp):
        self.comp = comp

    @property
    def physicalProperties(self):
        return types.SimpleNamespace(volume=0.5 * len(self.comp.feature_list))  # fake: 0.5 cm3 per feature

    @property
    def edges(self):
        return _Coll(self.comp.app.brep_edges)

    @property
    def faces(self):
        return _Coll(self.comp.app.brep_faces)

    @property
    def boundingBox(self):
        return types.SimpleNamespace(minPoint=Point3D(0, 0, 0), maxPoint=Point3D(10, 10, 10))  # 100 mm cube diagonal ~173


class _Rec(Named):
    pass


class _FeatureColl(object):
    """Generic recording collection for create*/add feature APIs."""

    def __init__(self, comp, label):
        self.comp, self.label = comp, label

    def add(self, inp):
        f = _Feature()
        f.input = inp
        f.label = self.label
        self.comp.feature_list.append(f)
        self.comp.app.features.append(f)
        self.comp.app.log.append(self.label)
        return f


class HoleInput(object):
    def __init__(self, kind, args):
        self.kind, self.args = kind, args
        self.positions = self.extent = self.tipAngle = self.isDefaultDirection = None

    def setPositionBySketchPoints(self, coll):
        assert coll.count > 0
        self.positions = [coll.item(i) for i in range(coll.count)]

    def setAllExtent(self, direction):
        self.extent = ("all", direction)

    def setDistanceExtent(self, vi):
        self.extent = ("distance", vi)


class HoleFeatures(_FeatureColl):
    def createSimpleInput(self, d):
        return HoleInput("simple", (d,))

    def createCounterboreInput(self, d, cd, cdepth):
        return HoleInput("counterbore", (d, cd, cdepth))

    def createCountersinkInput(self, d, csd, ang):
        return HoleInput("countersink", (d, csd, ang))

    def add(self, inp):
        assert inp.positions and inp.extent
        return _FeatureColl.add(self, inp)


class FilletInput(object):
    def __init__(self):
        self.sets = []
        self.chamferEdgeSets = types.SimpleNamespace(addEqualDistanceChamferEdgeSet=lambda coll, d, chain: self.sets.append((coll, d, chain)))

    def addConstantRadiusEdgeSet(self, coll, r, chain):
        self.sets.append((coll, r, chain))


class EdgeFeatures(_FeatureColl):
    def createInput(self):
        return FilletInput()

    createInput2 = createInput

    def add(self, inp):
        assert inp.sets and inp.sets[0][0].count > 0
        return _FeatureColl.add(self, inp)


class SimpleInput(object):
    def __init__(self, *a):
        self.args = a


class SimpleFeatures(_FeatureColl):
    def createInput(self, *a):
        return SimpleInput(*a)


class Component(Named):
    def __init__(self, app, name="root"):
        self.app = app
        self.feature_list = []
        self.name = name
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
        self.occurrences = types.SimpleNamespace(addNewComponent=self._add_comp)
        self.features = types.SimpleNamespace(
            extrudeFeatures=ExtrudeFeatures(app, self), circularPatternFeatures=PatternFeatures(app, self),
            holeFeatures=HoleFeatures(self, "hole"), filletFeatures=EdgeFeatures(self, "fillet"),
            chamferFeatures=EdgeFeatures(self, "chamfer"), rectangularPatternFeatures=RectPatterns(self, "rect_pattern"),
            mirrorFeatures=SimpleFeatures(self, "mirror"))

    def _add_comp(self, matrix):
        occ = types.SimpleNamespace(component=Component(self.app, "Component"), transform=matrix)
        self.app.occurrences.append(occ)
        self.app.log.append("occurrence")
        return occ

    @property
    def bRepBodies(self):
        return _Coll([Body(self)] if self.feature_list else [])


class RectPatterns(_FeatureColl):
    def createInput(self, ents, axis, qty, dist, dtype):
        for i in range(ents.count):
            assert isinstance(ents.item(i), _Feature)
        return SimpleInput(ents, axis, qty, dist, dtype)


Root = Component


def make_line_edge(a, b):
    mid = [(x + y) / 2 for x, y in zip(a, b)]
    length = sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5
    return _edge("adsk::core::Line3D", mid, length, a, b)


def make_circle_edge(center, r, normal=(0, 0, 1)):
    mid = [center[0] + r, center[1], center[2]]
    e = _edge("adsk::core::Circle3D", mid, 2 * math.pi * r, mid, mid)
    e.geometry.center, e.geometry.radius = Point3D(*[c / 10 for c in center]), r / 10
    e.geometry.normal = Vector3D(*normal)
    return e


def _edge(otype, mid, length_mm, a, b):
    cm = lambda v: Point3D(*[c / 10 for c in v])

    class Ev(object):
        def getParameterExtents(self):
            return True, 0.0, 1.0

        def getPointAtParameter(self, t):
            return True, cm(mid)

    e = types.SimpleNamespace(geometry=types.SimpleNamespace(objectType=otype), evaluator=Ev(), length=length_mm / 10,
                              startVertex=types.SimpleNamespace(geometry=cm(a)), endVertex=types.SimpleNamespace(geometry=cm(b)))
    return e


def make_plane_face(origin, normal, area_mm2):
    n = [c / math.sqrt(sum(k * k for k in normal)) for c in normal]
    ref = (0, 0, 1) if abs(n[2]) < 0.9 else (1, 0, 0)
    x = [ref[1] * n[2] - ref[2] * n[1], ref[2] * n[0] - ref[0] * n[2], ref[0] * n[1] - ref[1] * n[0]]
    x = [c / math.sqrt(sum(k * k for k in x)) for c in x]
    y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]]
    f = Face(tuple(n), tuple(c / 10 for c in origin), xdir=tuple(x), ydir=tuple(y))
    f.geometry = types.SimpleNamespace(objectType="adsk::core::Plane", origin=Point3D(*[c / 10 for c in origin]),
                                       normal=Vector3D(*normal), )
    f.area = area_mm2 / 100.0
    return f


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
        self.rootComponent = Component(app)
        self.userParameters = types.SimpleNamespace(add=self._param)
        self.materials = types.SimpleNamespace(addByCopy=self._copy_mat)
        self.params = []
        self.exportManager = ExportManager(app)


def _design_param(self, name, vi, units, comment):
    self.params.append((name, vi, units))
    return types.SimpleNamespace(name=name)


def _design_copy_mat(self, base, name):
    m = types.SimpleNamespace(name=name, materialProperties=types.SimpleNamespace(
        itemById=lambda i: self.density_prop if i == "structural_Density" else None))
    self.density_prop = types.SimpleNamespace(value=None)
    self.material = m
    return m


Design._param = _design_param
Design._copy_mat = _design_copy_mat


class Doc(object):
    def __init__(self, app):
        self.app = app

    def close(self, save):
        self.app.log.append("close save=%s" % save)
        self.app.closed = True
        self.app.close_args = save


class FakeApp(object):
    current = None

    def __init__(self, flip_xy=False, reject_slash=False, fail_step=False, no_material=False):
        self.flip_xy, self.reject_slash, self.fail_step = flip_xy, reject_slash, fail_step
        self.no_material = no_material
        self.log, self.features, self.planes = [], [], []
        self.occurrences, self.brep_edges, self.brep_faces = [], [], []
        self.all_sketches = []
        self.materialLibraries = _Coll([types.SimpleNamespace(materials=_Coll([types.SimpleNamespace(
            materialProperties=types.SimpleNamespace(itemById=lambda i: object()))]))])
        self.closed = False
        self.close_args = None
        self.version = "2.0.test"
        self.design = None
        self.activeProduct = None
        self.preferences = types.SimpleNamespace(generalPreferences=types.SimpleNamespace(defaultModelingOrientation="Y"))
        app = self
        self.documents = types.SimpleNamespace(add=lambda t: app._add(t))
        self.activeViewport = types.SimpleNamespace(fit=lambda: app.log.append("viewport.fit"), refresh=lambda: None)
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
    core.Matrix3D = Matrix3D
    core.Application = types.SimpleNamespace(get=lambda: app)
    core.DocumentTypes = _Enum("FusionDesignDocumentType")
    core.DefaultModelingOrientations = _Enum("ZUpModelingOrientation", "YUpModelingOrientation")
    fus = types.ModuleType("adsk.fusion")
    fus.Design = types.SimpleNamespace(cast=lambda x: x)
    fus.DesignTypes = _Enum("ParametricDesignType", "DirectDesignType")
    fus.DistanceUnits = _Enum("MillimeterDistanceUnits")
    fus.PatternDistanceType = _Enum("SpacingPatternDistanceType", "ExtentPatternDistanceType")
    fus.DimensionOrientations = _Enum("AlignedDimensionOrientation", "HorizontalDimensionOrientation", "VerticalDimensionOrientation")
    fus.FeatureOperations = _Enum("NewBodyFeatureOperation", "JoinFeatureOperation", "CutFeatureOperation")
    fus.ExtentDirections = _Enum("PositiveExtentDirection", "NegativeExtentDirection", "SymmetricExtentDirection")
    fus.ToEntityExtentDefinition = types.SimpleNamespace(create=lambda entity, chained, offset=None: types.SimpleNamespace(entity=entity))
    fus.DistanceExtentDefinition = types.SimpleNamespace(create=lambda vi: types.SimpleNamespace(distance=vi))
    pkg = types.ModuleType("adsk")
    pkg.core, pkg.fusion = core, fus
    sys.modules.update({"adsk": pkg, "adsk.core": core, "adsk.fusion": fus})
    return app


def uninstall():
    for k in ("adsk", "adsk.core", "adsk.fusion", "fusion_exec"):
        sys.modules.pop(k, None)


def edge_from_ref(ref):
    """Fake BRep edge that exactly matches a canonical edge_ref (world mm)."""
    cm = lambda v: Point3D(*[c / 10 for c in v])
    otype = {"line": "adsk::core::Line3D", "circle": "adsk::core::Circle3D", "arc": "adsk::core::Arc3D"}[ref["curve"]]
    a = ref.get("start", ref["midpoint"])
    b = ref.get("end", ref["midpoint"])
    e = _edge(otype, ref["midpoint"], ref["length"], a, b)
    if ref["curve"] != "line":
        e.geometry.center, e.geometry.radius = cm(ref["centre"]), ref["radius"] / 10
        n = ref.get("axis", (0, 0, 1))
        e.geometry.normal = Vector3D(*n)
    return e


def face_from_ref(ref):
    return make_plane_face(ref["origin"], ref["normal"], ref["area"])
