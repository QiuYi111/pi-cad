from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import build123d as bd

from cadctl.export import export_artifact


class ExportIdentityTests(unittest.TestCase):
    def test_step_copy_preserves_hash_bound_identity_sidecars(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.step"
            output = root / "delivery.step"
            bd.export_step(bd.Compound([bd.Box(8, 6, 2), bd.Pos(12, 0, 0) * bd.Box(8, 6, 2)]), source)
            step_hash = hashlib.sha256(source.read_bytes()).hexdigest()
            manifest_path = source.with_suffix(".step.identity.json")
            manifest_path.write_text(json.dumps({
                "protocol": "reify-identity",
                "version": 1,
                "artifact": {"sha256": step_hash},
                "entities": [],
            }), encoding="utf-8")
            legacy_path = source.with_suffix(".step.assembly.json")
            legacy_path.write_text(json.dumps({
                "schema": 1,
                "stepSha256": step_hash,
                "parts": [
                    {"id": "left", "name": "Bracket", "occurrenceId": "assy/left", "solidIndices": [0]},
                    {"id": "right", "name": "Bracket", "occurrenceId": "assy/right", "solidIndices": [1]},
                ],
            }), encoding="utf-8")

            result = export_artifact(source, output, "step", expected_source_sha256=step_hash)

            self.assertEqual(output.read_bytes(), source.read_bytes())
            copied_manifest = output.with_suffix(".step.identity.json")
            self.assertEqual(json.loads(copied_manifest.read_text(encoding="utf-8"))["artifact"]["sha256"], step_hash)
            self.assertEqual(output.with_suffix(".step.assembly.json").read_bytes(), legacy_path.read_bytes())
            self.assertEqual(result["outputSha256"], step_hash)
            self.assertEqual(result["identityManifestSha256"], hashlib.sha256(copied_manifest.read_bytes()).hexdigest())

    def test_export_rejects_stale_modern_identity_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "source.step", root / "delivery.step"
            bd.export_step(bd.Box(8, 6, 2), source)
            source.with_suffix(".step.identity.json").write_text(json.dumps({
                "protocol": "reify-identity", "version": 1,
                "artifact": {"sha256": "0" * 64}, "entities": [],
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "another STEP revision"):
                export_artifact(source, output, "step")
            self.assertFalse(output.exists())

    def test_export_rejects_wrong_artifact_ref_hash_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.step"
            output = root / "delivery.step"
            bd.export_step(bd.Box(8, 6, 2), source)

            with self.assertRaisesRegex(ValueError, "selected source revision changed"):
                export_artifact(source, output, "step", expected_source_sha256="0" * 64)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
