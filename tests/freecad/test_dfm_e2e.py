"""DFM end-to-end tests over the real FreeCAD worker. Run with the FreeCAD environment's Python:

    E=~/.local/share/pi-cad/runtimes/freecad/env
    PYTHONPATH=python:$E/lib PI_CAD_FREECAD_PYTHON=$E/bin/python $E/bin/python -m unittest tests/freecad/test_dfm_e2e.py -v

Each folder in tests/fixtures/dfm/ is one part: part.ops.json (the first op is dfm_profile)
and expect.json (the rules that must or must not appear, per layer). Rule severities come
from the rulepack; "info" issues are not in the summary block, so the lint checks read the
full issue list from dfm.lint.evaluate_full.

The DFM checks skip until reify_freecad.dfm.lint can be imported. The build checks run
without the profile op, so every fixture is verified against the current backend.
"""

from __future__ import annotations

import importlib
import json
import shutil
import statistics
import sys
import time
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "dfm"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_part_backend import HAVE_FREECAD, Harness, plate  # noqa: E402

if HAVE_FREECAD:
    from reify_freecad import queries  # noqa: E402
    from reify_freecad.worker import Worker  # noqa: E402


def _dfm_skip_reason() -> str | None:
    if not HAVE_FREECAD:
        return "FreeCAD is not importable in this interpreter"
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


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class FixtureBuildTests(FixtureTestMixin, unittest.TestCase):
    """Without the profile op every fixture builds one valid solid (the DFM op is not needed for this)."""

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


def _make_build_test(case: str):
    def test(self: FixtureBuildTests) -> None:
        ops, _ = load_case(case)
        harness = self.open_case(case)
        harness.apply(without_profile(ops))
        self.assertBuildsOneSolid(harness, ops)

    test.__name__ = f"test_builds_without_profile_{case}"
    return test


for _case in case_names():
    setattr(FixtureBuildTests, f"test_builds_without_profile_{_case}", _make_build_test(_case))


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
        if not hasattr(Worker, "cmd_dfm"):
            self.skipTest("the worker has no dfm command yet (geometry layer, WP4)")
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

    test.__name__ = f"test_{case}"
    return test


for _case in case_names():
    setattr(FixtureDfmTests, f"test_{_case}", _make_case_test(_case))


@unittest.skipIf(DFM_SKIP is not None, DFM_SKIP or "")
class DfmBehaviourTests(FixtureTestMixin, unittest.TestCase):
    def test_a_document_without_a_profile_has_no_dfm_block(self) -> None:
        harness = Harness(name="no_profile")
        self.addCleanup(harness.close)
        result = harness.apply(plate("part", 40, 30, 5))
        self.assertIn("dfm", result)
        self.assertIsNone(result["dfm"])

    def test_good_plate_without_a_profile_has_the_same_geometry_as_with_one(self) -> None:
        ops, _ = load_case("good_plate")
        with_profile = self.open_case("good_plate").apply(ops)
        without = self.open_case("good_plate_plain").apply(without_profile(ops))
        self.assertIsNone(without["dfm"])
        self.assertEqual(with_profile["features"], without["features"])

    def test_lint_on_good_plate_takes_at_most_50_ms(self) -> None:
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
        self.assertLessEqual(statistics.median(samples), 50.0, f"lint took {samples} ms")

    def test_changing_the_rulepack_threshold_changes_the_result(self) -> None:
        # Acceptance scenario 10 (hole.min_diameter 1.5 in a copy of the pack, phi1.2 then errors)
        # needs a rulepack search path override, for example a directory argument or an
        # environment variable. rulepack.py has none yet, so this stays skipped.
        self.skipTest("rulepack.py has no search path override yet (acceptance scenario 10)")


if __name__ == "__main__":
    unittest.main()
