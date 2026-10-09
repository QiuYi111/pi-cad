"""Identity protocol regression tests.

Every geometric expectation here is derived independently: from the fixture's
own parameters, or from the STEP file itself.  No test re-reads a declaration
and compares it with the same declaration.
"""

from __future__ import annotations

import json
import math
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build123d as bd

from cadctl.identity import (
    Assembly,
    IdentityError,
    IdentityIndex,
    canonicalize_path,
    decode_segment,
    encode_segment,
    join_path,
    reset as reset_identity,
    write_manifest,
)
from cadctl.identity.artifact import ArtifactModel
from cadctl.mesh import mesh_document
from cadctl.render import _resolve_parts, _selection_index
from cadctl.model import run_source
from cadctl.probe import run_probe

FIXTURES = Path(__file__).parent / "fixtures" / "identity"
SIMPLE = "simple_plate.py"
NESTED = "nested_assembly.py"
OVERLAPPING = "overlapping_occurrences.py"


def _build(source_name: str, output: Path, parameters: dict | None = None) -> tuple[Path, dict | None]:
    result = run_source(FIXTURES / source_name, output, parameters=parameters)
    if result["exitCode"] != 0:
        raise AssertionError(f"model failed:\n{result.get('stderr', '')}")
    assembly = result.get("identity")
    if assembly is None:
        return output, None
    _, manifest = write_manifest(
        assembly,
        output,
        source_files=result.get("sourceFiles"),
        parameters=parameters,
    )
    return output, manifest


def _shape(path: Path):
    return bd.import_step(str(path))


def _solid_bounds(path: Path) -> list[list[list[float]]]:
    """World bounding box of every solid, straight from the STEP file."""
    boxes = []
    for solid in _shape(path).solids():
        box = solid.bounding_box()
        boxes.append(
            [
                [float(box.min.X), float(box.min.Y), float(box.min.Z)],
                [float(box.max.X), float(box.max.Y), float(box.max.Z)],
            ]
        )
    return boxes


def _face_of(path: Path, index: int):
    return list(_shape(path).solids()[index].faces())


class PathProtocolTests(unittest.TestCase):
    def test_segments_escape_only_the_wire_separators(self) -> None:
        self.assertEqual(encode_segment("forearm"), "forearm")
        self.assertEqual(encode_segment("前臂"), "前臂")
        self.assertEqual(encode_segment("arm/forearm"), "arm%2Fforearm")
        self.assertEqual(encode_segment("100%"), "100%25")
        self.assertEqual(decode_segment("arm%2Fforearm"), "arm/forearm")
        self.assertEqual(decode_segment("100%25"), "100%")
        self.assertEqual(join_path(["arm", "a/b"]), "arm/a%2Fb")

    def test_non_canonical_spellings_normalize_to_one_path(self) -> None:
        self.assertEqual(canonicalize_path("arm/forearm"), canonicalize_path("arm/forearm"))
        self.assertEqual(canonicalize_path("arm%2fforearm"), canonicalize_path("arm%2Fforearm"))

    def test_malformed_paths_are_refused(self) -> None:
        for value in (
            "",
            "arm/",
            "/arm",
            "arm//forearm",
            "arm/..",
            "arm/.",
            "arm/7",
            "arm/a%b",
            "arm/a%2zb",
            "arm /forearm",
            "arm/forearm ",
        ):
            with self.assertRaises(IdentityError, msg=value):
                canonicalize_path(value)

    def test_bare_number_is_not_a_semantic_identity(self) -> None:
        with self.assertRaises(IdentityError) as caught:
            canonicalize_path("arm/3")
        self.assertEqual(caught.exception.code, "malformed-path")


class DeclarationTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_identity()

    def tearDown(self) -> None:
        reset_identity()

    def test_duplicate_path_is_refused(self) -> None:
        identity = Assembly("arm")
        identity.instance("arm/left", label="左")
        with self.assertRaises(IdentityError) as caught:
            identity.instance("arm/left", label="右")
        self.assertEqual(caught.exception.code, "duplicate-path")

    def test_two_spellings_of_one_name_collide(self) -> None:
        identity = Assembly("arm")
        identity.instance("arm/caf\u00e9")  # precomposed
        with self.assertRaises(IdentityError) as caught:
            identity.instance("arm/cafe\u0301")  # decomposed
        self.assertEqual(caught.exception.code, "duplicate-path")

    def test_escaped_slash_is_a_different_segment(self) -> None:
        identity = Assembly("arm")
        identity.instance("arm/left")
        other = identity.instance("arm%2Fleft")
        self.assertEqual(other["path"], "arm%2Fleft")

    def test_cardinality_must_be_explicit_and_sane(self) -> None:
        identity = Assembly("arm")
        with self.assertRaises(IdentityError):
            identity.faces("arm/x", selector={"entity": "face"}, owner="arm", expect=-1)
        with self.assertRaises(IdentityError):
            identity.faces("arm/y", selector={"entity": "face"}, owner="arm", expect=True)

    def test_shape_and_selector_cannot_both_be_given(self) -> None:
        identity = Assembly("arm")
        with self.assertRaises(IdentityError):
            identity.instance(
                "arm/a",
                shape=bd.Box(1, 1, 1),
                selector={"entity": "solid", "near": [0, 0, 0]},
            )

    def test_second_assembly_in_one_execution_is_refused(self) -> None:
        Assembly("arm")
        with self.assertRaises(IdentityError) as caught:
            Assembly("leg")
        self.assertEqual(caught.exception.code, "duplicate-assembly")


class SimplePartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._directory = tempfile.TemporaryDirectory()
        cls.path, cls.manifest = _build(SIMPLE, Path(cls._directory.name) / "plate.step")
        cls.index = IdentityIndex(cls.path)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._directory.cleanup()

    def test_manifest_is_bound_to_the_exact_artifact_bytes(self) -> None:
        import hashlib

        digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.assertEqual(self.manifest["artifact"]["sha256"], digest)
        self.assertEqual(self.index.artifact_hash, digest)
        self.assertTrue(self.index.verify()["ok"])

    def test_hole_group_finds_four_cylinders_where_the_parameters_say(self) -> None:
        resolution = self.index.resolve("plate/mount_holes", expect=4)
        expected_radius = 2.5  # hole_d 5.0 in the fixture
        expected_xy = {(-22.0, -12.0), (22.0, -12.0), (22.0, 12.0), (-22.0, 12.0)}
        found = set()
        for binding in resolution.bindings:
            facts = binding["facts"]
            self.assertEqual(facts["type"], "cylinder")
            self.assertAlmostEqual(facts["area"], 2 * math.pi * expected_radius * 6.0, places=6)
            found.add((round(facts["bbox"][0][0] + expected_radius, 6), round(facts["bbox"][0][1] + expected_radius, 6)))
        self.assertEqual(found, expected_xy)

    def test_bearing_seat_is_the_boss_cylinder_not_a_hole(self) -> None:
        resolution = self.index.resolve("plate/bearing_seat", expect="one")
        binding = resolution.bindings[0]
        self.assertEqual(binding["facts"]["type"], "cylinder")
        self.assertAlmostEqual(binding["facts"]["bbox"][1][0] - binding["facts"]["bbox"][0][0], 16.0, places=6)
        # The 1 mm top chamfer removes one millimetre of lateral height.
        self.assertAlmostEqual(binding["facts"]["area"], 2 * math.pi * 8.0 * (10.0 - 1.0), places=6)
        # The seat lives on the body that reaches plate_t + boss_h.
        self.assertAlmostEqual(_solid_bounds(self.path)[binding["solidIndex"]][1][2], 16.0, places=6)

    def test_probe_resolves_named_faces_and_collections_on_the_loaded_shape(self) -> None:
        shape = _shape(self.path)
        with patch.object(bd, "import_step", side_effect=AssertionError("unexpected second STEP import")):
            seat, objects = self.index.resolve_shapes("plate/bearing_seat", shape, kind="feature", expect="one")
            holes, hole_faces = self.index.resolve_shapes("plate/mount_holes", shape, kind="faces", expect="many")
        self.assertEqual(seat.artifact_hash, self.index.artifact_hash)
        self.assertEqual(len(objects), 1)
        self.assertEqual(str(objects[0].geom_type.name).lower(), "cylinder")
        self.assertEqual(holes.cardinality, "4")
        self.assertEqual(len(hole_faces), 4)
        self.assertTrue(all(str(face.geom_type.name).lower() == "cylinder" for face in hole_faces))
        with self.assertRaisesRegex(IdentityError, "expect='many'"):
            self.index.resolve_shapes("plate/mount_holes", shape, kind="faces")

    def test_shared_measurement_uses_semantic_face_on_the_existing_shape(self) -> None:
        from cadctl.geometry import measure_shape

        shape = _shape(self.path)
        with patch.object(bd, "import_step", side_effect=AssertionError("unexpected second STEP import")):
            measured = measure_shape(shape, "radius", "plate/bearing_seat", identity_index=self.index)
        self.assertAlmostEqual(measured["value"], 8.0, places=5)
        self.assertEqual(measured["units"], "mm")

    def test_probe_program_receives_manifest_and_named_shape(self) -> None:
        payload = run_probe(
            self.path,
            "selection = cad_resolve('plate/bearing_seat', kind='feature', expect='one')\n"
            "result = {'identity': selection.identity, 'radius': selection.object.radius}",
        )
        self.assertEqual(payload["result"]["identity"]["manifestVersion"], 1)
        self.assertEqual(payload["result"]["identity"]["target"], "plate/bearing_seat")
        self.assertAlmostEqual(payload["result"]["radius"], 8.0, places=5)
        self.assertGreaterEqual(payload["importSeconds"], 0)

    def test_chamfered_mounting_face_still_resolves_and_is_smaller(self) -> None:
        top = self.index.resolve("plate/top_face", kind="feature").bindings[0]["facts"]
        self.assertEqual(top["type"], "plane")
        self.assertAlmostEqual(top["centroid"][2], 6.0, places=6)
        nominal = 60.0 * 40.0 - 4 * math.pi * 2.5**2 - math.pi * 8.0**2
        self.assertLess(top["area"], nominal)
        self.assertGreater(top["area"], nominal * 0.8)

    def test_declared_face_points_at_the_face_in_the_exported_step(self) -> None:
        binding = self.index.resolve("plate/mount_holes").bindings[0]
        faces = _face_of(self.path, binding["solidIndex"])
        areas = sorted(round(float(face.area), 6) for face in faces)
        self.assertIn(round(binding["facts"]["area"], 6), areas)

    def test_axis_and_datum_carry_local_and_world_placement(self) -> None:
        axis = self.index.resolve("plate/boss_axis")
        self.assertEqual(axis.placement["direction"], [0.0, 0.0, 1.0])
        self.assertEqual(axis.placement["origin"], [0.0, 0.0, 6.0])
        self.assertEqual(axis.bindings, [])

        datum = self.index.resolve("plate/top_frame")
        self.assertEqual(datum.placement["origin"], [0.0, 0.0, 6.0])
        self.assertEqual(datum.placement["axes"]["z"], [0.0, 0.0, 1.0])

    def test_instance_binds_the_whole_body(self) -> None:
        instance = self.index.resolve("plate/base")
        self.assertEqual(instance.kind, "instance")
        self.assertEqual(len(instance.bindings), 1)
        measured = round(float(_shape(self.path).solids()[instance.solid_indices[0]].volume), 6)
        self.assertAlmostEqual(instance.bindings[0]["facts"]["volume"], measured, places=6)
        self.assertAlmostEqual(instance.bindings[0]["facts"]["bounds"][1][2], 16.0, places=6)

    def test_container_assembly_owns_its_descendants(self) -> None:
        assembly = self.index.resolve("plate")
        self.assertTrue(assembly.container)
        self.assertEqual(assembly.solid_indices, [0])


