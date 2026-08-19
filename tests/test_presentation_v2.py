"""Release presentation interpreter tests (0.8 M4b).

Blender-gated: every render test skips when blender/ffmpeg are missing —
the same fail-soft contract the tool itself honors. Schema validation and
the unavailable-path are always tested.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from cadctl.presentation import blender_binary, run_presentation, validate_spec

ROOT = Path(__file__).resolve().parent.parent
HAS_BLENDER = shutil.which("blender") is not None
HAS_FFMPEG = shutil.which("ffmpeg") is not None

TWO_BOXES_SOURCE = '''
import build123d as bd

with bd.BuildPart() as p:
    bd.Box(40, 30, 12)
    a = p.part
with bd.BuildPart() as p:
    bd.Box(20, 20, 35)
    b = p.part
result = bd.Compound([a, b.moved(bd.Location((0, 0, 23.5)))])
'''


def _reference_image(path: Path) -> Path:
    from PIL import Image

    Image.new("RGB", (32, 32), (120, 120, 130)).save(path)
    return path


class PresentationSchema(unittest.TestCase):
    def spec(self, **overrides):
        spec = {
            "artifact": "model.step",
            "directions": [
                {"name": "hero", "reference": "ref1.png"},
                {"name": "top", "reference": "ref2.png"},
            ],
            "materials": [{"pattern": "brushed", "family": "metal"}],
            "lighting": {"key": "softbox", "fill": "bounce", "rim": "strip"},
            "camera": {"lens": "85mm", "composition": "hero"},
        }
        spec.update(overrides)
        return spec

    def test_valid_spec_and_unknown_keys_fail_closed(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            artifact = tmp / "model.step"
            artifact.write_text("step")
            ref1 = _reference_image(tmp / "ref1.png")
            ref2 = _reference_image(tmp / "ref2.png")
            spec = self.spec(
                artifact=str(artifact),
                directions=[
                    {"name": "hero", "reference": str(ref1)},
                    {"name": "top", "reference": str(ref2)},
                ],
            )
            ok, errors = validate_spec(spec)
            self.assertTrue(ok, errors)

        ok, errors = validate_spec(self.spec(vibe="moody"))
        self.assertFalse(ok)
        self.assertTrue(any("unknown keys" in e for e in errors))

        ok, errors = validate_spec(self.spec(directions=[{"name": "only-one"}]))
        self.assertFalse(ok)

    def test_semantic_vocabulary_fails_closed(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            artifact = tmp / "model.step"
            artifact.write_text("step")
            refs = [_reference_image(tmp / "ref1.png"), _reference_image(tmp / "ref2.png")]
            base = self.spec(
                artifact=str(artifact),
                directions=[
                    {"name": "hero", "reference": str(refs[0])},
                    {"name": "top", "reference": str(refs[1])},
                ],
            )
            # Unknown material family/pattern rejected.
            ok, errors = validate_spec({**base, "materials": [{"pattern": "p", "family": "unobtainium"}]})
            self.assertFalse(ok)
            self.assertTrue(any("family" in e for e in errors))
            # Lens without a focal length rejected.
            ok, errors = validate_spec({**base, "camera": {"lens": "fuzzy", "composition": "hero"}})
            self.assertFalse(ok)
            self.assertTrue(any("lens" in e for e in errors))
            # Unknown composition rejected.
            ok, errors = validate_spec({**base, "camera": {"lens": "85mm", "composition": "vibes"}})
            self.assertFalse(ok)
            self.assertTrue(any("composition" in e for e in errors))

    def test_assembly_definition_validated(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            artifact = tmp / "model.step"
            artifact.write_text("step")
            ref1 = _reference_image(tmp / "ref1.png")
            ref2 = _reference_image(tmp / "ref2.png")
            base = self.spec(
                artifact=str(artifact),
                directions=[
                    {"name": "hero", "reference": str(ref1)},
                    {"name": "top", "reference": str(ref2)},
                ],
            )

            good = {"sequence": [{"step": 1, "installs": ["a"]}], "explodeDirections": {"a": [0, 0, 1]}}
            ok, errors = validate_spec({**base, "assemblyDefinition": good})
            self.assertTrue(ok, errors)

            bad_vector = {"sequence": [{"step": 1, "installs": ["a"]}], "explodeDirections": {"a": [0, 1]}}
            ok, errors = validate_spec({**base, "assemblyDefinition": bad_vector})
            self.assertFalse(ok)
            self.assertTrue(any("3-vector" in e for e in errors))

            bad_keys = {"sequence": [], "colour": "blue"}
            ok, errors = validate_spec({**base, "assemblyDefinition": bad_keys})
            self.assertFalse(ok)

    def test_stage_validate_needs_no_blender(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            artifact = tmp / "model.step"
            artifact.write_text("step bytes")
            refs = [_reference_image(tmp / "ref1.png"), _reference_image(tmp / "ref2.png")]
            spec = tmp / "spec.json"
            spec.write_text(
                json.dumps(
                    {
                        "artifact": str(artifact),
                        "directions": [
                            {"name": "hero", "reference": str(refs[0])},
                            {"name": "top", "reference": str(refs[1])},
                        ],
                        "materials": [{"pattern": "brushed", "family": "metal"}],
                        "lighting": {"key": "a", "fill": "b", "rim": "c"},
                        "camera": {"lens": "85mm", "composition": "hero"},
                    }
                )
            )
            result = run_presentation(spec, tmp / "out", stage="validate")
            self.assertEqual(result["status"], "validated")


@unittest.skipUnless(HAS_BLENDER and HAS_FFMPEG, "blender/ffmpeg not installed")
class PresentationRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="pi-cad-present-"))
        source = cls.tmp / "two_boxes.py"
        source.write_text(TWO_BOXES_SOURCE)
        cls.artifact = cls.tmp / "two_boxes.step"
        # Build the STEP deterministically via the same backend the harness uses.
        import subprocess
        import sys

        env = {"PYTHONPATH": str(ROOT / "python"), "PATH": "/usr/bin:/bin"}
        result = subprocess.run(
            [sys.executable, "-m", "cadctl", "build", "--source", str(source), "--output", str(cls.artifact), "--force"],
            capture_output=True,
            text=True,
            env=env,
            timeout=300,
        )
        assert cls.artifact.exists(), result.stderr[-500:]
        cls.spec = cls.tmp / "spec.json"
        cls.spec.write_text(
            json.dumps(
                {
                    "artifact": str(cls.artifact),
                    "directions": [
                        {"name": "hero", "reference": str(_reference_image(cls.tmp / "ref1.png"))},
                        {"name": "top", "reference": str(_reference_image(cls.tmp / "ref2.png"))},
                    ],
                    "materials": [{"pattern": "brushed", "family": "metal"}],
                    "lighting": {"key": "softbox 45", "fill": "bounce", "rim": "strip"},
                    "camera": {"lens": "85mm", "composition": "three-quarter hero"},
                    "assemblyDefinition": {
                        "sequence": [{"step": 1, "installs": ["base"]}, {"step": 2, "installs": ["tower"]}],
                        "explodeDirections": {"tower": [0, 0, 1], "base": [0, 0, -0.3]},
                    },
                    "resolution": {"width": 160, "height": 120},
                    "fps": 12,
                    "outputs": {"hero": True, "exploded": True, "turntable": True, "assembly": True},
                }
            )
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_preview_renders_keyframes_and_manifest(self):
        out = self.tmp / "preview"
        result = run_presentation(self.spec, out, stage="preview")
        self.assertEqual(result["status"], "rendered", result.get("reason"))
        # The driver records how it consumed the spec's vocabulary.
        report = json.loads((out / "render-report.json").read_text())
        interp = report["interpretation"]
        self.assertTrue(interp["camera"]["focalLengthMm"] > 0)
        self.assertIn("composition", interp["camera"])
        self.assertTrue(interp["materialAssignments"])
        preview = [p for p in result.get("previewImages", [])]
        self.assertTrue(any(p.endswith("hero.png") for p in preview), preview)
        self.assertTrue(any(p.endswith("exploded.png") for p in preview), preview)
        manifest = json.loads((out / "manifest.json").read_text())
        self.assertEqual(manifest["status"], "rendered")
        self.assertEqual(manifest["stage"], "preview")
        self.assertEqual(manifest["rendererSettings"]["seed"], 0)
        self.assertIn("hero.png", manifest["outputs"])
        self.assertIn("exploded.png", manifest["outputs"])
        self.assertIn("presentation.blend", manifest["outputs"])
        # The manifest binds the subject design and the spec.
        from cadctl.common import sha256_file

        self.assertEqual(manifest["subjectArtifactHash"], sha256_file(self.artifact))
        for entry in manifest["outputs"].values():
            self.assertEqual(entry["sha256"], sha256_file(entry["path"]))

    def test_run_renders_videos_and_hashes_them(self):
        out = self.tmp / "final"
        result = run_presentation(self.spec, out, stage="run")
        self.assertEqual(result["status"], "rendered", result.get("reason"))
        manifest = json.loads((out / "manifest.json").read_text())
        self.assertIn("turntable.mp4", manifest["outputs"])
        self.assertIn("assembly.mp4", manifest["outputs"])
        self.assertGreater(Path(manifest["outputs"]["turntable.mp4"]["path"]).stat().st_size, 1000)
        self.assertGreater(Path(manifest["outputs"]["assembly.mp4"]["path"]).stat().st_size, 1000)

    def test_repeat_render_same_settings_and_outputs(self):
        out1 = self.tmp / "repeat1"
        out2 = self.tmp / "repeat2"
        r1 = run_presentation(self.spec, out1, stage="preview")
        r2 = run_presentation(self.spec, out2, stage="preview")
        self.assertEqual(r1["status"], "rendered")
        self.assertEqual(r2["status"], "rendered")
        m1 = json.loads((out1 / "manifest.json").read_text())
        m2 = json.loads((out2 / "manifest.json").read_text())
        # Deterministic SETTINGS (seed, samples, resolution, camera math,
        # light rig) and deterministic output sets. Pixel bytes may differ
        # by small floating-point noise across runs; the manifest hashes
        # bind what was actually produced, not a reproducibility promise.
        self.assertEqual(m1["rendererSettings"], m2["rendererSettings"])
        self.assertEqual(sorted(m1["outputs"]), sorted(m2["outputs"]))
        self.assertEqual(m1["subjectArtifactHash"], m2["subjectArtifactHash"])


if __name__ == "__main__":
    unittest.main()


class PresentationProvenance(unittest.TestCase):
    """FrozenInputs: mid-render input mutation discards the result."""

    def test_mid_render_artifact_mutation_discards(self):
        import threading

        if not (HAS_BLENDER and HAS_FFMPEG):
            self.skipTest("blender/ffmpeg not installed")
        tmp = Path(tempfile.mkdtemp(prefix="pi-cad-present-race-"))
        try:
            source = tmp / "box.py"
            source.write_text(
                "import build123d as bd\n"
                "with bd.BuildPart() as p:\n"
                "    bd.Box(30, 30, 12)\n"
                "result = p.part\n"
            )
            import os
            import subprocess
            import sys

            artifact = tmp / "box.step"
            subprocess.run(
                [sys.executable, "-m", "cadctl", "build", "--source", str(source), "--output", str(artifact), "--force"],
                capture_output=True, text=True, timeout=300,
                env={**os.environ, "PYTHONPATH": str(ROOT / "python")},
            )
            refs = [_reference_image(tmp / "ref1.png"), _reference_image(tmp / "ref2.png")]
            spec = tmp / "spec.json"
            spec.write_text(
                json.dumps(
                    {
                        "artifact": str(artifact),
                        "directions": [
                            {"name": "hero", "reference": str(refs[0])},
                            {"name": "top", "reference": str(refs[1])},
                        ],
                        "materials": [{"pattern": "machined", "family": "metal"}],
                        "lighting": {"key": "softbox", "fill": "bounce", "rim": "strip"},
                        "camera": {"lens": "50mm", "composition": "hero"},
                        "resolution": {"width": 120, "height": 90},
                        "fps": 12,
                        "outputs": {"hero": True, "exploded": False, "turntable": False},
                    }
                )
            )

            # Mutate the artifact DURING the render. The freeze happens at
            # the start of run_presentation, so tamper from a racing thread
            # that waits for the render to actually begin (driver-args.json
            # is written just before Blender launches).
            def tamper():
                args_path = tmp / "out" / "driver-args.json"
                for _ in range(600):
                    if args_path.exists():
                        break
                    time.sleep(0.05)
                artifact.write_bytes(artifact.read_bytes() + b"tampered")

            import time

            thread = threading.Thread(target=tamper)
            thread.start()
            result = run_presentation(spec, tmp / "out", stage="preview")
            thread.join()
            self.assertEqual(result["status"], "discarded", result.get("reason"))
            self.assertIn("changed during presentation", result["reason"])
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)
