"""FreeCAD part backend tests. Run with the FreeCAD environment's Python:

    PYTHONPATH=python:<env>/lib node tests/run-py-tests.mjs --layer e2e --systems freecad --python <env>/bin/python

Skipped when FreeCAD cannot be imported (for example under the uv environment), unless
REIFY_REQUIRE_FREECAD=1 is set, in which case the test fails.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from system_requirements import skip_unless_system  # noqa: E402
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python"))
configured = os.environ.get("PI_CAD_FREECAD_PYTHON")
if configured:
    sys.path.insert(1, str(Path(configured).resolve().parents[1] / "lib"))

try:
    import FreeCAD  # noqa: F401
    HAVE_FREECAD = True
except ImportError:
    HAVE_FREECAD = False

if HAVE_FREECAD:
    from reify_freecad.worker import Worker


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Harness:
    """A worker and one document in a temporary project."""

    def __init__(self, name: str = "part", body: str = "part") -> None:
        self.root = Path(tempfile.mkdtemp(prefix="reify-freecad-test-"))
        self.doc = str(self.root / "parts" / f"{name}.FCStd")
        self.step = self.root / "build" / f"{name}.step"
        self.worker = Worker()
        self.body = body
        self.call("open", output=str(self.step), historyDir=str(self.root / ".history"), body=body, create=True)

    def raw(self, op: str, **args: Any) -> dict[str, Any]:
        return self.worker.handle({"id": 1, "op": op, "doc": self.doc, "args": args, "budgetS": 60})

    def call(self, op: str, **args: Any) -> dict[str, Any]:
        response = self.raw(op, **args)
        if not response["ok"]:
            raise AssertionError(f"{op} failed: {json.dumps(response['error'], indent=1)}")
        return response["result"]

    def error(self, op: str, **args: Any) -> dict[str, Any]:
        response = self.raw(op, **args)
        if response["ok"]:
            raise AssertionError(f"{op} unexpectedly succeeded")
        return response["error"]

    def apply(self, ops: list[dict[str, Any]]) -> dict[str, Any]:
        return self.call("apply", ops=ops)

    def session(self) -> Any:
        return self.worker.sessions[self.doc]

    def body_shape(self, path: str | None = None) -> Any:
        from reify_freecad.core import bodies, get_path

        for body in bodies(self.session().doc):
            if get_path(body) == (path or self.body):
                return body.Shape
        raise AssertionError(f"no body {path or self.body}")

    def close(self) -> None:
        self.worker.cmd_close(self.doc, {})
        shutil.rmtree(self.root, ignore_errors=True)


def plate(name: str = "part", width: Any = 60, depth: Any = 30, thickness: float = 6) -> list[dict[str, Any]]:
    return [
        {"op": "sketch", "name": f"{name}/profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [width, depth]}}]},
        {"op": "pad", "name": f"{name}/base", "sketch": f"{name}/profile", "length": thickness},
    ]


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class PartBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness()
        self.addCleanup(self.h.close)

    def assertSingleValidSolid(self, path: str | None = None) -> Any:
        shape = self.h.body_shape(path)
        self.assertTrue(shape.isValid())
        self.assertEqual(len(shape.Solids), 1)
        return shape

    # ------------------------------------------------------------ 1. the nine preferred features

    def test_every_sketch_shape_builds_fully_constrained(self) -> None:
        shapes = [
            {"rect": {"corner": [-30, -15], "size": [60, 30]}},
            {"circle": {"center": [0, 0], "diameter": 8}},
            {"slot": {"start": [-10, 8], "end": [10, 8], "width": 4}},
            {"polyline": {"points": [[20, -10], [28, -10], [28, -4]], "closed": True}},
            {"point": {"at": [0, -10]}},
        ]
        result = self.h.apply([{"op": "sketch", "name": "part/all", "plane": "XY", "shapes": shapes}])
        self.assertEqual(result["warnings"], [], "every shape is fully constrained")
        tree = self.h.call("tree")
        sketch = next(o for o in tree["bodies"][0]["objects"] if o["path"] == "part/all")
        self.assertEqual(sketch["dof"], 0)

    def test_hole_with_counterbore_names_its_faces(self) -> None:
        self.h.apply(plate())
        self.h.apply([
            {"op": "sketch", "name": "part/hole_profile", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"circle": {"center": [0, 0], "diameter": 6}}]},
            {"op": "hole", "name": "part/bolt", "sketch": "part/hole_profile", "diameter": 6, "type": "through_all", "counterbore": {"diameter": 10, "depth": 2}},
        ])
        self.assertSingleValidSolid()
        roles = {o["path"]: o.get("roles") for o in self.h.call("tree")["bodies"][0]["objects"]}
        self.assertEqual(roles["part/bolt"], ["counterbore_floor", "counterbore_wall", "wall"])

    def test_fillet_and_chamfer_on_named_edges(self) -> None:
        self.h.apply(plate())
        self.h.apply([{"op": "fillet", "name": "part/outer_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 1.5}])
        self.assertSingleValidSolid()
        self.h.apply([{"op": "chamfer", "name": "part/lower_bevel", "edges": {"between": [{"feature": "part/base", "role": "bottom"}, {"feature": "part/base", "role": "side.0"}]}, "size": 1}])
        self.assertSingleValidSolid()
        roles = {o["path"]: o.get("roles") for o in self.h.call("tree")["bodies"][0]["objects"]}
        self.assertEqual(roles["part/outer_round"], ["round"])
        self.assertEqual(roles["part/lower_bevel"], ["bevel"])

    def test_rim_edges_are_the_opening_of_a_hole_and_a_pocket(self) -> None:
        self._hole_ready()
        self.h.apply([{"op": "fillet", "name": "part/hole_edge", "edges": {"feature": "part/bolt", "role": "rim"}, "radius": 0.4}])
        self.assertSingleValidSolid()
        self.h.apply([
            {"op": "sketch", "name": "part/slot_profile", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"rect": {"center": [20, 0], "size": [10, 6]}}]},
            {"op": "pocket", "name": "part/cavity", "sketch": "part/slot_profile", "depth": 3},
        ])
        self.h.apply([{"op": "chamfer", "name": "part/cavity_edge", "edges": {"feature": "part/cavity", "role": "rim"}, "size": 0.5}])
        shape = self.assertSingleValidSolid()
        self.assertEqual(len(self.h.call("query", target="part/cavity_edge/bevel", what=["faces"])["faces"]), 4, "one bevel per cavity edge")
        self.assertEqual(len(self.h.call("query", target="part/hole_edge/round", what=["faces"])["faces"]), 1, "one round at the hole's opening")
        self.assertGreater(shape.Volume, 0)

    def _hole_ready(self) -> None:
        self.h.apply(plate("part", 80, 30, 6))
        self.h.apply([
            {"op": "sketch", "name": "part/hole_profile", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"circle": {"center": [-30, 0], "diameter": 5}}]},
            {"op": "hole", "name": "part/bolt", "sketch": "part/hole_profile", "diameter": 5, "type": "through_all"},
        ])

    def test_linear_pattern_names_each_instance(self) -> None:
        self._hole_ready()
        self.h.apply([{"op": "linear_pattern", "name": "part/bolt_row", "features": ["part/bolt"], "direction": "X", "length": 60, "count": 3}])
        self.assertSingleValidSolid()
        wall = self.h.call("query", target="part/bolt/wall@3", what=["faces"])["faces"][0]
        self.assertAlmostEqual(wall["radius"], 2.5, places=3)
        self.assertEqual(len(self.h.call("query", target="part/bolt/wall", what=["faces"])["faces"]), 1, "plain role = first instance")
        self.assertEqual(len(self.h.call("query", target="part/bolt/wall@*", what=["faces"])["faces"]), 3, "wall@* = every instance")
        self.assertAlmostEqual(self.h.call("query", target="part/bolt/wall@2", what=["centroid"])["centroid"][0], 0.0, places=2)

    def test_threaded_and_countersunk_holes(self) -> None:
        self.h.apply(plate("part", 60, 30, 8))
        self.h.apply([
            {"op": "sketch", "name": "part/hole_profile", "on": {"feature": "part/base", "role": "top"},
             "shapes": [{"circle": {"center": [-15, 0], "diameter": 6}}]},
            {"op": "hole", "name": "part/sink", "sketch": "part/hole_profile", "diameter": 6, "type": "through_all",
             "countersink": {"diameter": 12, "angle": 90}},
        ])
        self.assertSingleValidSolid()
        roles = {o["path"]: o.get("roles") for o in self.h.call("tree")["bodies"][0]["objects"]}
        self.assertIn("countersink", roles["part/sink"])
        self.h.apply([
            {"op": "sketch", "name": "part/tap_profile", "on": {"feature": "part/base", "role": "top"},
             "shapes": [{"circle": {"center": [15, 0], "diameter": 6}}]},
            {"op": "hole", "name": "part/tap", "sketch": "part/tap_profile", "diameter": 6, "depth": 5, "thread": "M6"},
        ])
        self.assertSingleValidSolid()
        error = self.h.error("apply", ops=[
            {"op": "sketch", "name": "part/bad_profile", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"circle": {"center": [0, 10], "diameter": 6}}]},
            {"op": "hole", "name": "part/bad_thread", "sketch": "part/bad_profile", "diameter": 6, "depth": 5, "thread": "Q99"},
        ])
        self.assertEqual(error["code"], "HOLE_FAILED")
        self.assertTrue(error["rolledBack"])

    def test_a_named_sketch_dimension_can_be_set_and_bound(self) -> None:
        self.h.apply([{"op": "sketch", "name": "part/profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [60, 30], "name": "outline"}}]},
                      {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 5}])
        constraints = next(o for o in self.h.call("tree")["bodies"][0]["objects"] if o["path"] == "part/profile")["constraints"]
        self.assertEqual({k: constraints[k] for k in ("outline_w", "outline_h")}, {"outline_w": 60.0, "outline_h": 30.0})
        self.h.apply([{"op": "set", "target": "part/profile", "prop": "constraint:outline_w", "value": 80}])
        self.assertAlmostEqual(self.h.body_shape().Volume, 80 * 30 * 5, places=3)
        self.h.apply([{"op": "param", "name": "w", "value": 50, "unit": "mm"}, {"op": "set", "target": "part/profile", "prop": "constraint:outline_w", "value": "=w * 2"}])
        self.assertAlmostEqual(self.h.body_shape().Volume, 100 * 30 * 5, places=3)
        error = self.h.error("apply", ops=[{"op": "set", "target": "part/profile", "prop": "constraint:nope", "value": 1}])
        self.assertEqual(error["code"], "TARGET_NOT_FOUND")

    # ------------------------------------------------------------ 2. recompute scope

    def test_changing_a_parameter_recomputes_only_its_dependents(self) -> None:
        self.h.apply([{"op": "param", "name": "width", "value": 40, "unit": "mm"}] + plate("part", "=width", 20, 5)[:0])
        self.h.apply([
            {"op": "sketch", "name": "part/profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": ["=width", 20]}}]},
            {"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 5},
            {"op": "body", "name": "other"},
            {"op": "sketch", "name": "other/profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [10, 10]}}], "body": "other"},
            {"op": "pad", "name": "other/base", "sketch": "other/profile", "length": 3},
        ])
        result = self.h.apply([{"op": "param", "name": "width", "value": 55}])
        recomputed = set(result["features"]["recomputed"])
        self.assertEqual(recomputed, {"part/profile", "part/base"})
        self.assertEqual(result["params"]["changed"], {"width": [40.0, 55.0]})
        self.assertEqual(result["features"]["added"], [])
        self.assertAlmostEqual(self.h.body_shape("part").Volume, 55 * 20 * 5, places=3)

    # ------------------------------------------------------------ 3-4. failures roll back

    def test_an_impossible_fillet_is_rejected_and_the_file_does_not_change(self) -> None:
        self.h.apply(plate())
        before = digest(Path(self.h.doc))
        error = self.h.error("apply", ops=[{"op": "fillet", "name": "part/too_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 50}])
        self.assertEqual(error["code"], "FILLET_FAILED")
        self.assertTrue(error["rolledBack"])
        self.assertEqual(error["detail"]["failedOpIndex"], 0)
        self.assertIn("reduce radius", error["hints"])
        self.assertEqual(digest(Path(self.h.doc)), before)
        # The document in memory is back too: the same edit with a sane radius works.
        self.h.apply([{"op": "fillet", "name": "part/edge_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 1}])

    def test_conflicting_sketch_constraints_are_reported_with_their_names(self) -> None:
        import Sketcher

        from reify_freecad.ops import sketch as sketch_module

        original = sketch_module._BUILDERS["rect"]

        def conflicting(ctx: Any, sketch: Any, spec: dict[str, Any], prefix: str) -> None:
            original(ctx, sketch, spec, prefix)
            sketch.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 99.0))  # fights the width

        sketch_module._BUILDERS["rect"] = conflicting
        try:
            error = self.h.error("apply", ops=plate())
        finally:
            sketch_module._BUILDERS["rect"] = original
        self.assertIn(error["code"], {"SKETCH_CONFLICTING", "SKETCH_REDUNDANT"})
        self.assertTrue(error["rolledBack"])
        self.assertTrue(error["detail"]["constraints"])
        self.assertEqual(error["target"], "part/profile")

    def test_open_profile_and_degenerate_shapes_have_their_own_codes(self) -> None:
        error = self.h.error("apply", ops=[
            {"op": "sketch", "name": "part/open", "plane": "XY", "shapes": [{"polyline": {"points": [[0, 0], [10, 0], [10, 10]], "closed": False}}]},
            {"op": "pad", "name": "part/open_pad", "sketch": "part/open", "length": 3},
        ])
        self.assertEqual(error["code"], "SKETCH_PROFILE_NOT_CLOSED")
        error = self.h.error("apply", ops=[{"op": "sketch", "name": "part/zero", "plane": "XY", "shapes": [{"rect": {"corner": [0, 0], "size": [0, 10]}}]}])
        self.assertEqual(error["code"], "SKETCH_MALFORMED")

    def test_input_errors_have_stable_codes(self) -> None:
        self.h.apply(plate())
        cases = [
            ([{"op": "pad", "name": "part/base", "sketch": "part/profile", "length": 1}], "NAME_CONFLICT"),
            ([{"op": "pad", "name": "part/x", "sketch": "part/missing", "length": 1}], "TARGET_NOT_FOUND"),
            ([{"op": "set", "target": "part/base", "prop": "Placement", "value": 1}], "PROP_NOT_ALLOWED"),
            ([{"op": "delete", "target": "part/profile"}], "HAS_DEPENDENTS"),
            ([{"op": "param", "name": "q", "value": "=nosuch * 2"}], "EXPRESSION_INVALID"),
            ([{"op": "pad", "name": "3", "sketch": "part/profile", "length": 1}], "OP_SCHEMA_INVALID"),
            ([{"op": "weld", "name": "part/w"}], "OP_SCHEMA_INVALID"),
            ([{"op": "pad", "name": "part/round", "sketch": "part/profile", "length": 1}], "NAME_CONFLICT"),  # a role name cannot end a feature path
        ]
        for ops, code in cases:
            with self.subTest(code=code, op=ops[0]["op"]):
                error = self.h.error("apply", ops=ops)
                self.assertEqual(error["code"], code, error)
                if code != "OP_SCHEMA_INVALID":
                    self.assertTrue(error["rolledBack"])

    def test_an_edge_selector_that_matches_nothing_lists_known_names(self) -> None:
        self.h.apply(plate())
        error = self.h.error("apply", ops=[{"op": "fillet", "name": "part/r", "edges": {"feature": "part/base", "role": "rim"}, "radius": 1}])
        self.assertEqual(error["code"], "TARGET_NOT_FOUND")
        self.assertIn("part/base/top_outer", error["detail"]["known"])

    def test_two_pad_solids_that_do_not_touch_are_refused(self) -> None:
        self.h.apply(plate())
        error = self.h.error("apply", ops=[
            {"op": "sketch", "name": "part/far", "plane": "XY", "offset": 20, "shapes": [{"rect": {"center": [0, 0], "size": [5, 5]}}]},
            {"op": "pad", "name": "part/far_pad", "sketch": "part/far", "length": 3},
        ])
        self.assertEqual(error["code"], "RESULT_MULTIPLE_SOLIDS")
        self.assertEqual(error["detail"]["solids"], 2)

    # ------------------------------------------------------------ 5. role stability

    def test_the_hole_wall_role_survives_every_kind_of_edit(self) -> None:
        self.h.apply(plate("bracket", 60, 30, 6))
        self.h.close()
        self.h = Harness("bracket", "bracket")
        self.h.apply(plate("bracket", 60, 30, 6))
        self.h.apply([
            {"op": "param", "name": "hole_d", "value": 6, "unit": "mm"},
            {"op": "sketch", "name": "bracket/hole_profile", "on": {"feature": "bracket/base", "role": "top"}, "shapes": [{"circle": {"center": [10, 0], "diameter": "=hole_d"}}]},
            {"op": "hole", "name": "bracket/mount_hole", "sketch": "bracket/hole_profile", "diameter": "=hole_d", "type": "through_all"},
        ])
        record: list[str] = []

        def check_wall(step: str, radius: float) -> None:
            wall = self.h.call("query", target="bracket/mount_hole/wall", what=["faces", "centroid"])
            face = wall["faces"][0]
            self.assertEqual(len(wall["faces"]), 1, step)
            self.assertEqual(face["type"], "cylinder", step)
            self.assertAlmostEqual(face["radius"], radius, places=3, msg=step)
            self.assertAlmostEqual(wall["centroid"][0], 10.0, places=3, msg=step)
            record.append(f"{step}: wall is a cylinder of radius {face['radius']} at x={wall['centroid'][0]}")

        check_wall("initial", 3.0)
        self.h.apply([{"op": "set", "target": "Params", "prop": "hole_d", "value": 8}])
        check_wall("hole diameter 6 -> 8", 4.0)
        self.h.apply([{"op": "set", "target": "bracket/base", "prop": "Length", "value": 10}])
        check_wall("plate thickness 6 -> 10", 4.0)
        self.h.apply([{"op": "fillet", "name": "bracket/edge_round", "edges": {"feature": "bracket/base", "role": "top_outer"}, "radius": 1.5}])
        check_wall("fillet on the outer edge", 4.0)
        self.h.apply([
            {"op": "sketch", "name": "bracket/slot_profile", "on": {"feature": "bracket/base", "role": "top"}, "shapes": [{"slot": {"start": [-20, 0], "end": [-10, 0], "width": 5}}]},
            {"op": "pocket", "name": "bracket/slot", "sketch": "bracket/slot_profile", "depth": 4, "type": "through_all"},
        ])
        check_wall("slot pocket added", 4.0)
        self.assertEqual(len(record), 5)
        print("\n".join(record))

    # ------------------------------------------------------------ 6. undo

    def test_undo_restores_the_previous_revision_byte_for_byte(self) -> None:
        self.h.apply(plate())
        first = digest(Path(self.h.doc))
        self.h.apply([{"op": "fillet", "name": "part/edge_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 1}])
        self.assertNotEqual(digest(Path(self.h.doc)), first)
        result = self.h.call("undo")
        self.assertEqual(result["rev"], 1)
        self.assertEqual(digest(Path(self.h.doc)), first)
        self.assertTrue(Path(result["step"]).is_file())
        log = Path(self.h.doc + ".ops.jsonl").read_text().strip().splitlines()
        self.assertEqual(len(log), 1)
        self.assertEqual(json.loads(log[0])["fcstdSha256"], first)
        # Going back to the empty revision 0 needs an explicit argument.
        refused = self.h.error("undo")
        self.assertEqual(refused["code"], "UNDO_WOULD_EMPTY")
        self.assertEqual(self.h.call("tree")["rev"], 1)
        self.assertEqual(digest(Path(self.h.doc)), first)
        self.assertEqual(self.h.call("undo", to_empty=True)["rev"], 0)
        self.assertEqual(self.h.error("undo")["code"], "NOTHING_TO_UNDO")

    def test_rolled_back_failure_says_the_revision_and_that_undo_is_not_needed(self) -> None:
        self.h.apply(plate())
        before = digest(Path(self.h.doc))
        error = self.h.error("apply", ops=[{"op": "fillet", "name": "part/too_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 500}])
        self.assertEqual(error["code"], "FILLET_FAILED")
        self.assertTrue(error["rolledBack"])
        self.assertIn("revision 1", error["message"])
        self.assertIn("Do NOT call undo", error["message"])
        self.assertTrue(any("undo is not needed" in hint for hint in error["hints"]))
        self.assertIn("reduce radius", error["hints"])  # the original hints stay
        self.assertEqual(error["detail"]["rev"], 1)
        # The state the message describes is the state on disk; an undo now is refused.
        self.assertEqual(digest(Path(self.h.doc)), before)
        self.assertEqual(self.h.error("undo")["code"], "UNDO_WOULD_EMPTY")
        self.assertEqual(self.h.call("tree")["rev"], 1)

    def test_try_changes_nothing(self) -> None:
        self.h.apply(plate())
        before = digest(Path(self.h.doc))
        trial = self.h.root / "trial.step"
        result = self.h.call("try", ops=[{"op": "set", "target": "part/base", "prop": "Length", "value": 20}], output=str(trial))
        self.assertTrue(trial.is_file())
        self.assertEqual(result["rev"], 1)
        self.assertEqual(digest(Path(self.h.doc)), before)
        self.assertAlmostEqual(self.h.body_shape().Volume, 60 * 30 * 6, places=3)

    # ------------------------------------------------------------ 8. budget

    def test_a_check_over_budget_stops_and_the_next_request_works(self) -> None:
        self.h.apply(plate())
        response = self.h.worker.handle({
            "id": 1, "op": "check", "doc": self.h.doc, "budgetS": 0.01,
            "args": {"kind": "wall_thickness", "args": {"target": "part", "samples": 5000}},
        })
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "BUDGET_EXCEEDED")
        self.assertAlmostEqual(self.h.call("query", target="part/base", what=["volume"])["volumeMm3"], 60 * 30 * 6, places=3)

    # ------------------------------------------------------------ extras the Agent relies on

    def test_requirements_are_evaluated_after_every_apply(self) -> None:
        self.h.apply(plate())
        result = self.h.apply([
            {"op": "require", "name": "part/max_mass", "kind": "max_mass", "target": "part", "limit": 5.0},
            {"op": "require", "name": "part/fits", "kind": "bbox_within", "target": "part", "limit": [100, 100, 100]},
            {"op": "require", "name": "part/thickness", "kind": "dimension", "target": {"target": "part/base", "prop": "Length"}, "limit": 6, "tolerance": 0.01},
        ])
        status = {item["path"]: item["status"] for item in result["intent"]}
        self.assertEqual(status, {"part/max_mass": "fail", "part/fits": "pass", "part/thickness": "pass"})
        self.assertAlmostEqual(next(i for i in result["intent"] if i["path"] == "part/max_mass")["value"], 29.16, places=2)
        self.assertEqual(self.h.apply([{"op": "set", "target": "part/base", "prop": "Length", "value": 1}])["intent"][2]["status"], "fail")

    def test_rename_moves_children_and_requirements(self) -> None:
        self.h.apply(plate())
        self.h.apply([{"op": "rename", "target": "part/base", "to": "part/plate"}])
        roles = {o["path"] for o in self.h.call("tree")["bodies"][0]["objects"]}
        self.assertIn("part/plate", roles)
        self.assertNotIn("part/base", roles)
        self.assertEqual(self.h.call("query", target="part/plate/top", what=["area"])["areaMm2"], 1800.0)

    def test_declarations_name_every_role_face(self) -> None:
        result = self.h.apply(plate())
        document = json.loads(Path(result["declarations"]).read_text())
        paths = [item["path"] for item in document["entities"]]
        self.assertEqual(document["assembly"], "part")
        self.assertEqual(paths[0], "part")
        for role in ("bottom", "side.0", "side.1", "side.2", "side.3", "top"):
            self.assertIn(f"part/base/{role}", paths)
        selector = next(i for i in document["entities"] if i["path"] == "part/base/top")["selector"]
        self.assertEqual((selector["type"], selector["normal"]), ("plane", [0.0, 0.0, 1.0]))

    def test_the_document_reopens_with_the_same_model(self) -> None:
        self.h.apply(plate())
        volume = self.h.body_shape().Volume
        self.h.call("close")
        reopened = self.h.call("open", output=str(self.h.step), historyDir=str(self.h.root / ".history"), body="part", create=False)
        self.assertEqual(reopened["rev"], 1)
        self.assertAlmostEqual(self.h.body_shape().Volume, volume, places=6)
        self.assertEqual(reopened["bodies"], ["part"])


if __name__ == "__main__":
    unittest.main()
