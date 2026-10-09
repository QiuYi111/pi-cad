from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import numpy as np  # noqa: E402

from cadctl.render import _rasterize, _rasterize_reference  # noqa: E402


class RasterizeTests(unittest.TestCase):
    """The batched rasteriser must paint the very pixels the one-triangle-at-a-time loop paints."""

    def compare(self, sx, sy, pz, tri, colors, width, height) -> None:
        z_ref, c_ref = _rasterize_reference(sx, sy, pz, tri, colors, width, height)
        z_new, c_new = _rasterize(sx, sy, pz, tri, colors, width, height)
        self.assertTrue(np.array_equal(z_ref, z_new), "depth buffers differ")
        self.assertTrue(np.array_equal(c_ref, c_new), "colour buffers differ")

    def test_random_triangles_of_every_size(self) -> None:
        rng = np.random.default_rng(7)
        width, height = 160, 120
        count = 3000
        points = rng.uniform(-20, 180, size=(count * 3, 2))
        # many tiny, some medium, a few huge, some degenerate and some off screen
        points[: count] = points[: count] * 0.02 + 60
        sx, sy = points[:, 0], points[:, 1]
        pz = rng.uniform(-5, 5, size=count * 3)
        pz[::7] = np.round(pz[::7])  # coplanar and equal depths: ties go to the earlier triangle
        tri = np.arange(count * 3).reshape(count, 3)
        tri[5] = [0, 0, 0]
        colors = rng.uniform(0, 255, size=(count, 3))
        self.compare(sx, sy, pz, tri, colors, width, height)

    def test_equal_depths_keep_the_first_triangle(self) -> None:
        sx = np.array([0.0, 10.0, 0.0, 0.0, 10.0, 0.0])
        sy = np.array([0.0, 0.0, 10.0, 0.0, 0.0, 10.0])
        pz = np.zeros(6)
        tri = np.array([[0, 1, 2], [3, 4, 5]])
        colors = np.array([[10.0, 20.0, 30.0], [200.0, 100.0, 50.0]])
        z, c = _rasterize(sx, sy, pz, tri, colors, 16, 16)
        self.assertEqual(list(c[2, 2]), [10.0, 20.0, 30.0])
        self.compare(sx, sy, pz, tri, colors, 16, 16)

    def test_nothing_to_draw(self) -> None:
        z, c = _rasterize(np.zeros(0), np.zeros(0), np.zeros(0), np.zeros((0, 3), dtype=int), np.zeros((0, 3)), 8, 8)
        self.assertTrue(np.all(np.isneginf(z)) and np.all(c == 255.0))


if __name__ == "__main__":
    unittest.main()
