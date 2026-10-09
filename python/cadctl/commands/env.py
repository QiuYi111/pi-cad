"""Environment commands: installed capabilities and the doctor report."""

from __future__ import annotations

import argparse
import json
import time

from ..common import emit
from .envelope import elapsed_ms


def cmd_capability(args: argparse.Namespace) -> int:
    from ..capability import capabilities

    started = time.monotonic()
    emit(
        "cadctl_capability",
        {"capabilities": capabilities()},
        duration_ms=elapsed_ms(started),
    )
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    from ..doctor import doctor

    started = time.monotonic()
    payload = doctor()
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    emit("cadctl_doctor", payload, duration_ms=elapsed_ms(started))
    return 0
