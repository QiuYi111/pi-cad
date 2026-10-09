"""Rulepack validation and reference rendering. Pure Python, but needs PyYAML from the FreeCAD interpreter."""

from __future__ import annotations

import copy
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from system_requirements import skip_unless_system

# PyYAML is part of the FreeCAD interpreter, not of the uv environment. Without it the
# rulepack module cannot be imported, so these tests run in the FreeCAD job.
try:
    import yaml  # noqa: F401
    from reify_freecad.dfm import render_reference, rulepack
    from reify_freecad.dfm.rulepack import load_rulepack, validate_rulepack
    from reify_freecad.errors import ReifyOpError
    HAVE_RULEPACK = True
except ImportError:
    HAVE_RULEPACK = False

RULEPACK_REASON = "PyYAML is not importable in this interpreter (the FreeCAD interpreter has it)"

# Every rule ID of implementation-plan.zh-CN.md §5.1–§5.4, exactly once.
PLAN_RULE_IDS = [
    # 5.1
    "stock.size_range", "stock.size_limited_material", "stock.thickness_range", "stock.side_height",
    "stock.standard_thickness", "stock.thin_plate_large", "stock.removal_ratio", "stock.surface_treatment",
    "tol.general", "tol.precision_hole",
    # 5.2
    "hole.min_diameter", "hole.depth_ratio", "hole.thread_tap_drill", "hole.thread_modeled", "hole.thread_length",
    "hole.thread_min_depth", "hole.thread_blind_extra", "hole.thread_side_wall", "hole.blind_bottom_wall",
    "hole.bottom_shape", "hole.internal_chamfer", "hole.ring_groove", "hole.countersink",
    "hole.countersink_to_bottom", "hole.side_support_face", "hole.waist_slot_depth",
    # 5.3
    "cavity.min_width", "cavity.depth_tool_ratio", "corner.inner_auto_radius", "corner.relief_size",
    "floor.chamfer", "floor.fillet_radius", "outer.concave_narrow", "wall.min_thickness", "wall.slender_suspended",
    # 5.4
    "edge.default_chamfer", "edge.double_side_chamfer", "edge.double_side_fillet", "twoside.back_notch_ratio",
    "twoside.nonstandard_back", "twoside.max_outline_top", "surface.double_side_curved", "surface.multi_face",
    "ganging.forbidden",
]

MILL = "quanzhou.cnc_mill"
TURN = "quanzhou.cnc_turn"
ROOT = Path(__file__).resolve().parents[3]
REFERENCE = ROOT / "skills" / "design-for-manufacturing" / "references" / "quanzhou-cnc-mill.md"


def _pack_data() -> dict:
    """A minimal valid pack, as parsed YAML, to mutate in the broken-pack tests."""
    return {
        "schema": "reify.dfm.rulepack/1",
        "id": "test.pack",
        "title": "Test",
        "vendor": "Vendor",
        "source": {"doc": "doc.pdf", "version": "1.0"},
        "process": {"type": "cnc_mill"},
        "materials": {"al6061": {"density_g_cm3": 2.7, "size_limited": False}},
        "defaults": {"material": "al6061"},
        "tables": {"tap_drill_mm": {"M3": 2.5}, "tool_diameters_mm": [1, 2]},
        "rules": [
            {
                "id": "hole.min_diameter",
                "check": "hole_min_diameter",
                "layers": ["lint", "geometry"],
                "severity": "error",
                "params": {"min_mm": 1.2},
                "source": {"page": 1, "quote": "孔 Φ1.2mm 以上"},
                "hint": "increase to {limit}",
            },
            {
                "id": "stock.standard_thickness",
                "check": "stock_standard_thickness",
                "layers": ["lint"],
                "severity": "info",
                "params": {"standard_mm": [1, 2]},
                "source": {"page": 2, "quote": "常见标准板厚", "inferred": True},
                "hint": "not standard",
            },
        ],
    }


@skip_unless_system("freecad", HAVE_RULEPACK, RULEPACK_REASON)
class PackLoadTests(unittest.TestCase):
    def test_both_shipped_packs_load(self) -> None:
        self.assertEqual(rulepack.available_rulepacks(), [MILL, TURN])
        for rulepack_id in (MILL, TURN):
            pack = load_rulepack(rulepack_id)
            self.assertEqual(pack.id, rulepack_id)
            self.assertEqual(pack.vendor, "铨洲智造")
            self.assertEqual(pack.source["version"], "8.14")

    def test_mill_pack_has_every_plan_rule_exactly_once(self) -> None:
        pack = load_rulepack(MILL)
        ids = [rule.id for rule in pack.rules]
        self.assertEqual(len(PLAN_RULE_IDS), 44)
        self.assertEqual(sorted(ids), sorted(PLAN_RULE_IDS))
        self.assertEqual(len(set(ids)), len(ids))

    def test_mill_rules_are_well_formed(self) -> None:
        pack = load_rulepack(MILL)
        for rule in pack.rules:
            with self.subTest(rule=rule.id):
                self.assertRegex(rule.check, r"^[a-z][a-z0-9_]*$")
                self.assertTrue(set(rule.layers) <= {"lint", "geometry"})
                self.assertIn(rule.severity, {"error", "warn", "info"})
                self.assertIsInstance(rule.source["page"], int)
                self.assertTrue(rule.hint)
                if rule.source.get("inferred"):
                    self.assertNotEqual(rule.severity, "error")

    def test_turn_pack_is_valid_and_empty(self) -> None:
        pack = load_rulepack(TURN)
        self.assertEqual(pack.rules, [])

    def test_unknown_pack_lists_available_ids(self) -> None:
        with self.assertRaises(ReifyOpError) as caught:
            load_rulepack("no.such.pack")
        self.assertEqual(caught.exception.code, "DFM_RULEPACK_UNKNOWN")
        self.assertEqual(caught.exception.hints, [MILL, TURN])


