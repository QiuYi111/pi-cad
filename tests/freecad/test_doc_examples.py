"""The op batches in the FreeCAD reference document must keep working.

Blocks tagged ```json op-batch <example> <n> are applied in order, one example per document.
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_part_backend import HAVE_FREECAD, Harness  # noqa: E402

DOC = Path(__file__).resolve().parents[2] / "skills" / "parametric-cad-modeling" / "references" / "freecad-part-ops.md"
BLOCK = re.compile(r"```json op-batch (?P<name>\w+) (?P<index>\d+)\n(?P<body>.*?)```", re.S)


def examples() -> dict[str, list[list[dict]]]:
    found: dict[str, dict[int, list[dict]]] = defaultdict(dict)
    for match in BLOCK.finditer(DOC.read_text(encoding="utf-8")):
        found[match["name"]][int(match["index"])] = json.loads(match["body"])
    return {name: [batches[i] for i in sorted(batches)] for name, batches in found.items()}


@unittest.skipUnless(HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class DocExampleTests(unittest.TestCase):
    def test_the_document_has_three_examples(self) -> None:
        self.assertEqual(sorted(examples()), ["arm", "box", "bracket"])

    def run_example(self, name: str, body: str) -> tuple[Harness, list[dict]]:
        harness = Harness(name, body)
        self.addCleanup(harness.close)
        results = [harness.apply(batch) for batch in examples()[name]]
        return harness, results

    def test_bracket(self) -> None:
        harness, results = self.run_example("bracket", "bracket")
        self.assertEqual(results[0]["intent"][0]["status"], "pass")
        shape = harness.body_shape()
        self.assertTrue(shape.isValid())
        self.assertEqual(len(shape.Solids), 1)
        # Only the four hole walls and what the wider hole resized change in the second batch.
        self.assertEqual(results[1]["params"]["changed"], {"hole_d": [6.0, 8.0]})
        self.assertIn("bracket/mount_hole/wall", results[1]["highlight"]["paths"])
        self.assertEqual(len(harness.call("query", target="bracket/mount_hole/wall", what=["faces"])["faces"]), 4)

    def test_box(self) -> None:
        harness, results = self.run_example("box", "box")
        self.assertEqual(results[0]["intent"][0]["status"], "pass")
        self.assertTrue(harness.body_shape().isValid())
        roles = {o["path"]: o.get("roles") for o in harness.call("tree")["bodies"][0]["objects"]}
        self.assertEqual(roles["box/lip"], ["bevel"])

    def test_arm_sweep(self) -> None:
        harness, _results = self.run_example("arm", "arm/base")
        sweep = harness.call(
            "sweep", param="j3_angle", range=[-90, 90], step=10,
            check={"kind": "clearance", "args": {"a": "arm/upper", "b": "arm/base"}}, refine=True,
        )
        self.assertGreater(sweep["firstFailure"], 0)
        self.assertLess(sweep["firstFailure"], 20)


if __name__ == "__main__":
    unittest.main()
