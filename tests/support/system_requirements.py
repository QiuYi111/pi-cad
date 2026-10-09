"""Real-system gate for tests. See tests/support/system-requirements.ts for the rule.

A test needing a system listed for its area in tests/areas.yaml uses
``system_skip_reason`` (inside a test) or ``skip_unless_system`` (a decorator).
When the system is missing and ``REIFY_REQUIRE_<SYSTEM>=1`` is set, both raise
``SystemRequiredError``; the module then fails to import, so the run fails.
Without the variable (a local run) the test is skipped with the reason.
"""

from __future__ import annotations

import os
import unittest
from typing import Callable, TypeVar

T = TypeVar("T")


class SystemRequiredError(RuntimeError):
    pass


def system_skip_reason(system: str, available: bool, reason: str) -> str | None:
    if available:
        return None
    variable = "REIFY_REQUIRE_" + "".join(ch if ch.isalnum() else "_" for ch in system.upper())
    if os.environ.get(variable) == "1":
        raise SystemRequiredError(f"{system} is required ({variable}=1) but unavailable: {reason}")
    return reason


def skip_unless_system(system: str, available: bool, reason: str) -> Callable[[T], T]:
    skip = system_skip_reason(system, available, reason)
    return unittest.skipIf(skip is not None, skip or "")
