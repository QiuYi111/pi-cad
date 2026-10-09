"""Performance regressions of the part backend: a plate with many holes, a fillet, reopened (FreeCAD Python).

Timing is not asserted (machines differ). What is asserted is the work that was slow:
the created faces of a feature are found once, a reopen of the saved revision finds
them in the cache file, and an unchanged saved part is not exported again.
"""

from __future__ import annotations

import json
import unittest
from system_requirements import skip_unless_system  # noqa: E402
from pathlib import Path
from typing import Any

from test_part_backend import HAVE_FREECAD, Harness, plate

if HAVE_FREECAD:
    from reify_freecad import roles as roles_module

HOLES = 8


def heavy_ops() -> list[dict[str, Any]]:
    ops = plate("part", width=200, depth=120, thickness=8)
    for i in range(HOLES):
        x, y = -90 + (i % 6) * 36, -30 + (i // 6) * 60
        ops += [
            {"op": "sketch", "name": f"part/h{i}_sk", "on": {"feature": "part/base", "role": "top"}, "shapes": [{"circle": {"center": [x, y], "diameter": 6}}]},
            {"op": "pocket", "name": f"part/h{i}", "sketch": f"part/h{i}_sk", "depth": 4},
        ]
    return ops


def reopen(h: Harness, **extra: Any) -> dict[str, Any]:
    h.call("close")
    return h.call("open", output=str(h.step), historyDir=str(h.root / ".history"), body="part", create=False, root=str(h.root), **extra)


@skip_unless_system("freecad", HAVE_FREECAD, "FreeCAD is not importable in this interpreter")
class HeavyPartTests(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness()
        self.addCleanup(self.h.close)
        self.h.apply(heavy_ops())
        self.h.apply([{"op": "fillet", "name": "part/edge_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 1.5}])

    def searches(self) -> int:
        return roles_module.STATS["created_searches"]

    def test_a_feature_is_searched_once_not_once_per_recompute(self) -> None:
        roles_module._CREATED_CACHE.clear()
        session = self.h.session()
        before = self.searches()
        session._roles.clear()
        session.roles(session.default_body())
        first = self.searches() - before
        self.assertGreater(first, 0)
        session._invalidate()  # a new generation: the roles are asked for again
        session.roles(session.default_body())
        self.assertEqual(self.searches() - before, first, "unchanged features must come from the cache")

    def test_roles_are_the_same_with_and_without_the_cache(self) -> None:
        cached = self.h.call("tree")["bodies"][0]["objects"]
        roles_module._CREATED_CACHE.clear()
        self.h.session()._invalidate()
        self.h.session()._roles.clear()
        self.assertEqual(self.h.call("tree")["bodies"][0]["objects"], cached)

    def test_a_reopen_of_the_saved_revision_does_not_search_again(self) -> None:
        first = self.h.call("open", output=str(self.h.step), historyDir=str(self.h.root / ".history"), body="part", create=False, root=str(self.h.root))
        before = self.h.call("tree")["bodies"][0]["objects"]
        cache_file = Path(self.h.doc + ".roles.json")
        self.assertTrue(cache_file.is_file())
        self.assertEqual(json.loads(cache_file.read_text())["fcstdSha256"], first["fcstdSha256"])
        roles_module._CREATED_CACHE.clear()  # a new worker process starts with nothing in memory
        before_count = self.searches()
        reopened = reopen(self.h, export=False)
        after = self.h.call("tree")["bodies"][0]["objects"]
        self.assertEqual(self.searches() - before_count, 0, "the cache file must stand in for the search")
        self.assertEqual(after, before)
        self.assertEqual(reopened["rev"], 2)

    def test_a_stale_cache_file_is_ignored(self) -> None:
        self.h.call("open", output=str(self.h.step), historyDir=str(self.h.root / ".history"), body="part", create=False, root=str(self.h.root))
        cache_file = Path(self.h.doc + ".roles.json")
        data = json.loads(cache_file.read_text())
        data["fcstdSha256"] = "0" * 64
        cache_file.write_text(json.dumps(data))
        before = self.h.call("tree")["bodies"][0]["objects"]
        roles_module._CREATED_CACHE.clear()
        before_count = self.searches()
        reopen(self.h, export=False)
        after = self.h.call("tree")["bodies"][0]["objects"]
        self.assertGreater(self.searches() - before_count, 0)
        self.assertEqual(after, before)

    def test_a_rolled_back_failure_does_not_make_the_next_request_slow(self) -> None:
        self.h.call("tree")
        before_count = self.searches()
        error = self.h.error("apply", ops=[{"op": "fillet", "name": "part/too_round", "edges": {"feature": "part/base", "role": "top_outer"}, "radius": 500}])
        self.assertTrue(error["rolledBack"])
        self.h.call("tree")
        # The reload after the rollback finds the features in the cache file; at most the failed fillet is searched.
        self.assertLessEqual(self.searches() - before_count, 1)

    def test_opening_an_unchanged_saved_part_does_not_export_it_again(self) -> None:
        # The apply wrote the STEP and its source record for revision 2.
        step = self.h.step
        stamp = step.stat().st_mtime_ns
        reopened = reopen(self.h)
        self.assertTrue(reopened.get("stepReused"))
        self.assertEqual(step.stat().st_mtime_ns, stamp)
        self.assertEqual(reopened["step"], str(step))
        self.assertTrue(Path(reopened["declarations"]).is_file())
        self.assertTrue(reopened["annotations"])

    def test_the_step_is_exported_again_when_it_no_longer_matches_the_document(self) -> None:
        step = self.h.step
        step.write_text(step.read_text() + "\n")  # edited, deleted or replaced outside the worker
        reopened = reopen(self.h)
        self.assertFalse(reopened.get("stepReused"))
        self.assertTrue(step.is_file())
        self.assertTrue(reopen(self.h).get("stepReused"), "the fresh export is current again")

    def test_a_changed_document_is_exported_on_open(self) -> None:
        self.h.call("close")
        document = Path(self.h.doc)
        # Another process committed a revision: the STEP on disk shows the old one.
        import hashlib

        record = json.loads(Path(str(self.h.step) + ".source.json").read_text())
        record["fcstdSha256"] = hashlib.sha256(b"older").hexdigest()
        Path(str(self.h.step) + ".source.json").write_text(json.dumps(record))
        self.assertTrue(document.is_file())
        reopened = self.h.call("open", output=str(self.h.step), historyDir=str(self.h.root / ".history"), body="part", create=False, root=str(self.h.root))
        self.assertFalse(reopened.get("stepReused"))


if __name__ == "__main__":
    unittest.main()
