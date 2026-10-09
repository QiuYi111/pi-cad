from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python"))

import build123d as bd  # noqa: E402
from PIL import Image  # noqa: E402

from cadctl.fingerprints import shape_fingerprints  # noqa: E402
from cadctl.render import render_views  # noqa: E402

# Pixel hashes of the pre-highlight renderer for the part below. A render
# without highlight or annotations must stay byte-identical to them.
BASELINE = {
    "iso": "8437c41cac5c3e1ed7cde754b7353a205f285269c576fc23ff1ae69a83853260",
    "top": "30c6f2f7380d3f34b18c9b1d7cc3485da60585c036203f437044e6a013fa2172",
}


def _part() -> bd.Shape:
    return bd.Box(40, 20, 10) - bd.Pos(10, 0, 0) * bd.Cylinder(3, 10)


def _orange(pixel: tuple[int, int, int]) -> bool:
    r, g, b = pixel
    return r > 150 and r > g + 40 and g > b + 40


class RenderHighlightTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.step = self.dir / "part.step"
        bd.export_step(_part(), str(self.step))

    def _render(self, name: str, **kwargs):
        result = render_views(self.step, self.dir / name, views=["iso", "top"], width=320, height=240, **kwargs)
        return {view["name"]: Image.open(view["path"]).convert("RGB") for view in result["views"]}

    def test_no_highlight_is_pixel_identical_to_the_baseline(self) -> None:
        images = self._render("plain")
        for name, digest in BASELINE.items():
            self.assertEqual(hashlib.sha256(images[name].tobytes()).hexdigest(), digest, name)
        # Empty highlight and annotation lists take the same path.
        empty = self._render("empty", highlight=[], annotations=[])
        for name, digest in BASELINE.items():
            self.assertEqual(hashlib.sha256(empty[name].tobytes()).hexdigest(), digest, name)

    def test_highlighted_face_is_orange(self) -> None:
        prints, _ = shape_fingerprints(_part())
        wall = [item for item in prints if item["type"] == "CYLINDER"]
        self.assertEqual(len(wall), 1)
        # Highlight the top face: it is the largest visible area in the top view.
        top = max((item for item in prints if item["type"] == "PLANE" and item["n"][2] > 0.9), key=lambda item: item["c"][2])
        images = self._render("hl", highlight=[top])
        orange = sum(_orange(images["top"].getpixel((x, y))) for x in range(0, 320, 4) for y in range(0, 240, 4))
        self.assertGreater(orange, 200)
        plain = self._render("plain")
        plain_orange = sum(_orange(plain["top"].getpixel((x, y))) for x in range(0, 320, 4) for y in range(0, 240, 4))
        self.assertEqual(plain_orange, 0)

    def test_unmatched_highlight_changes_nothing_visible_except_dimming_rule(self) -> None:
        ghost = {"i": 0, "type": "PLANE", "c": [500.0, 500.0, 500.0], "a": 5.0, "n": [0.0, 0.0, 1.0]}
        images = self._render("ghost", highlight=[ghost])
        orange = sum(_orange(images["iso"].getpixel((x, y))) for x in range(0, 320, 4) for y in range(0, 240, 4))
        self.assertEqual(orange, 0)

    def test_annotation_is_drawn_when_visible_and_skipped_when_hidden(self) -> None:
        # Top face centre is visible from above and hidden from below.
        top_point = [-10.0, 0.0, 5.0]
        labelled = self._render("lab", annotations=[{"text": "top_face", "at": top_point}])
        plain = self._render("plain")
        self.assertNotEqual(labelled["top"].tobytes(), plain["top"].tobytes())
        bottom = render_views(
            self.step, self.dir / "bottom", views=["bottom"], width=320, height=240,
            annotations=[{"text": "top_face", "at": top_point}],
        )
        plain_bottom = render_views(self.step, self.dir / "bottom-plain", views=["bottom"], width=320, height=240)
        self.assertEqual(
            Image.open(bottom["views"][0]["path"]).tobytes(),
            Image.open(plain_bottom["views"][0]["path"]).tobytes(),
        )

    def test_at_most_eight_labels_per_view(self) -> None:
        many = [{"text": f"p{i}", "at": [-18.0 + 4 * i, -8.0 + i, 5.0]} for i in range(12)]
        eight = many[:8]
        a = self._render("many", annotations=many)
        b = self._render("eight", annotations=eight)
        self.assertEqual(a["top"].tobytes(), b["top"].tobytes())


if __name__ == "__main__":
    unittest.main()
