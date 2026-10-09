from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path
import build123d as bd

from cadctl.mesh import mesh_document
from cadctl.render import _resolve_parts, _selection_index


class MeshDocumentTests(unittest.TestCase):
    def test_records_the_exact_step_identity(self) -> None:
        source = Path(__file__).parent / "fixtures" / "section_box.step"
        expected = hashlib.sha256(source.read_bytes()).hexdigest()

        document = mesh_document(source)

        self.assertEqual(document["sha256"], expected)
        self.assertEqual(document["source"], str(source.resolve()))

    def test_assembly_manifest_groups_multiple_solids_under_stable_part_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "assembly.step"
            shutil.copy2(Path(__file__).parent / "fixtures" / "interference_three.step", source)
            manifest = {
                "schema": 1,
                "stepSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "parts": [
                    {"id": "dual-body", "name": "Bracket", "solidIndices": [0, 1]},
                    {"id": "pin", "name": "Bracket", "solidIndices": [2]},
                ],
            }
            source.with_suffix(".step.assembly.json").write_text(json.dumps(manifest), encoding="utf-8")

            document = mesh_document(source)

            self.assertEqual([part["partId"] for part in document["parts"]], ["dual-body", "dual-body", "pin"])
            self.assertEqual([part["solidId"] for part in document["parts"]], ["dual-body:solid-1", "dual-body:solid-2", "pin:solid-1"])
            self.assertEqual([part["name"] for part in document["parts"]], ["Bracket", "Bracket", "Bracket"])
            self.assertTrue(document["identityBound"])
            self.assertEqual(len(document["identityManifestSha256"]), 64)

    def test_rejects_identity_manifest_bound_to_another_step_revision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "assembly.step"
            shutil.copy2(Path(__file__).parent / "fixtures" / "interference_three.step", source)
            source.with_suffix(".step.assembly.json").write_text(json.dumps({
                "schema": 1,
                "stepSha256": "0" * 64,
                "parts": [{"id": "old-part", "name": "Old part", "solidIndices": [0]}],
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "belongs to artifact"):
                mesh_document(source)

    def test_rebuild_keeps_untouched_multi_solid_part_and_target_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = {"schema": 1, "parts": [
                {"id": "frame", "name": "Bracket", "solidIndices": [0, 1]},
                {"id": "pin", "name": "Bracket", "solidIndices": [2]},
            ]}

            def build(path: Path, pin_width: float) -> dict:
                shape = bd.Compound([
                    bd.Box(10, 8, 2),
                    bd.Pos(18, 0, 0) * bd.Box(10, 8, 2),
                    bd.Pos(9, 0, 2) * bd.Box(pin_width, 3, 8),
                ])
                bd.export_step(shape, path)
                manifest["stepSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                path.with_suffix(".step.assembly.json").write_text(json.dumps(manifest), encoding="utf-8")
                return mesh_document(path)

            before = build(root / "before.step", 3)
            after = build(root / "after.step", 5)
            before_by_id = {part["solidId"]: part for part in before["parts"]}
            after_by_id = {part["solidId"]: part for part in after["parts"]}

            self.assertEqual(set(before_by_id), set(after_by_id))
            self.assertEqual(before_by_id["frame:solid-1"]["positions"], after_by_id["frame:solid-1"]["positions"])
            self.assertEqual(before_by_id["frame:solid-2"]["positions"], after_by_id["frame:solid-2"]["positions"])
            self.assertNotEqual(before_by_id["pin:solid-1"]["positions"], after_by_id["pin:solid-1"]["positions"])

    def test_unbound_identical_solids_receive_unique_geometry_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "duplicates.step"
            bd.export_step(bd.Compound([bd.Box(10, 8, 2), bd.Box(10, 8, 2)]), source)

            ids = [part["solidId"] for part in mesh_document(source)["parts"]]

            self.assertEqual(len(ids), 2)
            self.assertEqual(len(set(ids)), 2)
            self.assertTrue(all(value.startswith("geometry:") for value in ids))

    def test_unbound_legacy_manifest_is_marked_as_legacy_and_unverified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "legacy.step"
            bd.export_step(bd.Compound([bd.Box(10, 8, 2)]), source)
            source.with_suffix(".step.assembly.json").write_text(json.dumps({
                "schema": 1,
                "parts": [{"id": "possibly-stale", "name": "Wrong name", "solidIndices": [0]}],
            }), encoding="utf-8")
            document = mesh_document(source)
            self.assertFalse(document["identityBound"])
            self.assertEqual(document["identitySource"], "legacy")
            self.assertEqual(document["parts"][0]["name"], "Wrong name")
            self.assertIsNone(document["parts"][0]["semanticId"])

    def test_render_resolves_legacy_part_identity_to_all_owned_solids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "feature.step"
            bd.export_step(bd.Compound([bd.Box(8, 6, 2), bd.Pos(12, 0, 0) * bd.Box(8, 6, 2), bd.Pos(0, 12, 0) * bd.Box(3, 3, 4)]), source)
            source.with_suffix(".step.assembly.json").write_text(json.dumps({
                "schema": 1,
                "stepSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "parts": [
                    {"id": "bracket", "name": "Bracket", "solidIndices": [0, 1]},
                    {"id": "pin", "name": "Pin", "solidIndices": [2]},
                ],
            }), encoding="utf-8")

            lookup, _ambiguous, _occurrences = _selection_index(source, 3)
            self.assertEqual(_resolve_parts(["bracket"], lookup, {}, "focus"), {0, 1})
            self.assertEqual(_resolve_parts(["pin:solid-1"], lookup, {}, "focus"), {2})


if __name__ == "__main__":
    unittest.main()
