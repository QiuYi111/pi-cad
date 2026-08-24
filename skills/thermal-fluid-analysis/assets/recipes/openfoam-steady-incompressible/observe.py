from __future__ import annotations

import json
import os
import re
from pathlib import Path

import matplotlib.pyplot as plt


root = Path(__file__).resolve().parent
observation_file = Path(os.environ.get("PI_RECIPE_OBSERVATION_FILE") or os.environ["PI_SIM_OBSERVATION_FILE"]).resolve()
observation_root = observation_file.parent
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
relative = lambda path: os.path.relpath(Path(path).resolve(), observation_root)
exports = {
    "convergence_plot": {"type": "image", "path": relative(results / "convergence.png")},
    "continuity_error": {"type": "scalar", "value": max(continuity, default=0.0), "unit": "1"},
    "residual_history": {"type": "timeseries", "path": relative(results / "residuals.json")},
    "solver_log": {"type": "artifact", "path": relative(root / "solver.log")},
}
observation_file.write_text(json.dumps({"schema": 1, "exports": exports}), encoding="utf-8")
