"""Pure-Python parts of python/reify_freecad, tested in the uv environment.

These modules must not import FreeCAD (or build123d) so that this environment
can test them; ``test_pure_modules_never_import_freecad`` enforces that.
"""

from __future__ import annotations

import ast
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python"))

from cadctl.identity import protocol as cadctl_protocol  # noqa: E402
from reify_freecad import errors, exprs, fingerprint, naming, summary  # noqa: E402
from reify_freecad.errors import ReifyOpError  # noqa: E402
from reify_freecad.ops import OP_REGISTRY, schema  # noqa: E402

PURE = ["errors.py", "naming.py", "exprs.py", "fingerprint.py", "summary.py", "ops/schema.py", "ops/__init__.py", "__init__.py"]


class PathVectorTests(unittest.TestCase):
    """reify_freecad.naming and cadctl.identity.protocol must agree."""

    vectors = json.loads((ROOT / "tests" / "fixtures" / "identity-paths.json").read_text(encoding="utf-8"))

    def test_valid_paths_canonicalize_identically(self) -> None:
        for raw, expected in self.vectors["valid"]:
            with self.subTest(raw=raw):
                self.assertEqual(cadctl_protocol.canonicalize_path(raw), expected)
                self.assertEqual(naming.canonicalize_path(raw), expected)

    def test_invalid_paths_are_rejected_by_both(self) -> None:
        for raw in self.vectors["invalid"]:
            with self.subTest(raw=raw):
                with self.assertRaises(cadctl_protocol.IdentityError):
                    cadctl_protocol.canonicalize_path(raw)
                with self.assertRaises(naming.PathError):
                    naming.canonicalize_path(raw)

    def test_split_and_parent_agree(self) -> None:
        for raw, _expected in self.vectors["valid"]:
            with self.subTest(raw=raw):
                self.assertEqual(naming.parent_path(raw), cadctl_protocol.parent_path(raw))

    def test_checked_path_reports_the_field(self) -> None:
        with self.assertRaises(ReifyOpError) as raised:
            naming.checked_path("a/3", op_index=2, field="sketch")
        wire = raised.exception.to_wire()
        self.assertEqual(wire["code"], "OP_SCHEMA_INVALID")
        self.assertEqual((wire["detail"]["opIndex"], wire["detail"]["path"]), (2, "sketch"))

    def test_role_names_cannot_end_a_feature_path(self) -> None:
        for last in ("top", "wall", "round", "side.0", "wall.2"):
            with self.subTest(last=last), self.assertRaises(ReifyOpError) as raised:
                naming.check_not_role_name(f"bracket/{last}")
            self.assertEqual(raised.exception.code, "NAME_CONFLICT")
        naming.check_not_role_name("bracket/mount_hole")