class NegativeSelectionTests(unittest.TestCase):
    def test_deleted_feature_fails_the_build(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(IdentityError) as caught:
                _build(SIMPLE, Path(directory) / "plate.step", {"include_boss": False})
        self.assertEqual(caught.exception.code, "cardinality")
        self.assertIn("plate/bearing_seat", caught.exception.message)
        self.assertIn("matched nothing", caught.exception.message)

    def test_two_candidates_are_not_silently_reduced_to_the_first(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(IdentityError) as caught:
                _build(SIMPLE, Path(directory) / "plate.step", {"boss_count": 2})
        self.assertEqual(caught.exception.code, "cardinality")
        self.assertIn("found 2", caught.exception.message)

    def test_wrong_kind_owner_and_cardinality_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path, _ = _build(SIMPLE, Path(directory) / "plate.step")
            index = IdentityIndex(path)
            with self.assertRaises(IdentityError) as caught:
                index.resolve("plate/mount_holes", kind="axis")
            self.assertEqual(caught.exception.code, "wrong-kind")
            with self.assertRaises(IdentityError) as caught:
                index.resolve("plate/mount_holes", expect="one")
            self.assertEqual(caught.exception.code, "cardinality")
            with self.assertRaises(IdentityError) as caught:
                index.resolve("plate/base", owner="plate/top_face")
            self.assertEqual(caught.exception.code, "wrong-owner")
            with self.assertRaises(IdentityError) as caught:
                index.resolve("plate/no_such_face")
            self.assertEqual(caught.exception.code, "unknown-path")

    def test_overlapping_occurrence_bounds_do_not_steal_another_solid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path, _ = _build(OVERLAPPING, Path(directory) / "case.step")
            index = IdentityIndex(path)
            outer = index.resolve("case/outer")
            inner = index.resolve("case/inner")
            self.assertEqual(len(outer.solid_indices), 1)
            self.assertEqual(len(inner.solid_indices), 1)
            self.assertNotEqual(outer.solid_indices, inner.solid_indices)
            self.assertAlmostEqual(outer.bindings[0]["facts"]["volume"], 8000.0)
            self.assertAlmostEqual(inner.bindings[0]["facts"]["volume"], 64.0)

    def test_owner_scoping_prevents_selecting_another_part(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path, _ = _build(NESTED, Path(directory) / "arm.step")
            index = IdentityIndex(path)
            left = index.resolve("arm/bracket_left")
            right = index.resolve("arm/bracket_right")
            self.assertEqual(set(left.solid_indices) & set(right.solid_indices), set())
            boxes = _solid_bounds(path)
            for index_value in left.solid_indices:
                self.assertLessEqual(boxes[index_value][1][0], 20.0 + 1e-6)
            for index_value in right.solid_indices:
                self.assertGreaterEqual(boxes[index_value][0][0], 40.0 - 1e-6)


class NestedAssemblyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._directory = tempfile.TemporaryDirectory()
        cls.path, cls.manifest = _build(NESTED, Path(cls._directory.name) / "arm.step")
        cls.index = IdentityIndex(cls.path)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._directory.cleanup()

    def test_identical_instances_keep_separate_names_and_geometry(self) -> None:
        left = self.index.resolve("arm/bracket_left")
        right = self.index.resolve("arm/bracket_right")
        self.assertNotEqual(left.refs, right.refs)
        self.assertEqual(len(left.bindings), 2)
        self.assertEqual(len(right.bindings), 2)
        self.assertEqual(set(left.solid_indices) & set(right.solid_indices), set())

    def test_repeated_display_label_never_overrides_identity(self) -> None:
        left = self.index.resolve("arm/bracket_left")
        right = self.index.resolve("arm/bracket_right")
        self.assertEqual(left.display, right.display)
        self.assertEqual(left.display, {"zh": "支座"})
        self.assertNotEqual(left.path, right.path)

        pin_a = self.index.resolve("arm/pin_a")
        pin_b = self.index.resolve("arm/pin_b")
        self.assertEqual(pin_a.label, pin_b.label)
        self.assertNotEqual(pin_a.refs, pin_b.refs)

    def test_one_named_part_can_hold_several_solids(self) -> None:
        base = self.index.resolve("arm/bracket_left/base")
        rib = self.index.resolve("arm/bracket_left/rib")
        self.assertEqual(len(base.bindings), 1)
        self.assertEqual(len(rib.bindings), 1)
        self.assertAlmostEqual(base.bindings[0]["facts"]["volume"], 20 * 20 * 4, places=6)
        self.assertAlmostEqual(rib.bindings[0]["facts"]["volume"], 4 * 20 * 16, places=6)
        self.assertNotEqual(base.solid_indices, rib.solid_indices)

    def test_axis_of_one_instance_uses_that_instance_placement(self) -> None:
        axis = self.index.resolve("arm/pin_a/hole_axis")
        self.assertEqual(axis.placement["origin"], [8.0, 0.0, 20.0])
        self.assertEqual(axis.placement["direction"], [0.0, 0.0, 1.0])

    def test_face_selector_is_scoped_to_its_owner(self) -> None:
        face = self.index.resolve("arm/bracket_left/rib_face")
        self.assertEqual(len(face.bindings), 1)
        self.assertEqual(face.bindings[0]["facts"]["centroid"], [2.0, 10.0, 20.0])

    def test_part_definitions_are_separate_from_instances(self) -> None:
        definition = self.index.resolve("arm/bracket_def")
        self.assertEqual(definition.kind, "part")
        self.assertEqual(definition.bindings, [])
        instance = self.index.resolve("arm/bracket_left")
        self.assertEqual(instance.kind, "instance")
        kinds = {entity.kind for entity in self.index.entities()}
        self.assertIn("part", kinds)
        self.assertIn("instance", kinds)

    def test_shared_instance_and_child_solid_ref_fails_as_ambiguous(self) -> None:
        solid_ref = self.index.resolve("arm/bracket_left/base").refs[0]
        paths = self.manifest["refs"][solid_ref]
        self.assertEqual(paths, ["arm/bracket_left", "arm/bracket_left/base"])
        with self.assertRaises(IdentityError) as caught:
            self.index.resolve(solid_ref)
        self.assertEqual(caught.exception.code, "ambiguous-ref")
        self.assertEqual(caught.exception.details["paths"], paths)

    def test_single_semantic_face_ref_keeps_its_declared_kind(self) -> None:
        face_ref = self.index.resolve("arm/bracket_left/rib_face").refs[0]
        self.assertEqual(
            self.manifest["refs"][face_ref],
            ["arm/bracket_left/rib_face"],
        )
        resolved = self.index.resolve(face_ref)
        self.assertEqual(resolved.path, "arm/bracket_left/rib_face")
        self.assertEqual(resolved.kind, "faces")

    def test_local_frame_on_multi_solid_owner_fails_without_unique_occurrence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(IdentityError) as caught:
                _build(
                    NESTED,
                    Path(directory) / "arm.step",
                    {"local_multi_solid_axis": True},
                )
        self.assertEqual(caught.exception.code, "ambiguous-owner-occurrence")


class RebuildTests(unittest.TestCase):
    def test_parameter_change_and_reordering_keep_the_same_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, manifest_first = _build(NESTED, root / "v1.step")
            second, manifest_second = _build(
                NESTED,
                root / "v2.step",
                {"pin_d": 6.0, "spacer": True, "reverse_order": True},
            )
            paths_first = {entity["path"] for entity in manifest_first["entities"]}
            paths_second = {entity["path"] for entity in manifest_second["entities"]}
            self.assertEqual(paths_first, paths_second)
            self.assertNotEqual(manifest_first["artifact"]["sha256"], manifest_second["artifact"]["sha256"])

            index = IdentityIndex(second)
            left = index.resolve("arm/bracket_left")
            boxes = _solid_bounds(second)
            for value in left.solid_indices:
                self.assertLessEqual(boxes[value][1][0], 20.0 + 1e-6)
            pin = index.resolve("arm/pin_a").bindings[0]["facts"]
            self.assertAlmostEqual(pin["volume"], math.pi * 3.0**2 * 10.0, places=3)
            self.assertNotEqual(
                IdentityIndex(first).resolve("arm/pin_a").refs,
                index.resolve("arm/pin_a").refs,
            )

    def test_ref_from_another_version_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, _ = _build(NESTED, root / "v1.step")
            second, _ = _build(NESTED, root / "v2.step", {"pin_d": 6.0})
            old_ref = IdentityIndex(first).resolve("arm/pin_a").refs[0]
            with self.assertRaises(IdentityError) as caught:
                IdentityIndex(second).resolve(old_ref)
            self.assertEqual(caught.exception.code, "unknown-ref")

    def test_old_manifest_next_to_new_step_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, _ = _build(NESTED, root / "step.step")
            shutil.copy2(first.with_name("step.step.identity.json"), root / "kept.identity.json")
            second, _ = _build(NESTED, root / "step.step", {"pin_d": 6.0})
            shutil.copy2(root / "kept.identity.json", second.with_name("step.step.identity.json"))
            with self.assertRaises(IdentityError) as caught:
                IdentityIndex(second)
            self.assertEqual(caught.exception.code, "stale-artifact")
            with self.assertRaises(ValueError):
                mesh_document(second)


class CompatibilityTests(unittest.TestCase):
    def test_flattened_step_solids_have_exact_unique_occurrences(self) -> None:
        model = ArtifactModel(Path(__file__).parent / "fixtures" / "interference_three.step")
        self.assertEqual(len(model.solids), 3)
        self.assertEqual(
            [len(record["occurrenceRefs"]) for record in model.solids],
            [1, 1, 1],
        )
        self.assertEqual(
            [entry["solidIndices"] for entry in model.occurrences],
            [[0], [1], [2]],
        )

    def test_anonymous_model_builds_and_exposes_only_current_refs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path, manifest = _build("../plate.py", Path(directory) / "plate.step")
            self.assertIsNone(manifest)
            self.assertFalse(path.with_name("plate.step.identity.json").exists())
            index = IdentityIndex(path)
            self.assertEqual(index.source, "anonymous")
            with self.assertRaises(IdentityError) as caught:
                index.resolve("plate")
            self.assertEqual(caught.exception.code, "no-manifest")
            current = index.resolve(f"occ-{index.artifact_hash[:12]}-root")
            self.assertFalse(current.stable)
            self.assertIsNone(current.path)
            with self.assertRaises(IdentityError) as caught:
                index.resolve("occ-000000000000-0")
            self.assertEqual(caught.exception.code, "unknown-ref")

    def test_legacy_assembly_manifest_is_migrated_and_version_checked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "assembly.step"
            shutil.copy2(Path(__file__).parent / "fixtures" / "interference_three.step", path)
            manifest = {
                "schema": 1,
                "parts": [
                    {"id": "frame", "name": "Bracket", "solidIndices": [0, 1]},
                    {"id": "pin", "name": "Pin", "solidIndices": [2]},
                ],
            }
            path.with_name("assembly.step.assembly.json").write_text(json.dumps(manifest), encoding="utf-8")

            document = mesh_document(path)
            self.assertEqual(document["identity"]["source"], "legacy")
            self.assertEqual([part["partId"] for part in document["parts"]], ["frame", "frame", "pin"])

            index = IdentityIndex(path)
            self.assertEqual(index.source, "legacy")
            resolved = index.resolve("frame")
            self.assertFalse(resolved.stable)
            self.assertTrue(resolved.legacy)
            self.assertEqual([binding["solidIndex"] for binding in resolved.bindings], [0, 1])

            manifest["artifactHash"] = "0" * 64
            path.with_name("assembly.step.assembly.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(IdentityError) as caught:
                IdentityIndex(path)
            self.assertEqual(caught.exception.code, "stale-artifact")

    def test_identity_manifest_supersedes_a_stale_legacy_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, _ = _build(NESTED, root / "arm.step")
            legacy = path.with_name("arm.step.assembly.json")
            legacy.write_text(json.dumps({"schema": 1, "parts": [{"id": "legacy", "solidIndices": [0]}]}), encoding="utf-8")

            document = mesh_document(path)
            self.assertEqual(document["identity"]["source"], "identity")
            self.assertEqual(document["parts"][0]["partId"], "arm/bracket_left")

            _build(NESTED, path)
            self.assertFalse(legacy.exists())

    def test_build_command_writes_and_prunes_the_sidecar(self) -> None:
        import subprocess
        import sys

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "part.step"
            declared = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "cadctl",
                    "build",
                    "--source",
                    str(FIXTURES / SIMPLE),
                    "--output",
                    str(output),
                    "--force",
                ],
                capture_output=True,
                text=True,
                cwd=root,
                check=False,
            )
            self.assertEqual(declared.returncode, 0, declared.stderr)
            self.assertIn("identity", declared.stdout)
            self.assertTrue((root / "part.step.identity.json").is_file())

            anonymous = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "cadctl",
                    "build",
                    "--source",
                    str(Path(__file__).parent / "fixtures" / "plate.py"),
                    "--output",
                    str(output),
                    "--force",
                ],
                capture_output=True,
                text=True,
                cwd=root,
                check=False,
            )
            self.assertEqual(anonymous.returncode, 0, anonymous.stderr)
            self.assertFalse((root / "part.step.identity.json").exists())
            self.assertEqual(IdentityIndex(output).source, "anonymous")

    def test_mesh_document_carries_semantic_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path, _ = _build(SIMPLE, Path(directory) / "plate.step")
            document = mesh_document(path)
            self.assertEqual(document["identity"]["source"], "identity")
            self.assertTrue(document["identityBound"])
            self.assertEqual(document["identitySource"], "identity")
            self.assertEqual([part["partId"] for part in document["parts"]], ["plate/base"])
            self.assertEqual([part["occurrenceId"] for part in document["parts"]], ["plate/base"])
            self.assertEqual(document["parts"][0]["name"], "底板")
            self.assertEqual(document["parts"][0]["id"], "plate/base:solid-1")
            self.assertEqual([item["path"] for item in document["parts"][0]["features"]], ["plate/mount_holes", "plate/bearing_seat", "plate/top_face", "plate/bottom_face"])
            self.assertEqual([item["path"] for item in document["parts"][0]["datums"]], ["plate/boss_axis", "plate/top_frame"])

    def test_render_selection_uses_shared_identity_resolver_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path, _ = _build(SIMPLE, Path(directory) / "plate.step")
            lookup, _ambiguous, _occurrences = _selection_index(path, len(mesh_document(path)["parts"]))
            self.assertEqual(_resolve_parts(["plate/base"], lookup, {}, "focus"), {0})
            self.assertEqual(_resolve_parts(["plate/mount_holes"], lookup, {}, "focus"), {0})


