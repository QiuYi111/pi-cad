"""DFM end-to-end tests over the real FreeCAD worker. Run with the FreeCAD environment's Python:

    E=~/.local/share/pi-cad/runtimes/freecad/env
    PYTHONPATH=python:$E/lib PI_CAD_FREECAD_PYTHON=$E/bin/python $E/bin/python -m unittest tests/dfm/e2e/test_dfm_e2e.py -v

Each folder in tests/fixtures/dfm/ is one part: part.ops.json (the first op is dfm_profile)
and expect.json (the rules that must or must not appear, per layer). Rule severities come
from the rulepack; "info" issues are not in the summary block, so the lint checks read the
full issue list from dfm.lint.evaluate_full.

The DFM checks skip until reify_freecad.dfm.lint can be imported. Each fixture case also
checks that its part builds one valid solid (the profile op does not change the geometry).
"""

from __future__ import annotations

import importlib
import json
import shutil
import statistics
import sys
import time
import unittest
from system_requirements import system_skip_reason  # noqa: E402
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "tests" / "fixtures" / "dfm"
sys.path.insert(0, str(Path(__file__).resolve().parent))

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "freecad-part" / "e2e"))
from test_part_backend import HAVE_FREECAD, Harness, plate  # noqa: E402

if HAVE_FREECAD:
    from reify_freecad import queries  # noqa: E402


def _dfm_skip_reason() -> str | None:
    if not HAVE_FREECAD:
        return system_skip_reason("freecad", False, "FreeCAD is not importable in this interpreter")
    try:
        importlib.import_module("reify_freecad.dfm.lint")
    except ImportError as error:
        return f"reify_freecad.dfm.lint cannot be imported yet ({error})"
    return None


DFM_SKIP = _dfm_skip_reason()
PROFILE_OP = "dfm_profile"


def case_names() -> list[str]:
    return sorted(p.name for p in FIXTURES.iterdir() if (p / "part.ops.json").is_file())


