from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path
import build123d as bd

from cadctl.mesh import mesh_document


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


if __name__ == "__main__":
    unittest.main()
