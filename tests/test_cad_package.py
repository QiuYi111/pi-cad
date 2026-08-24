from __future__ import annotations

import dataclasses
import tempfile
import unittest
from pathlib import Path

import cad
from cad.snapshot import SnapshotError


@cad.probe(subject="current", purpose="fixture")
def _module_probe(shape, bd, np, minimum):
    return {"count": len(shape.solids()), "minimum": minimum}


@dataclasses.dataclass
class Example:
    name: str
    count: int


class CadPackageTests(unittest.TestCase):
    def test_json_dataclass_path_and_numpy_codecs_are_explicit(self) -> None:
        self.assertEqual(cad.snapshot.registry.decode(cad.snapshot.registry.encode({"a": [1, 2]})), {"a": [1, 2]})
        encoded = cad.snapshot.registry.encode(Example("part", 2))
        self.assertEqual(encoded["codec"], "dataclass")
        self.assertEqual(cad.snapshot.registry.decode(encoded), {"name": "part", "count": 2})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "spec.md"
            path.write_text("v1")
            path_snapshot = cad.snapshot.registry.encode(path)
            self.assertEqual(path_snapshot["codec"], "path")
            self.assertEqual(len(path_snapshot["value"]["contentSha256"]), 64)
        import numpy as np
        array = np.asarray([[1, 2], [3, 4]], dtype="int32")
        self.assertTrue((cad.snapshot.registry.decode(cad.snapshot.registry.encode(array)) == array).all())

    def test_no_pickle_fallback_and_registered_codec(self) -> None:
        class Unsupported:
            pass

        with self.assertRaisesRegex(SnapshotError, "pickle is never used"):
            cad.snapshot.registry.encode(Unsupported())

        class Registered:
            def __init__(self, value: int) -> None:
                self.value = value

        cad.snapshot.register(Registered, "test.registered", lambda item: {"value": item.value}, lambda value: Registered(value["value"]))
        restored = cad.snapshot.registry.decode(cad.snapshot.registry.encode(Registered(7)))
        self.assertEqual(restored.value, 7)

    def test_templates_are_extensible_and_non_authoritative(self) -> None:
        names = {item["name"] for item in cad.templates.list()}
        self.assertEqual(names, {"mechanical.work-package", "mechanical.part-work", "mechanical.assembly-work"})
        PartWork = cad.templates.load("mechanical.part-work")
        part = PartWork(name="housing")
        self.assertEqual(part.name, "housing")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            cad.templates.register("mechanical.part-work", dict)

    def test_handles_have_compact_repr(self) -> None:
        artifact = cad.ArtifactRef(Path("build/a.step"), "a" * 64, "candidate")
        self.assertLess(len(repr(artifact)), 160)
        self.assertNotIn("a" * 64, repr(artifact))

    def test_probe_decorator_captures_plain_source_without_decorator(self) -> None:
        self.assertIn("def _module_probe", _module_probe.source)
        self.assertNotIn("@cad.probe", _module_probe.source)
        self.assertEqual(_module_probe.subject, "current")

        threshold = 2

        @cad.probe(subject="current")
        def closure_probe(shape):
            return {"threshold": threshold, "solids": len(shape.solids())}

        with self.assertRaisesRegex(TypeError, "does not capture closures"):
            import asyncio
            asyncio.run(closure_probe())


if __name__ == "__main__":
    unittest.main()
