"""The DFM entry points a document session is given (session and queries never import dfm).

The worker, the part registry and the selftest pass this module to ``DocumentSession(dfm=...)``, so the
dependency points from the domain layer down to the kernel, not the other way.
"""

from __future__ import annotations

from .lint import evaluate
from .profile import density_of as profile_density

__all__ = ["evaluate", "profile_density"]