@skip_unless_system("freecad", HAVE_RULEPACK, RULEPACK_REASON)
class BrokenPackTests(unittest.TestCase):
    def assertInvalid(self, data: dict, reason_part: str) -> None:
        with self.assertRaises(ReifyOpError) as caught:
            validate_rulepack(data, path="broken.yaml", expected_id="test.pack")
        error = caught.exception
        self.assertEqual(error.code, "DFM_RULEPACK_INVALID")
        self.assertIn(reason_part, error.detail["reason"])

    def test_valid_base_is_accepted(self) -> None:
        pack = validate_rulepack(_pack_data(), path="ok.yaml", expected_id="test.pack")
        self.assertEqual([rule.id for rule in pack.rules], ["hole.min_diameter", "stock.standard_thickness"])

    def test_bad_schema(self) -> None:
        data = _pack_data()
        data["schema"] = "reify.dfm.rulepack/2"
        self.assertInvalid(data, "schema")

    def test_missing_required_key(self) -> None:
        data = _pack_data()
        del data["tables"]
        self.assertInvalid(data, "tables")

    def test_bad_layer(self) -> None:
        data = _pack_data()
        data["rules"][0]["layers"] = ["visual"]
        self.assertInvalid(data, "layer")

    def test_bad_severity(self) -> None:
        data = _pack_data()
        data["rules"][0]["severity"] = "fatal"
        self.assertInvalid(data, "severity")

    def test_duplicate_rule_id(self) -> None:
        data = _pack_data()
        data["rules"][1]["id"] = "hole.min_diameter"
        self.assertInvalid(data, "duplicate rule id")

    def test_source_page_must_be_int(self) -> None:
        data = _pack_data()
        data["rules"][0]["source"]["page"] = "1"
        self.assertInvalid(data, "source.page")

    def test_inferred_rule_cannot_be_error(self) -> None:
        data = _pack_data()
        data["rules"][1]["severity"] = "error"
        self.assertInvalid(data, "inferred")

    def test_id_must_match_file_name(self) -> None:
        with self.assertRaises(ReifyOpError) as caught:
            validate_rulepack(_pack_data(), path="other.yaml", expected_id="other.pack")
        self.assertEqual(caught.exception.code, "DFM_RULEPACK_INVALID")

    def test_broken_file_on_disk_is_rejected(self) -> None:
        text = "schema: reify.dfm.rulepack/1\nid: broken.pack\nrules: [\n"
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "broken.pack.yaml").write_text(text, encoding="utf-8")
            with mock.patch.object(rulepack, "PACK_DIR", Path(folder)):
                rulepack._load.cache_clear()
                self.addCleanup(rulepack._load.cache_clear)
                self.assertEqual(rulepack.available_rulepacks(), ["broken.pack"])
                with self.assertRaises(ReifyOpError) as caught:
                    load_rulepack("broken.pack")
        self.assertEqual(caught.exception.code, "DFM_RULEPACK_INVALID")


@skip_unless_system("freecad", HAVE_RULEPACK, RULEPACK_REASON)
class RenderReferenceTests(unittest.TestCase):
    def test_mill_reference_has_every_rule_and_page(self) -> None:
        text = render_reference.render(MILL)
        pack = load_rulepack(MILL)
        self.assertIn("铨洲智造", text)
        self.assertIn("quanzhou-cnc-design-guide-v8.14.pdf", text)
        rows = text.splitlines()
        for rule in pack.rules:
            with self.subTest(rule=rule.id):
                row = next((line for line in rows if line.startswith(f"| `{rule.id}` |")), None)
                self.assertIsNotNone(row, "rule row missing")
                pages = rule.source.get("pages") or [rule.source["page"]]
                cells = [cell.strip() for cell in row.strip("|").split("|")]
                self.assertEqual(cells[-2], ", ".join(str(p) for p in pages))
                self.assertIn(rule.id, text)

    def test_every_plan_id_appears(self) -> None:
        text = render_reference.render(MILL)
        for rule_id in PLAN_RULE_IDS:
            self.assertRegex(text, re.escape(f"`{rule_id}`"))

    def test_turn_reference_renders_without_rules(self) -> None:
        text = render_reference.render(TURN)
        self.assertIn("No rules", text)

    def test_render_is_deterministic(self) -> None:
        self.assertEqual(render_reference.render(MILL), render_reference.render(MILL))

    def test_committed_reference_is_the_generated_one(self) -> None:
        # Regenerate with: python -m reify_freecad.dfm.render_reference quanzhou.cnc_mill > <that file>
        self.assertEqual(REFERENCE.read_text(encoding="utf-8"), render_reference.render(MILL))


if __name__ == "__main__":
    unittest.main()
