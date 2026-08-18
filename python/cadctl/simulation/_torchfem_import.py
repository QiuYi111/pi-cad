from __future__ import annotations

import sys
import types


def import_torchfem():
    try:
        import pyamg  # noqa: F401
    except Exception:
        def _amg_unavailable(*_args, **_kwargs):
            raise RuntimeError(
                "pyamg is unavailable; torch-fem direct spsolve supports the V1 "
                "small-system walking skeleton. Install pyamg for iterative solves."
            )

        sys.modules.setdefault(
            "pyamg",
            types.SimpleNamespace(smoothed_aggregation_solver=_amg_unavailable),
        )
    from torchfem import Planar, Solid  # noqa: F401
    from torchfem import materials  # noqa: F401
    from torchfem import mesh  # noqa: F401

    return sys.modules["torchfem"]
