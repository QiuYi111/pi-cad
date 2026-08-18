from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class DeviceInfo:
    requested: str
    actual: str
    dtype: str
    fallbackReason: str | None = None
    cudaAvailable: bool = False
    cupyAvailable: bool = False
    mpsAvailable: bool = False


class SimulationBackendError(RuntimeError):
    pass


class SimulationBackend:
    name = "base"

    def solve(self, spec: dict[str, Any], workdir: str) -> dict[str, Any]:
        raise NotImplementedError
