from __future__ import annotations

import json
import os
from pathlib import Path


root = Path(__file__).resolve().parent
observation_file = Path(os.environ["PI_SIM_OBSERVATION_FILE"]).resolve()
observation_root = observation_file.parent
result = json.loads((root / "result.json").read_text(encoding="utf-8"))


def relative(path: str) -> str:
    return os.path.relpath(Path(path).resolve(), observation_root)


views = result.get("visualization", {}).get("views", [])
if not views:
    raise SystemExit("SU2 thermal result has no visualization")
residuals = result["convergence"]["finalResidualsLog10"]
table = {"columns": ["field", "final_log10"], "rows": [[key, value] for key, value in sorted(residuals.items())]}
(root / "convergence.json").write_text(json.dumps(table, indent=2), encoding="utf-8")
exports = {
    "temperature_view": {"type": "image", "path": relative(views[0]["path"])},
    "max_temperature": {"type": "scalar", "value": result["temperature"]["maxK"], "unit": "K"},
    "energy_imbalance": {"type": "scalar", "value": result["energyBalance"]["relativeReconstructedImbalance"], "unit": "1"},
    "convergence": {"type": "table", "path": relative(root / "convergence.json")},
    "fields": {"type": "field", "path": relative(result["fieldArtifacts"][0]), "format": "npz"},
}
observation_file.write_text(json.dumps({"schema": 1, "exports": exports}, indent=2), encoding="utf-8")
