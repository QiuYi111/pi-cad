"""Shared golden edge-match fixtures (executors/fixtures/golden/edge_match.json).

The same file is loaded by the SolidWorks xUnit tests (GoldenEdgeMatchTests). Each case records the verdict of
each executor, so a change to either matcher that moves a verdict fails here or there.
"""
import json
import os
import unittest

import _path  # noqa: F401
import edgematch

GOLDEN = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "executors", "fixtures", "golden"))


def load_golden(name):
    with open(os.path.join(GOLDEN, name)) as fh:
        return json.load(fh)


class GoldenEdgeMatchTests(unittest.TestCase):
    doc = load_golden("edge_match.json")

    def test_schema(self):
        self.assertEqual(self.doc["schema"], "reify.golden/edge-match/1")
        self.assertGreaterEqual(len(self.doc["cases"]), 10)

    def test_fusion_matcher_gives_expected_verdicts(self):
        for case in self.doc["cases"]:
            with self.subTest(case=case["name"]):
                tol = edgematch.tolerance(case["diagonal_mm"])
                got = [i for i, c in enumerate(case["candidates"]) if edgematch.matches(case["ref"], c, tol)]
                self.assertEqual(got, case["expect"]["fusion"])

    def test_match_edge_resolves_or_rejects(self):
        for case in self.doc["cases"]:
            with self.subTest(case=case["name"]):
                want = case["expect"]["fusion"]
                if len(want) == 1:
                    self.assertEqual(edgematch.match_edge(case["ref"], case["candidates"], case["diagonal_mm"]), want[0])
                else:
                    with self.assertRaises(edgematch.EdgeMatchError):
                        edgematch.match_edge(case["ref"], case["candidates"], case["diagonal_mm"])

    def test_divergence_flags_are_honest(self):
        for case in self.doc["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(case["divergent"], case["expect"]["fusion"] != case["expect"]["solidworks"])


if __name__ == "__main__":
    unittest.main()
