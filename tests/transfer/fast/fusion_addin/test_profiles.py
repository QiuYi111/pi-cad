import math
import unittest

import _path  # noqa: F401
import geom
import plan
import profiles


def circle_pts(c, r, n=12, phase=0.3):
    return [(c[0] + r * math.cos(phase + 2 * math.pi * i / n), c[1] + r * math.sin(phase + 2 * math.pi * i / n)) for i in range(n)]


def rect_pts(x0, y0, x1, y1, n=5):
    pts = []
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    for a, b in zip(corners[:-1], corners[1:]):
        for i in range(n):
            t = i / float(n)
            pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return pts


class ProfileTests(unittest.TestCase):
    def setUp(self):
        sk = plan.build_plan(_path.sample())["steps"][0]
        self.loops = sk["loops"]
        self.geometry = {g["id"]: g for g in sk["geometry"]}
        # Fusion makes 3 profiles: plate region (outer rect), hole disc region (outer r10), island (outer r4)
        self.plate = rect_pts(-20, -15, 20, 15)
        self.hole = circle_pts((0, 0), 10)
        self.island = circle_pts((0, 0), 4)

    def test_plate_with_hole_and_island(self):
        idx = profiles.select_profiles(self.loops, self.geometry, [self.hole, self.plate, self.island])
        self.assertEqual(idx, [1, 2])  # plate region + island; NOT the hole disc

    def test_never_select_all(self):
        idx = profiles.select_profiles(self.loops, self.geometry, [self.plate, self.hole, self.island])
        self.assertNotIn(1, idx)
        self.assertEqual(len(idx), 2)

    def test_tolerance(self):
        off = [(x + 5e-5, y) for x, y in self.island]  # still within 1e-4 of the circle? 5e-5 shift => <=5e-5 radial
        self.assertEqual(profiles.select_profiles(self.loops, self.geometry, [self.plate, self.hole, off]), [0, 2])
        bad = [(x + 1e-3, y) for x, y in self.island]
        with self.assertRaises(profiles.ProfileMatchError):
            profiles.select_profiles(self.loops, self.geometry, [self.plate, self.hole, bad])

    def test_missing_even_loop_is_error(self):
        with self.assertRaises(profiles.ProfileMatchError):
            profiles.select_profiles(self.loops, self.geometry, [self.plate, self.hole])

    def test_unknown_profile_is_error(self):
        stray = circle_pts((3, 3), 1)
        with self.assertRaises(profiles.ProfileMatchError):
            profiles.select_profiles(self.loops, self.geometry, [self.plate, self.hole, self.island, stray])

    def test_arc_loop(self):
        geometry = {0: {"id": 0, "type": "line", "start": [0, 0], "end": [10, 0]},
                    1: {"id": 1, "type": "arc", "center": [5, 0], "radius": 5, "start_angle": 0, "end_angle": 180}}
        loops = [{"id": 0, "geometry": [0, 1], "depth": 0}]
        pts = [(5 + 5 * math.cos(math.radians(a)), 5 * math.sin(math.radians(a))) for a in range(0, 181, 30)]
        pts += [(2, 0), (8, 0)]
        self.assertEqual(profiles.select_profiles(loops, geometry, [pts]), [0])
        self.assertEqual(profiles.match_loop([(5, -5)], loops, geometry), None)  # lower half of the circle is not the arc

    def test_affine_roundtrip_with_mirror(self):
        a = geom.Affine2.from_basis((10, 20), (10, 21), (11, 20))  # 90 degree mirror-ish
        self.assertAlmostEqual(a.det(), -1.0)
        inv = a.inverse()
        p = inv.apply(*a.apply(3.5, -2.0))
        self.assertAlmostEqual(p[0], 3.5)
        self.assertAlmostEqual(p[1], -2.0)


if __name__ == "__main__":
    unittest.main()