class ChineseAndEscapingTests(unittest.TestCase):
    def test_chinese_labels_and_escaped_paths_resolve(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "model.py"
            source.write_text(
                "\n".join(
                    [
                        "import build123d as bd",
                        "",
                        "part = bd.Box(20, 20, 4)",
                        "identity = Assembly('总装')",
                        "identity.instance('总装/前臂', label='前臂', shape=part)",
                        "identity.faces(",
                        "    '总装/前臂/top',",
                        "    owner='总装/前臂',",
                        "    label='顶面',",
                        "    selector={'entity': 'face', 'type': 'plane', 'normal': [0, 0, 1]},",
                        "    expect=1,",
                        ")",
                        "result = part",
                    ]
                ),
                encoding="utf-8",
            )
            output = root / "model.step"
            result = run_source(source, output)
            self.assertEqual(result["exitCode"], 0, result.get("stderr"))
            write_manifest(result["identity"], output, source_files=result["sourceFiles"])

            index = IdentityIndex(output)
            self.assertEqual(index.resolve("总装/前臂").label, "前臂")
            face = index.resolve("总装/前臂/top")
            self.assertEqual(face.bindings[0]["facts"]["type"], "plane")

            # A display label is not an identity and cannot be resolved as one.
            with self.assertRaises(IdentityError) as caught:
                index.resolve("总装/前臂/顶面")
            self.assertEqual(caught.exception.code, "unknown-path")


if __name__ == "__main__":
    unittest.main()
