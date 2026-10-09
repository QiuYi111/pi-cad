"""The op batches in the FreeCAD reference document must keep working.

Blocks tagged ```json op-batch <example> <n> are applied in order, one example per document.
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from system_requirements import skip_unless_system  # noqa: E402
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_part_backend import HAVE_FREECAD, Harness  # noqa: E402

DOC = Path(__file__).resolve().parents[3] / "skills" / "parametric-cad-modeling" / "references" / "freecad-part-ops.md"
BLOCK = re.compile(r"```json op-batch (?P<name>\w+) (?P<index>\d+)\n(?P<body>.*?)```", re.S)


def examples() -> dict[str, list[list[dict]]]:
    found: dict[str, dict[int, list[dict]]] = defaultdict(dict)
    for match in BLOCK.finditer(DOC.read_text(encoding="utf-8")):
        found[match["name"]][int(match["index"])] = json.loads(match["body"])
    return {name: [batches[i] for i in sorted(batches)] for name, batches in found.items()}


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class DocExampleTests(unittest.TestCase):
    def run_example(self, name: str, body: str) -> tuple[Harness, list[dict]]:
        harness = Harness(name, body)
        self.addCleanup(harness.close)
        results = [harness.apply(batch) for batch in examples()[name]]
        return harness, results

    def test_box(self) -> None:
        harness, results = self.run_example("box", "box")
        self.assertEqual(results[0]["intent"][0]["status"], "pass")
        self.assertTrue(harness.body_shape().isValid())
        roles = {o["path"]: o.get("roles") for o in harness.call("tree")["bodies"][0]["objects"]}
        self.assertEqual(roles["box/lip"], ["bevel"])

if __name__ == "__main__":
    unittest.main()