class OpSchemaTests(unittest.TestCase):
    def test_a_valid_batch_is_normalised(self) -> None:
        ops = schema.validate_ops([
            {"op": "param", "name": "width", "value": 40, "unit": "mm"},
            {"op": "sketch", "name": "bracket/profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": ["=width", 20]}}]},
            {"op": "pad", "name": "bracket/base", "sketch": "bracket/profile", "length": 5},
            {"op": "fillet", "name": "bracket/round_edges", "edges": {"feature": "bracket/base", "role": "top_outer"}, "radius": 1},
        ])
        self.assertEqual([op["op"] for op in ops], ["param", "sketch", "pad", "fillet"])
        self.assertEqual(ops[3]["edges"], [{"feature": "bracket/base", "role": "top_outer"}])

    def test_malformed_ops_name_the_op_and_the_field(self) -> None:
        cases = [
            ([], "ops"),
            ([{"op": "pad", "name": "a/b", "sketch": "a/s"}], "length"),
            ([{"op": "pad", "name": "a/b", "sketch": "a/s", "length": "long"}], "length"),
            ([{"op": "pad", "name": "a/b", "sketch": "a/s", "length": 1, "colour": "red"}], "op"),
            ([{"op": "sketch", "name": "a/s", "shapes": [{"rect": {"center": [0, 0], "size": [1, 1]}}]}], "plane"),
            ([{"op": "sketch", "name": "a/s", "plane": "XY", "shapes": [{"rect": {"size": [1, 1]}}]}], "shapes[0].rect"),
            ([{"op": "sketch", "name": "a/s", "plane": "XY", "shapes": [{"blob": {}}]}], "shapes[0]"),
            ([{"op": "sketch", "name": "a/s", "plane": "XY", "shapes": [{"circle": {"center": [0], "diameter": 1}}]}], "shapes[0].circle.center"),
            ([{"op": "pad", "name": "a/b", "sketch": "a/s", "length": 1, "type": "up_to_face"}], "face"),
            ([{"op": "hole", "name": "a/h", "sketch": "a/s", "diameter": 4}], "depth"),
            ([{"op": "linear_pattern", "name": "a/p", "features": ["a/h"], "direction": "Q", "length": 1, "count": 2}], "direction"),
            ([{"op": "linear_pattern", "name": "a/p", "features": ["a/h"], "direction": "X", "length": 1, "count": 0}], "count"),
            ([{"op": "fillet", "name": "a/f", "edges": {"role": "top"}, "radius": 1}], "edges[0]"),
            ([{"op": "link", "name": "a/b", "part": "p.FCStd"}], "body"),
            ([{"op": "joint", "name": "a/j", "type": "ball", "parent": {"feature": "a/x", "role": "wall"}, "child": {"feature": "a/y", "role": "wall"}}], "type"),
            ([{"op": "joint", "name": "a/j", "type": "fixed", "parent": {"feature": "a/x"}, "child": {"feature": "a/y", "role": "wall"}}], "parent"),
            ([{"op": "joint", "name": "a/j", "type": "revolute", "parent": {"feature": "a/x", "role": "wall"}, "child": {"feature": "a/y", "role": "wall"}, "limits": [1]}], "limits"),
            ([{"op": "weld"}], "op"),
            (["pad"], "op"),
        ]
        for ops, path in cases:
            with self.subTest(ops=ops):
                with self.assertRaises(ReifyOpError) as raised:
                    schema.validate_ops(ops)
                wire = raised.exception.to_wire()
                self.assertEqual(wire["code"], "OP_SCHEMA_INVALID")
                self.assertEqual(wire["detail"]["path"], path)
                self.assertFalse(wire["rolledBack"], "a rejected batch never opens a transaction")

    def test_op_index_is_reported(self) -> None:
        with self.assertRaises(ReifyOpError) as raised:
            schema.validate_ops([{"op": "param", "name": "w", "value": 1}, {"op": "pad", "name": "a/b"}])
        self.assertEqual(raised.exception.to_wire()["detail"]["opIndex"], 1)


class ExpressionTests(unittest.TestCase):
    def test_parameter_names_are_rewritten_to_the_params_object(self) -> None:
        self.assertEqual(exprs.rewrite_expression("=width/2", {"width"}), "Params.width/2")
        self.assertEqual(exprs.rewrite_expression("= width + hole_d * 2", {"width", "hole_d"}), "Params.width + Params.hole_d * 2")
        self.assertEqual(exprs.rewrite_expression("=Params.width", {"width"}), "Params.width")
        self.assertEqual(exprs.rewrite_expression("=sin(angle * 1) + 3 mm", {"angle"}), "sin(Params.angle * 1) + 3 mm")

    def test_unknown_names_are_an_expression_error_with_the_known_list(self) -> None:
        with self.assertRaises(ReifyOpError) as raised:
            exprs.rewrite_expression("=nosuch * 2", {"width"})
        wire = raised.exception.to_wire()
        self.assertEqual(wire["code"], "EXPRESSION_INVALID")
        self.assertEqual(wire["detail"]["known"], ["width"])
        self.assertEqual(wire["detail"]["expression"], "=nosuch * 2")

    def test_values_are_numbers_or_expressions(self) -> None:
        self.assertTrue(exprs.is_expression("=1+1"))
        self.assertFalse(exprs.is_expression("1+1"))
        self.assertTrue(exprs.is_number(2.5))
        self.assertFalse(exprs.is_number(True))
        self.assertEqual(exprs.value_as_expression(3, set(), "mm"), "3.0 mm")
        self.assertEqual(exprs.value_as_expression("=w", {"w"}, "mm"), "Params.w")
        self.assertEqual(exprs.evaluate_constant("=w"), None)

    def test_parameter_names_must_be_identifiers(self) -> None:
        with self.assertRaises(ReifyOpError):
            exprs.check_param_name("hole d")
        self.assertEqual(exprs.check_param_name("hole_d2"), "hole_d2")


