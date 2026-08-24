from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .client import request


@dataclass(frozen=True, repr=False)
class SimulationResult:
    run_id: str
    recipe_id: str
    compute_identity: str
    observation: dict[str, Any]

    def __repr__(self) -> str:
        return f"SimulationResult(run_id={self.run_id!r}, recipe_id={self.recipe_id!r}, compute_identity={self.compute_identity[:12] + '…'!r})"

    @property
    def exports(self) -> dict[str, Any]:
        return {item["name"]: item for item in self.observation.get("exports", [])}


@dataclass(frozen=True, repr=False)
class SimulationJob:
    _result: SimulationResult

    def __repr__(self) -> str:
        return f"SimulationJob(run_id={self._result.run_id!r}, status='completed')"

    async def result(self) -> SimulationResult:
        return self._result


async def run(*, subject: Any = None, recipe: str, obligation_ref: str | None = None, outputs: list[str] | None = None, action: str | None = None) -> SimulationJob:
    # Recipe owns frozen input identity. `subject` is accepted for the natural
    # Agent API but must already be declared by the Recipe rather than patched
    # into it by this adapter.
    del subject
    payload = await request("simulation-run", recipe=recipe, obligationRef=obligation_ref, outputs=outputs, action=action)
    return SimulationJob(SimulationResult(payload["runId"], payload["recipeId"], payload["computeIdentity"], payload["observation"]))
