from __future__ import annotations

import hashlib
import json
import multiprocessing
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build123d as bd

from cadctl.export import export_artifact


def _export_at_barrier(source: str, output: str, barrier) -> None:
    barrier.wait(timeout=20)
    export_artifact(source, output, "step")


class ExportIdentityTests(unittest.TestCase):
    @staticmethod
    def write_identity_sidecar(step: Path, digest: str) -> Path:
        sidecar = Path(str(step) + ".identity.json")
        sidecar.write_text(json.dumps({
            "protocol": "reify-identity", "version": 1,
            "artifact": {"sha256": digest}, "entities": [],
        }), encoding="utf-8")
        return sidecar

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

    def test_concurrent_processes_publish_one_matching_step_identity_pair(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = [root / "revision-a.step", root / "revision-b.step"]
            hashes = []
            for path, payload in zip(sources, (b"revision A", b"revision B")):
                path.write_bytes(payload)
                digest = hashlib.sha256(payload).hexdigest()
                hashes.append(digest)
                self.write_identity_sidecar(path, digest)
                Path(str(path) + ".assembly.json").write_text(json.dumps({
                    "schema": 1, "stepSha256": digest,
                    "parts": [{"id": path.stem, "solidIndices": [0]}],
                }), encoding="utf-8")
            output = root / "delivery.step"
            context = multiprocessing.get_context("fork")
            barrier = context.Barrier(2)
            workers = [
                context.Process(target=_export_at_barrier, args=(str(source), str(output), barrier))
                for source in sources
            ]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=30)
            for worker in workers:
                if worker.is_alive():
                    worker.terminate()
                    worker.join()

            self.assertEqual([worker.exitcode for worker in workers], [0, 0])
            final_hash = hashlib.sha256(output.read_bytes()).hexdigest()
            self.assertIn(final_hash, hashes)
            manifest = json.loads(Path(str(output) + ".identity.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["artifact"]["sha256"], final_hash)
            legacy = json.loads(Path(str(output) + ".assembly.json").read_text(encoding="utf-8"))
            self.assertEqual(legacy["stepSha256"], final_hash)

    def test_mid_publish_sidecar_failure_restores_previous_revision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old_step, new_step = root / "old.step", root / "new.step"
            output = root / "delivery.step"
            old_step.write_bytes(b"old revision")
            new_step.write_bytes(b"new revision")
            old_hash = hashlib.sha256(old_step.read_bytes()).hexdigest()
            new_hash = hashlib.sha256(new_step.read_bytes()).hexdigest()
            output.write_bytes(old_step.read_bytes())
            self.write_identity_sidecar(output, old_hash)
            self.write_identity_sidecar(new_step, new_hash)

            replace = os.replace
            injected = False

            def interrupt_after_step_replace(source, destination):
                nonlocal injected
                if (
                    not injected
                    and Path(destination) == Path(str(output) + ".identity.json")
                    and "reify-identity-" in Path(source).name
                ):
                    injected = True
                    raise OSError("simulated interruption before identity sidecar replace")
                replace(source, destination)

            with patch("cadctl.export.os.replace", side_effect=interrupt_after_step_replace):
                with self.assertRaisesRegex(OSError, "simulated interruption"):
                    export_artifact(new_step, output, "step")

            self.assertTrue(injected)
            self.assertEqual(output.read_bytes(), old_step.read_bytes())
            restored = json.loads(Path(str(output) + ".identity.json").read_text(encoding="utf-8"))
            self.assertEqual(restored["artifact"]["sha256"], old_hash)


if __name__ == "__main__":
    unittest.main()
