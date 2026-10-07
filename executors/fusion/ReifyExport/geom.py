"""Small 2D geometry helpers (pure)."""
import math


class Affine2(object):
    """(x, y) -> (a*x + b*y + e, c*x + d*y + f)."""

    def __init__(self, a, b, c, d, e, f):
        self.a, self.b, self.c, self.d, self.e, self.f = a, b, c, d, e, f

    @classmethod
    def from_basis(cls, o, pu, pv):
        """Map (0,0)->o, (1,0)->pu, (0,1)->pv."""
        return cls(pu[0] - o[0], pv[0] - o[0], pu[1] - o[1], pv[1] - o[1], o[0], o[1])

    def apply(self, u, v=None):
        if v is None:
            u, v = u
        return (self.a * u + self.b * v + self.e, self.c * u + self.d * v + self.f)

    def det(self):
        return self.a * self.d - self.b * self.c

    def inverse(self):
        det = self.det()
        if abs(det) < 1e-12:
            raise ValueError("singular transform")
        ia, ib, ic, id_ = self.d / det, -self.b / det, -self.c / det, self.a / det
        return Affine2(ia, ib, ic, id_, -(ia * self.e + ib * self.f), -(ic * self.e + id_ * self.f))


def dist_point_segment(p, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(p[0] - ax, p[1] - ay)
    t = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2))
    return math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy))


def arc_sweep(g):
    sweep = (float(g["end_angle"]) - float(g["start_angle"])) % 360.0
    return 360.0 if sweep == 0 else sweep


def arc_point(g, angle_deg):
    c, r = g["center"], float(g["radius"])
    a = math.radians(angle_deg)
    return (c[0] + r * math.cos(a), c[1] + r * math.sin(a))


def dist_point_arc(p, g):
    c, r = g["center"], float(g["radius"])
    sweep = arc_sweep(g)
    ang = math.degrees(math.atan2(p[1] - c[1], p[0] - c[0]))
    rel = (ang - float(g["start_angle"])) % 360.0
    if rel <= sweep:
        return abs(math.hypot(p[0] - c[0], p[1] - c[1]) - r)
    s = arc_point(g, g["start_angle"])
    e = arc_point(g, g["start_angle"] + sweep)
    return min(math.hypot(p[0] - s[0], p[1] - s[1]), math.hypot(p[0] - e[0], p[1] - e[1]))


def polyline_segments(g):
    pts = [tuple(q) for q in g["points"]]
    segs = list(zip(pts[:-1], pts[1:]))
    if g.get("closed") and len(pts) > 2 and pts[0] != pts[-1]:
        segs.append((pts[-1], pts[0]))
    return segs


def dist_point_geometry(p, g):
    t = g["type"]
    if t == "line":
        return dist_point_segment(p, g["start"], g["end"])
    if t == "arc":
        return dist_point_arc(p, g)
    if t == "circle":
        c = g["center"]
        return abs(math.hypot(p[0] - c[0], p[1] - c[1]) - float(g["radius"]))
    if t == "polyline":
        return min(dist_point_segment(p, a, b) for a, b in polyline_segments(g))
    raise ValueError("unknown geometry type %r" % t)