class ErrorTests(unittest.TestCase):
    def test_unknown_codes_are_a_programming_error(self) -> None:
        with self.assertRaises(ValueError):
            ReifyOpError("MADE_UP", "x")

    def test_wire_form_has_rollback_and_context(self) -> None:
        error = ReifyOpError("FILLET_FAILED", "too big", target="a/f", detail={"feature": "a/f"}, hints=["reduce radius"])
        error.rolled_back = True
        error.failed_op_index = 3
        self.assertEqual(error.to_wire(), {
            "code": "FILLET_FAILED", "message": "too big", "rolledBack": True, "target": "a/f",
            "detail": {"feature": "a/f", "failedOpIndex": 3}, "hints": ["reduce radius"],
        })

    def test_failed_features_map_to_their_error_codes(self) -> None:
        table = {
            ("PartDesign::Fillet", "BRep_API: command not done"): "FILLET_FAILED",
            ("PartDesign::Chamfer", "failed"): "CHAMFER_FAILED",
            ("PartDesign::Hole", "failed"): "HOLE_FAILED",
            ("PartDesign::LinearPattern", "x"): "PATTERN_FAILED",
            ("PartDesign::Mirrored", "x"): "PATTERN_FAILED",
            ("PartDesign::Pad", "Wire is not closed."): "SKETCH_PROFILE_NOT_CLOSED",
            ("PartDesign::Pocket", "Cut out of base feature failed"): "BOOLEAN_FAILED",
            ("PartDesign::Pad", "Result has multiple solids"): "BOOLEAN_FAILED",
            ("Sketcher::SketchObject", "Quantity::operator +(): Unit mismatch in plus operation"): "EXPRESSION_INVALID",
            ("PartDesign::Pad", "something unforeseen"): "FEATURE_FAILED",
        }
        for (feature, status), code in table.items():
            with self.subTest(feature=feature, status=status):
                self.assertEqual(errors.failure_code(feature, status), code)

class SummaryAndFingerprintTests(unittest.TestCase):
    def test_parameter_and_feature_diffs(self) -> None:
        self.assertEqual(summary.diff_params({"w": 40, "h": 3}, {"w": 45, "h": 3, "d": 1}), {"changed": {"w": [40, 45], "d": [None, 1]}})
        self.assertEqual(
            summary.diff_features({"a", "b"}, {"b", "c"}, {"a", "b", "c", "z"}),
            {"recomputed": ["b"], "added": ["c"], "removed": ["a"]},
        )
        self.assertEqual(summary.changed_role_paths({"x/top": 1, "x/wall": 2}, {"x/top": 1, "x/wall": 3, "x/new": 4}), ["x/new", "x/wall"])
        self.assertEqual(summary.feature_of_role("bracket/mount_hole/wall"), "bracket/mount_hole")

    def test_worker_fingerprint_matching_passes_the_shared_vectors(self) -> None:
        files = sorted((ROOT / "tests" / "fixtures" / "face-fingerprints").glob("*.json"))
        self.assertGreaterEqual(len(files), 5)
        for path in files:
            case = json.loads(path.read_text(encoding="utf-8"))
            with self.subTest(case=path.name):
                self.assertEqual(fingerprint.match_faces(case["before"], case["after"], case["diagonal"]), case["expected"])


class PureModuleTests(unittest.TestCase):
    def test_pure_modules_never_import_freecad(self) -> None:
        forbidden = {"FreeCAD", "FreeCADGui", "Part", "Sketcher", "PartDesign", "Import", "build123d", "OCP"}
        for relative in PURE:
            tree = ast.parse((ROOT / "python" / "reify_freecad" / relative).read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                names: list[str] = []
                if isinstance(node, ast.Import):
                    names = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    names = [node.module.split(".")[0]]
                self.assertFalse(forbidden & set(names), f"{relative} imports {names}")

    def test_the_freecad_package_never_imports_build123d(self) -> None:
        for path in (ROOT / "python" / "reify_freecad").rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    self.assertFalse({a.name.split(".")[0] for a in node.names} & {"build123d", "OCP", "cadctl"}, str(path))
                elif isinstance(node, ast.ImportFrom) and node.module:
                    self.assertNotIn(node.module.split(".")[0], {"build123d", "OCP", "cadctl"}, str(path))


if __name__ == "__main__":
    unittest.main()