def load_case(case: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    folder = FIXTURES / case
    ops = json.loads((folder / "part.ops.json").read_text(encoding="utf-8"))
    expect = json.loads((folder / "expect.json").read_text(encoding="utf-8"))
    return ops, expect


def without_profile(ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [op for op in ops if op.get("op") != PROFILE_OP]


def find(issues: list[dict[str, Any]], rule: str, severity: str | None = None) -> list[dict[str, Any]]:
    return [i for i in issues if i.get("rule") == rule and (severity is None or i.get("severity") == severity)]


def describe(issues: list[dict[str, Any]]) -> list[str]:
    return [f"{i.get('rule')}:{i.get('severity')}@{i.get('target')}" for i in issues]


class FixtureTestMixin:
    """Shared fixture handling. A test opens the case in its own project."""

    def open_case(self, case: str) -> Harness:
        harness = Harness(name=case)
        self.addCleanup(harness.close)
        for step in (FIXTURES / case).glob("*.step"):
            target = harness.root / "parts" / "imports"
            target.mkdir(parents=True, exist_ok=True)
            shutil.copy(step, target / step.name)
        return harness

    def assertBuildsOneSolid(self, harness: Harness, ops: list[dict[str, Any]]) -> None:
        if any(op["op"] == "import_step" for op in ops):
            name = next(op["name"] for op in ops if op["op"] == "import_step")
            ctx = harness.worker._ctx(harness.session())
            shape = queries.shape_of(ctx, name)
        else:
            shape = harness.body_shape("part")
        self.assertTrue(shape.isValid())
        self.assertEqual(len(shape.Solids), 1)
        self.assertGreater(shape.Volume, 0)


@unittest.skipIf(DFM_SKIP is not None, DFM_SKIP or "")
class FixtureDfmTests(FixtureTestMixin, unittest.TestCase):
    """Lint (summary block and full issue list) and geometry expectations per fixture."""

    def lint_issues(self, harness: Harness) -> dict[str, Any]:
        from reify_freecad.dfm import lint

        ctx = harness.worker._ctx(harness.session())
        return lint.evaluate_full(ctx)

    def check_lint(self, harness: Harness, result: dict[str, Any], section: dict[str, Any], clean: bool) -> None:
        summary = result["dfm"]
        self.assertIsNotNone(summary, "a document with dfm_profile has a summary block")
        full = self.lint_issues(harness)
        issues = full["issues"]
        if clean:
            self.assertEqual(summary["counts"]["error"], 0, describe(summary["issues"]))
            self.assertEqual(summary["counts"]["warn"], 0, describe(summary["issues"]))
            self.assertEqual([i for i in issues if i["severity"] in ("error", "warn")], [], describe(issues))
        for item in section.get("must", []):
            matches = find(issues, item["rule"], item["severity"])
            self.assertTrue(matches, f"lint must report {item['rule']} {item['severity']}; got {describe(issues)}")
            if "measured" in item:
                self.assertIn(item["measured"], [m.get("measured") for m in matches], f"{item['rule']} measured")
            if item["severity"] in ("error", "warn") and not summary["truncated"]:
                self.assertTrue(find(summary["issues"], item["rule"], item["severity"]),
                                f"summary block must show {item['rule']} {item['severity']}")
        for rule in section.get("must_not", []):
            self.assertFalse(find(issues, rule), f"lint must not report {rule}; got {describe(issues)}")
        reason = section.get("skipped_reason")
        if reason:
            self.assertTrue(any(c.get("reason") == reason for c in full.get("coverage", [])),
                            f"coverage must say {reason}")

    def check_geometry(self, harness: Harness, expect: dict[str, Any], clean: bool) -> None:
        report = harness.call("dfm")
        geometry = report.get("geometry", report)
        analyzer = report.get("analyzer", geometry.get("analyzer"))
        issues = geometry.get("issues", [])
        if analyzer == "analysis_situs":
            section = expect["geometry"]
        elif analyzer == "builtin":
            section = expect["geometry_builtin"]
        else:
            self.fail(f"unknown analyzer {analyzer!r}")
        if clean:
            self.assertEqual([i for i in issues if i["severity"] in ("error", "warn")], [], describe(issues))
        for item in section.get("must", []):
            self.assertTrue(find(issues, item["rule"], item["severity"]),
                            f"{analyzer}: must report {item['rule']} {item['severity']}; got {describe(issues)}")
        for rule in section.get("must_not", []):
            self.assertFalse(find(issues, rule), f"{analyzer}: must not report {rule}; got {describe(issues)}")


def _make_case_test(case: str):
    def test(self: FixtureDfmTests) -> None:
        ops, expect = load_case(case)
        self.assertEqual(ops[0]["op"], PROFILE_OP, "the first op sets the profile")
        harness = self.open_case(case)
        result = harness.apply(ops)
        clean = case == "good_plate"
        self.check_lint(harness, result, expect["lint"], clean)
        self.check_geometry(harness, expect, clean)
        self.assertBuildsOneSolid(harness, ops)

    test.__name__ = f"test_{case}"
    return test


for _case in case_names():
    setattr(FixtureDfmTests, f"test_{_case}", _make_case_test(_case))


@unittest.skipIf(DFM_SKIP is not None, DFM_SKIP or "")
class DfmBehaviourTests(FixtureTestMixin, unittest.TestCase):
    def test_good_plate_without_a_profile_has_the_same_geometry_as_with_one(self) -> None:
        ops, _ = load_case("good_plate")
        with_profile = self.open_case("good_plate").apply(ops)
        without = self.open_case("good_plate_plain").apply(without_profile(ops))
        self.assertIsNone(without["dfm"])
        self.assertEqual(with_profile["features"], without["features"])

    def test_lint_on_good_plate_is_not_pathologically_slow(self) -> None:
        from reify_freecad.dfm import lint

        ops, _ = load_case("good_plate")
        harness = self.open_case("good_plate")
        harness.apply(ops)
        ctx = harness.worker._ctx(harness.session())
        lint.evaluate(ctx)  # warm up the rulepack cache
        samples = []
        for _ in range(5):
            started = time.perf_counter()
            lint.evaluate(ctx)
            samples.append((time.perf_counter() - started) * 1000)
        # Generous bound: this guards against a pathological regression, not normal jitter.
        self.assertLessEqual(statistics.median(samples), 1000.0, f"lint took {samples} ms")

    def test_changing_the_rulepack_threshold_changes_the_result(self) -> None:
        # Acceptance scenario 10: a copy of the pack with hole.min_diameter at 1.5 mm makes a 1.2 mm hole fail.
        import os
        import tempfile

        import yaml

        from reify_freecad.dfm import rulepack

        profile = {"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill", "material": "al6061"}
        ops = [
            profile,
            *plate("part", 40, 30, 5),
            {"op": "sketch", "name": "part/pin_sketch", "on": {"feature": "part/base", "role": "top"},
             "shapes": [{"circle": {"center": [0, 0], "diameter": 1.2}}]},
            {"op": "hole", "name": "part/pin_hole", "sketch": "part/pin_sketch", "diameter": 1.2, "type": "through_all"},
        ]
        harness = Harness(name="threshold")
        self.addCleanup(harness.close)
        before = harness.apply(ops)["dfm"]
        self.assertEqual(find(before["issues"], "hole.min_diameter"), [], "1.2 mm passes the shipped pack (min 1.2)")

        folder = tempfile.mkdtemp(prefix="reify-dfm-pack-")
        self.addCleanup(shutil.rmtree, folder, True)
        data = yaml.safe_load((rulepack.PACK_DIR / "quanzhou.cnc_mill.yaml").read_text(encoding="utf-8"))
        for rule in data["rules"]:
            if rule["id"] == "hole.min_diameter":
                rule["params"]["min_mm"] = 1.5
        Path(folder, "quanzhou.cnc_mill.yaml").write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
        os.environ[rulepack.SEARCH_ENV] = folder
        self.addCleanup(os.environ.pop, rulepack.SEARCH_ENV, None)

        after = harness.apply([{"op": "param", "name": "unused", "value": 1}])["dfm"]
        found = find(after["issues"], "hole.min_diameter", "error")
        self.assertEqual([(i["target"], i["measured"], i["limit"]) for i in found], [("part/pin_hole", 1.2, 1.5)])


if __name__ == "__main__":
    unittest.main()
