from __future__ import annotations

import json
import os
import re
from pathlib import Path

import matplotlib.pyplot as plt


root = Path(__file__).resolve().parent
log = (root / "solver.log").read_text(encoding="utf-8", errors="replace")
residuals = [float(value) for value in re.findall(r"Initial residual = ([0-9.eE+-]+)", log)]
continuity = [abs(float(value)) for value in re.findall(r"global = ([0-9.eE+-]+)", log)]
if not residuals:
    raise SystemExit("no OpenFOAM residuals found in solver.log")
results = root / "observation-results"
results.mkdir(exist_ok=True)
series = {"x": list(range(1, len(residuals) + 1)), "y": residuals}
(results / "residuals.json").write_text(json.dumps(series), encoding="utf-8")
fig, ax = plt.subplots(figsize=(8, 5))
ax.semilogy(series["x"], series["y"])
ax.set(xlabel="linear solve", ylabel="initial residual", title="OpenFOAM convergence")
ax.grid(True)
fig.tight_layout()
fig.savefig(results / "convergence.png", dpi=150)
plt.close(fig)
observation = {
    "convergence_plot": {"path": "observation-results/convergence.png"},
    "continuity_error": {"value": max(continuity, default=0.0), "unit": "1"},
    "residual_history": {"path": "observation-results/residuals.json"},
    "solver_log": {"path": "solver.log"},
}
Path(os.environ["PI_SIM_OBSERVATION_FILE"]).write_text(json.dumps(observation), encoding="utf-8")
