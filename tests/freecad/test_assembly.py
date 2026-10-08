"""Assemblies: linked parts, imported STEP, joints, change propagation, named export."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_part_backend import HAVE_FREECAD, ROOT  # noqa: E402

if HAVE_FREECAD:
    import FreeCAD as App
    import Part
    from reify_freecad.worker import Worker


class Project:
    """One worker, several documents in one temporary project (as in a Prime session)."""

    def __init__(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="reify-assembly-test-"))
        self.worker = Worker()

    def path(self, relative: str) -> str:
        return str(self.root / relative)

    def raw(self, relative: str, op: str, **args: Any) -> dict[str, Any]:
        return self.worker.handle({"id": 1, "op": op, "doc": self.path(relative), "args": args, "budgetS": 60})

    def call(self, relative: str, op: str, **args: Any) -> dict[str, Any]:
        response = self.raw(relative, op, **args)
        if not response["ok"]:
            raise AssertionError(f"{op} {relative} failed: {json.dumps(response['error'], indent=1)}")
        return response["result"]

    def error(self, relative: str, op: str, **args: Any) -> dict[str, Any]:
        response = self.raw(relative, op, **args)
        if response["ok"]:
            raise AssertionError(f"{op} {relative} unexpectedly succeeded")
        return response["error"]

    def open(self, relative: str, body: str) -> dict[str, Any]:
        stem = Path(relative).stem
        return self.call(
            relative, "open", output=self.path(f"build/{stem}.step"), historyDir=self.path(f".history/{stem}"),
            root=str(self.root), body=body, create=True,
        )

    def close(self) -> None:
        for relative in list(self.worker.sessions):
            self.worker.cmd_close(relative, {})
        self.worker.registry.close()
        shutil.rmtree(self.root, ignore_errors=True)


def base_part() -> list[dict[str, Any]]:
    """A 50 x 50 x 6 plate with a 8 mm hole in the middle."""
    return [
        {"op": "sketch", "name": "base/plate_profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [50, 50]}}]},
        {"op": "pad", "name": "base/plate", "sketch": "base/plate_profile", "length": 6},
        {"op": "sketch", "name": "base/pivot_profile", "on": {"feature": "base/plate", "role": "top"}, "shapes": [{"circle": {"center": [0, 0], "diameter": 8}}]},
        {"op": "hole", "name": "base/pivot", "sketch": "base/pivot_profile", "diameter": 8, "type": "through_all"},
    ]


def arm_part() -> list[dict[str, Any]]:
    """An 80 x 10 x 6 link centred on its 8 mm bearing hole."""
    return [
        {"op": "sketch", "name": "link/arm_profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [80, 10]}}]},
        {"op": "pad", "name": "link/arm", "sketch": "link/arm_profile", "length": 6},
        {"op": "sketch", "name": "link/bearing_profile", "on": {"feature": "link/arm", "role": "top"}, "shapes": [{"circle": {"center": [0, 0], "diameter": 8}}]},
        {"op": "hole", "name": "link/bearing", "sketch": "link/bearing_profile", "diameter": 8, "type": "through_all"},
    ]


def collision_angle() -> float:
    """First angle at which a link of half length 40 and half width 5 turning about the origin hits the post, by brute force."""
    post = [(30, 15), (40, 15), (30, 25), (40, 25)]
    angle = 0.0
    while angle < 90:
        c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
        link = [(x * c - y * s, x * s + y * c) for x, y in [(-40, -5), (40, -5), (40, 5), (-40, 5)]]
        post_in_link = any(abs(x * c + y * s) <= 40 and abs(-x * s + y * c) <= 5 for x, y in post)
        link_in_post = any(30 <= x <= 40 and 15 <= y <= 25 for x, y in link)
        if post_in_link or link_in_post:
            return angle
        angle += 0.001
    raise AssertionError("no collision")


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class AssemblyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.p = Project()
        self.addCleanup(self.p.close)
        # Two part documents, each owned by its own author.
        self.p.open("parts/base.FCStd", "base")
        self.p.call("parts/base.FCStd", "apply", ops=base_part())
        self.p.open("parts/link.FCStd", "link")
        self.p.call("parts/link.FCStd", "apply", ops=arm_part())
        # A bought-in post: a STEP file from elsewhere.
        shape = Part.makeBox(10, 10, 20)
        (self.p.root / "imports").mkdir()
        shape.exportStep(self.p.path("imports/post.step"))
        self.p.open("assembly/arm.FCStd", "arm")

    def build_assembly(self) -> dict[str, Any]:
        return self.p.call("assembly/arm.FCStd", "apply", ops=[
            {"op": "param", "name": "j1_angle", "value": 0, "unit": "deg"},
            {"op": "link", "name": "arm/base", "part": "parts/base.FCStd", "body": "base"},
            {"op": "link", "name": "arm/link", "part": "parts/link.FCStd", "body": "link"},
            {"op": "import_step", "name": "arm/post", "file": "imports/post.step", "position": [30, 15, 0]},
            {"op": "joint", "name": "arm/j1", "type": "revolute", "flip": True, "value": "=j1_angle", "limits": [-90, 90],
             "parent": {"feature": "arm/base/plate", "role": "top"}, "child": {"feature": "arm/link/arm", "role": "bottom"}},
        ])

    def unit_box(self, path: str) -> Any:
        from reify_freecad.assembly import unit_by_path

        return unit_by_path(self.p.worker.sessions[self.p.path("assembly/arm.FCStd")], path).shape().BoundBox

    def test_occurrences_carry_the_paths_of_their_part(self) -> None:
        result = self.build_assembly()
        self.assertTrue(Path(result["step"]).is_file())
        tree = self.p.call("assembly/arm.FCStd", "tree")
        kinds = {item["path"]: item["kind"] for item in tree["occurrences"]}
        self.assertEqual(kinds, {"arm/base": "occurrence", "arm/link": "occurrence", "arm/post": "reference"})
        self.assertEqual(next(i for i in tree["occurrences"] if i["path"] == "arm/post")["solids"], 1)
        # A role of a part, named through the occurrence.
        wall = self.p.call("assembly/arm.FCStd", "query", target="arm/base/pivot/wall", what=["faces"])["faces"][0]
        self.assertEqual((wall["type"], round(wall["radius"], 3)), ("cylinder", 4.0))
        # The plane the link sits on is the top of the base plate: the joint put it there.
        box = self.unit_box("arm/link")
        self.assertAlmostEqual(box.ZMin, 6.0, places=4)
        self.assertAlmostEqual(box.ZMax, 12.0, places=4)

    def test_the_joint_turns_the_link_and_reports_its_limits(self) -> None:
        self.build_assembly()
        self.p.call("assembly/arm.FCStd", "apply", ops=[{"op": "param", "name": "j1_angle", "value": 90}])
        box = self.unit_box("arm/link")
        self.assertAlmostEqual(box.XLength, 10.0, places=3, msg="turned a quarter: the 80 mm side now runs along y")
        self.assertAlmostEqual(box.YLength, 80.0, places=3)
        result = self.p.call("assembly/arm.FCStd", "apply", ops=[{"op": "param", "name": "j1_angle", "value": 120}])
        limit = next(item for item in result["intent"] if item["path"] == "arm/j1")
        self.assertEqual((limit["status"], limit["value"], limit["limit"]), ("fail", 120.0, [-90.0, 90.0]))

    def test_a_joint_sweep_finds_the_known_collision_angle(self) -> None:
        self.build_assembly()
        step = 5.0
        sweep = self.p.call(
            "assembly/arm.FCStd", "sweep", param="j1_angle", range=[0, 90], step=step,
            check={"kind": "interference", "args": {"all": True}}, refine=True,
        )
        self.assertLessEqual(abs(sweep["firstFailure"] - collision_angle()), step / 8 + 0.02, sweep["firstFailure"])
        sweep_joint = self.p.call(
            "assembly/arm.FCStd", "sweep", param="arm/j1", range=[0, 90], step=step,
            check={"kind": "clearance", "args": {"a": "arm/link", "b": "arm/post"}}, refine=True,
        )
        self.assertLessEqual(abs(sweep_joint["firstFailure"] - collision_angle()), step / 8 + 0.02, "a joint name replaces the parameter")
        self.assertEqual(self.p.call("assembly/arm.FCStd", "tree")["joints"][0]["value"], 0.0, "the sweep restores the joint")

    def test_checks_use_occurrence_paths(self) -> None:
        self.build_assembly()
        clearance = self.p.call("assembly/arm.FCStd", "check", kind="clearance", args={"a": "arm/link", "b": "arm/post"})
        self.assertGreater(clearance["value"], 5.0)
        none = self.p.call("assembly/arm.FCStd", "check", kind="interference", args={"all": True})
        self.assertEqual(none["value"], 0.0)
        names = {entry["a"] for entry in none["pairs"]} | {entry["b"] for entry in none["pairs"]}
        self.assertEqual(names, {"arm/base", "arm/link", "arm/post"})
        self.p.call("assembly/arm.FCStd", "apply", ops=[{"op": "param", "name": "j1_angle", "value": 30}])
        hit = self.p.call("assembly/arm.FCStd", "check", kind="interference", args={"all": True})
        self.assertGreater(hit["value"], 0.0)
        mass = self.p.call("assembly/arm.FCStd", "check", kind="mass", args={})
        self.assertGreater(mass["value"], 0.0)

    def test_a_new_revision_of_a_part_reaches_the_assembly(self) -> None:
        self.build_assembly()
        self.p.call("parts/base.FCStd", "apply", ops=[{"op": "set", "target": "base/plate", "prop": "Length", "value": 10}])
        result = self.p.call("assembly/arm.FCStd", "apply", ops=[{"op": "param", "name": "j1_angle", "value": 5}])
        self.assertIn("arm/base", result["features"]["recomputed"])
        self.assertAlmostEqual(self.unit_box("arm/link").ZMin, 10.0, places=4, msg="the joint re-seated the link on the thicker plate")
        self.assertTrue(any(path.startswith("arm/base/") for path in result["highlight"]["paths"]))
        # Another process changes the part file: the assembly notices on its next call.
        script = (
            "import sys; from reify_freecad.worker import Worker; w = Worker(); doc = sys.argv[1]\n"
            "w.handle({'id': 1, 'op': 'open', 'doc': doc, 'args': {'output': sys.argv[2], 'historyDir': sys.argv[3], 'root': sys.argv[4]}})\n"
            "r = w.handle({'id': 2, 'op': 'apply', 'doc': doc, 'args': {'ops': [{'op': 'set', 'target': 'base/plate', 'prop': 'Length', 'value': 14}]}})\n"
            "assert r['ok'], r\n"
        )
        env = {**__import__("os").environ, "PYTHONPATH": str(ROOT / "python") + ":" + __import__("os").environ.get("PYTHONPATH", "")}
        subprocess.run([sys.executable, "-c", script, self.p.path("parts/base.FCStd"), self.p.path("build/o.step"), self.p.path(".history/o"), str(self.p.root)], check=True, env=env)
        opened = self.p.call("assembly/arm.FCStd", "open", output=self.p.path("build/arm.step"), historyDir=self.p.path(".history/arm"), root=str(self.p.root), body="arm")
        self.assertIn("arm/base", opened["features"]["recomputed"])
        self.assertAlmostEqual(self.unit_box("arm/link").ZMin, 14.0, places=4)

    def test_a_part_document_cannot_be_changed_through_its_occurrence(self) -> None:
        self.build_assembly()
        error = self.p.error("assembly/arm.FCStd", "apply", ops=[{"op": "fillet", "name": "arm/r", "edges": {"feature": "arm/base/plate", "role": "top_outer"}, "radius": 1}])
        self.assertEqual(error["code"], "OP_SCHEMA_INVALID")
        self.assertIn("parts/base.FCStd", " ".join(error["hints"]))
        error = self.p.error("assembly/arm.FCStd", "apply", ops=[{"op": "link", "name": "arm/x", "part": "parts/missing.FCStd", "body": "x"}])
        self.assertEqual(error["code"], "TARGET_NOT_FOUND")
        error = self.p.error("assembly/arm.FCStd", "apply", ops=[{"op": "link", "name": "arm/x", "part": "parts/base.FCStd", "body": "nope"}])
        self.assertEqual(error["detail"]["known"], ["base"])

    def test_delete_and_rename_respect_joints(self) -> None:
        self.build_assembly()
        error = self.p.error("assembly/arm.FCStd", "apply", ops=[{"op": "delete", "target": "arm/link"}])
        self.assertEqual(error["code"], "HAS_DEPENDENTS")
        self.assertEqual(error["detail"]["dependents"], ["arm/j1"])
        self.p.call("assembly/arm.FCStd", "apply", ops=[{"op": "rename", "target": "arm/link", "to": "arm/forearm"}])
        self.assertEqual(self.p.call("assembly/arm.FCStd", "tree")["joints"][0]["child"]["unit"], "arm/forearm")
        self.p.call("assembly/arm.FCStd", "apply", ops=[{"op": "delete", "target": "arm/j1"}, {"op": "delete", "target": "arm/forearm"}])
        self.assertEqual([i["path"] for i in self.p.call("assembly/arm.FCStd", "tree")["occurrences"]], ["arm/base", "arm/post"])

    def test_an_imported_surface_model_is_a_reference_with_a_warning(self) -> None:
        shell = Part.makeBox(10, 10, 10).Shells[0]
        shell.exportStep(self.p.path("imports/shell.step"))
        result = self.p.call("assembly/arm.FCStd", "apply", ops=[
            {"op": "link", "name": "arm/base", "part": "parts/base.FCStd", "body": "base"},
            {"op": "import_step", "name": "arm/cover", "file": "imports/shell.step"},
        ])
        self.assertEqual([w["code"] for w in result["warnings"]], ["REFERENCE_SURFACES_ONLY"])
        self.assertTrue(Path(result["step"]).is_file())

    def test_the_exported_assembly_names_every_occurrence(self) -> None:
        result = self.build_assembly()
        document = json.loads(Path(result["declarations"]).read_text())
        instances = {e["path"]: e.get("solidIndex") for e in document["entities"] if e["call"] == "instance"}
        self.assertEqual(sorted(instances), ["arm/base", "arm/link", "arm/post"])
        self.assertEqual(sorted(instances.values()), [0, 1, 2])
        features = {e["path"] for e in document["entities"] if e["call"] == "feature"}
        self.assertIn("arm/base/pivot", features)
        self.assertIn("arm/link/bearing", features)
        uv = shutil.which("uv")
        if uv is None:
            self.skipTest("uv is needed to read the STEP back with cadctl")
        env = {"PYTHONPATH": str(ROOT / "python"), "PATH": "/usr/bin:/bin", "HOME": str(self.p.root), "PYTHONDONTWRITEBYTECODE": "1"}
        bound = subprocess.run([uv, "run", "--project", str(ROOT / "python"), "python", "-m", "cadctl", "bind-identity", "--artifact", result["step"], "--declarations", result["declarations"]],
                               capture_output=True, text=True, env={**env, "PATH": f"{Path(uv).parent}:/usr/bin:/bin"}, cwd=self.p.root)
        envelope = json.loads(bound.stdout.strip().splitlines()[-1])
        self.assertTrue(envelope["ok"], envelope)
        for flag, names in (("--focus-json", ["arm/link"]), ("--hide-json", ["arm/post"]), ("--focus-json", ["arm/base/pivot"])):
            render = subprocess.run([uv, "run", "--project", str(ROOT / "python"), "python", "-m", "cadctl", "render", "--artifact", result["step"], "--out-dir", str(self.p.root / "views"), "--views", "iso", flag, json.dumps(names)],
                                    capture_output=True, text=True, env={**env, "PATH": f"{Path(uv).parent}:/usr/bin:/bin"}, cwd=self.p.root)
            self.assertTrue(json.loads(render.stdout.strip().splitlines()[-1])["ok"], f"render {flag} {names} by occurrence name")
        tree = subprocess.run([uv, "run", "--project", str(ROOT / "python"), "python", "-m", "cadctl", "assembly-tree", "--artifact", result["step"]],
                              capture_output=True, text=True, env={**env, "PATH": f"{Path(uv).parent}:/usr/bin:/bin"}, cwd=self.p.root)
        payload = json.loads(tree.stdout.strip().splitlines()[-1])["payload"]
        labels = {occurrence["label"] for occurrence in payload["occurrences"]}
        self.assertEqual(labels, {"arm/base", "arm/link", "arm/post"})
        link = next(o for o in payload["occurrences"] if o["label"] == "arm/link")
        self.assertAlmostEqual(link["world"]["position"][2], 6.0, places=3, msg="the placement is in the STEP")

def grooved_shaft() -> list[dict[str, Any]]:
    """A 10 mm x 40 mm shaft with a groove at mid height: the groove cuts its side into two bands."""
    return [
        {"op": "sketch", "name": "shaft/profile", "plane": "XY", "shapes": [{"circle": {"center": [0, 0], "diameter": 10}}]},
        {"op": "pad", "name": "shaft/cyl", "sketch": "shaft/profile", "length": 40},
        {"op": "sketch", "name": "shaft/groove_profile", "plane": "XY", "offset": 20,
         "shapes": [{"circle": {"center": [0, 0], "diameter": 14}}, {"circle": {"center": [0, 0], "diameter": 8}}]},
        {"op": "pocket", "name": "shaft/groove", "sketch": "shaft/groove_profile", "depth": 3},
    ]


class SplitFaceTests(unittest.TestCase):
    """A.2: faces that one created face is split into keep distinct, stable names."""

    def setUp(self) -> None:
        self.p = Project()
        self.addCleanup(self.p.close)
        self.p.open("parts/shaft.FCStd", "shaft")
        self.p.call("parts/shaft.FCStd", "apply", ops=grooved_shaft())

    def face_z(self, doc: str, target: str) -> float:
        faces = self.p.call(doc, "query", target=target, what=["faces"])["faces"]
        self.assertEqual(len(faces), 1, f"{target} must name exactly one face")
        return faces[0]["center"][2]

    def test_every_piece_of_a_split_face_has_its_own_name(self) -> None:
        roles = {item["path"]: item.get("roles") for item in self.p.call("parts/shaft.FCStd", "tree")["bodies"][0]["objects"]}
        self.assertEqual(roles["shaft/cyl"], ["bottom", "side.0~0", "side.0~1", "top"])
        self.assertEqual(roles["shaft/groove"], ["floor", "wall.1~0", "wall.1~1"])
        low = self.face_z("parts/shaft.FCStd", "shaft/cyl/side.0~0")
        high = self.face_z("parts/shaft.FCStd", "shaft/cyl/side.0~1")
        self.assertLess(low, 20.0 - 1e-6)
        self.assertGreater(high, 20.0 + 1e-6)
        both = self.p.call("parts/shaft.FCStd", "query", target="shaft/cyl/side.0", what=["faces"])["faces"]
        self.assertEqual(len(both), 2, "the logical face name still selects every piece")

    def test_the_declarations_name_each_piece_once(self) -> None:
        self.p.open("assembly/twin.FCStd", "twin")
        result = self.p.call("assembly/twin.FCStd", "apply", ops=[
            {"op": "link", "name": "twin/left", "part": "parts/shaft.FCStd", "body": "shaft"},
            {"op": "link", "name": "twin/right", "part": "parts/shaft.FCStd", "body": "shaft", "position": [30, 0, 0]},
        ])
        entities = json.loads(Path(result["declarations"]).read_text())["entities"]
        paths = [e["path"] for e in entities]
        self.assertEqual(len(paths), len(set(paths)), "every declared path is unique")
        faces = {e["path"]: e for e in entities if e["call"] == "faces"}
        for unit in ("twin/left", "twin/right"):
            for piece in ("side.0~0", "side.0~1"):
                entity = faces[f"{unit}/cyl/{piece}"]
                self.assertEqual((entity["expect"], entity["selector"]["type"]), ("one", "cylinder"))
                self.assertIn("bboxCenter", entity["selector"], "the pieces of one cylinder are told apart by position")
        self.assertNotEqual(faces["twin/left/cyl/side.0~0"]["selector"]["bboxCenter"], faces["twin/left/cyl/side.0~1"]["selector"]["bboxCenter"])

    def test_the_names_survive_dimension_edits(self) -> None:
        self.p.call("parts/shaft.FCStd", "apply", ops=[
            {"op": "set", "target": "shaft/cyl", "prop": "Length", "value": 60},
            {"op": "set", "target": "shaft/groove", "prop": "Length", "value": 5},
        ])
        self.assertLess(self.face_z("parts/shaft.FCStd", "shaft/cyl/side.0~0"), self.face_z("parts/shaft.FCStd", "shaft/cyl/side.0~1"))
        self.assertGreater(self.face_z("parts/shaft.FCStd", "shaft/cyl/side.0~1"), 20.0)

    def test_the_two_halves_of_a_seam_split_cylinder_are_ordered_by_angle(self) -> None:
        from reify_freecad.roles import _order_key

        frame = (App.Vector(), App.Vector(1, 0, 0), App.Vector(0, 1, 0), App.Vector(0, 0, 1))
        halves = [Part.makeCylinder(5, 40, App.Vector(), App.Vector(0, 0, 1), 180), Part.makeCylinder(5, 40, App.Vector(), App.Vector(0, 0, 1), 180)]
        halves[1].rotate(App.Vector(), App.Vector(0, 0, 1), 180)
        sides = [next(f for f in half.Faces if isinstance(f.Surface, Part.Cylinder)) for half in halves]
        keys = [_order_key(face, frame) for face in sides]
        self.assertAlmostEqual(keys[0][3], keys[1][3], places=6)
        self.assertAlmostEqual(keys[0][4], 90.0, places=3)
        self.assertAlmostEqual(keys[1][4], 270.0, places=3)

    def test_the_same_part_can_be_linked_twice(self) -> None:
        self.p.open("assembly/twin.FCStd", "twin")
        result = self.p.call("assembly/twin.FCStd", "apply", ops=[
            {"op": "link", "name": "twin/left", "part": "parts/shaft.FCStd", "body": "shaft"},
            {"op": "link", "name": "twin/right", "part": "parts/shaft.FCStd", "body": "shaft", "position": [30, 0, 0]},
            {"op": "joint", "name": "twin/lift", "type": "prismatic", "flip": True, "value": 5,
             "parent": {"feature": "twin/left/cyl", "role": "top"}, "child": {"feature": "twin/right/cyl", "role": "bottom"}},
        ])
        self.assertIn("twin/right/cyl/side.0~1", result["highlight"]["paths"])
        for unit in ("twin/left", "twin/right"):
            for piece in ("side.0~0", "side.0~1"):
                self.face_z("assembly/twin.FCStd", f"{unit}/cyl/{piece}")
        self.assertGreater(self.face_z("assembly/twin.FCStd", "twin/right/cyl/side.0~0"), 45.0, "the right shaft stands 5 mm above the left one")
        clearance = self.p.call("assembly/twin.FCStd", "check", kind="clearance", args={"a": "twin/left", "b": "twin/right"})
        self.assertAlmostEqual(clearance["value"], 5.0, places=3)
        none = self.p.call("assembly/twin.FCStd", "check", kind="interference", args={"all": True})
        self.assertEqual(none["value"], 0.0)
        self.assertEqual({e["a"] for e in none["pairs"]} | {e["b"] for e in none["pairs"]}, {"twin/left", "twin/right"})

    def test_a_joint_on_a_split_face_names_the_pieces(self) -> None:
        self.p.open("assembly/twin.FCStd", "twin")
        error = self.p.error("assembly/twin.FCStd", "apply", ops=[
            {"op": "link", "name": "twin/left", "part": "parts/shaft.FCStd", "body": "shaft"},
            {"op": "link", "name": "twin/right", "part": "parts/shaft.FCStd", "body": "shaft"},
            {"op": "joint", "name": "twin/fit", "type": "fixed",
             "parent": {"feature": "twin/left/cyl", "role": "side.0"}, "child": {"feature": "twin/right/cyl", "role": "top"}},
        ])
        self.assertEqual(error["code"], "TARGET_AMBIGUOUS")
        self.assertEqual(sorted(c["face"] for c in error["detail"]["candidates"]), ["twin/left/cyl/side.0~0", "twin/left/cyl/side.0~1"])


if __name__ == "__main__":
    unittest.main()
