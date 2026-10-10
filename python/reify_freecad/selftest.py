"""Installation smoke test: Pad + Pocket + Fillet, STEP export, valid single solid.

Run by ``scripts/bootstrap-freecad.sh`` with
``PYTHONPATH=<repo>/python:<env>/lib <env>/bin/python -m reify_freecad.selftest``.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path


def main() -> int:
    from .dfm import services as dfm_services
    from .session import DocumentSession

    with tempfile.TemporaryDirectory(prefix="reify-freecad-selftest-") as tmp:
        root = Path(tmp)
        session = DocumentSession(root / "selftest.FCStd", root / "selftest.step", root / "history", "selftest", dfm=dfm_services)
        session.open(create=True)
        try:
            result = session.apply(
                [
                    {"op": "sketch", "name": "selftest/profile", "plane": "XY", "shapes": [{"rect": {"center": [0, 0], "size": [30, 20]}}]},
                    {"op": "pad", "name": "selftest/plate", "sketch": "selftest/profile", "length": 6},
                    {"op": "sketch", "name": "selftest/slot_profile", "on": {"feature": "selftest/plate", "role": "top"}, "shapes": [{"circle": {"center": [0, 0], "diameter": 8}}]},
                    {"op": "pocket", "name": "selftest/hole", "sketch": "selftest/slot_profile", "depth": 6, "type": "through_all"},
                    {"op": "fillet", "name": "selftest/edge_round", "edges": {"feature": "selftest/plate", "role": "top_outer"}, "radius": 1},
                ],
                commit=True,
                message="selftest",
            )
            step = Path(result["step"])
            if not step.is_file() or step.stat().st_size < 1000:
                print("selftest: STEP file missing or empty", file=sys.stderr)
                return 1
            shape = next(b.Shape for b in session.doc.Objects if b.TypeId == "PartDesign::Body")
            if not shape.isValid() or len(shape.Solids) != 1:
                print("selftest: result is not one valid solid", file=sys.stderr)
                return 1
            print(f"selftest ok: volume {shape.Volume:.1f} mm3, {len(shape.Faces)} faces")
            return 0
        finally:
            session.close()


if __name__ == "__main__":
    sys.exit(main())
