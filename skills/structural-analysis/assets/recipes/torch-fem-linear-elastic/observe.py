from __future__ import annotations

import json
import os
from pathlib import Path

from picad_sim import export as write_observation


root = Path(__file__).resolve().parent
observation_file = Path(os.environ.get("PI_RECIPE_OBSERVATION_FILE") or os.environ["PI_SIM_OBSERVATION_FILE"]).resolve()
observation_root = observation_file.parent
result = json.loads((root / "result.json").read_text(encoding="utf-8"))


def relative(path: str) -> str:
    return os.path.relpath(Path(path).resolve(), observation_root)


views = result.get("visualization", {}).get("views", [])
if not views:
    raise SystemExit("torch-fem result has no visualization")
accelerator = result.get("accelerator") or {}
health = {
    "columns": ["requested", "actual", "gpu", "vram_bytes", "compute_capability", "torch", "torch_cuda", "cupy", "cupy_cuda", "driver", "torch-fem", "dtype"],
    "rows": [[
        result.get("requestedDevice"), result.get("actualDevice"), accelerator.get("gpu"), accelerator.get("vramBytes"),
        accelerator.get("computeCapability"), result.get("torchVersion"), accelerator.get("torchCudaRuntime"),
        accelerator.get("cupyVersion"), accelerator.get("cupyCudaRuntime"), accelerator.get("cudaDriverVersion"),
        result.get("torchFemVersion"), result.get("dtype"),
    ]],
}
(root / "runtime-health.json").write_text(json.dumps(health, indent=2), encoding="utf-8")
exports = {
    "von_mises_view": {"type": "image", "path": relative(views[0]["path"])},
    "max_displacement": {"type": "scalar", "value": result["displacement"]["maxMagnitude"], "unit": "mm"},
    "max_von_mises": {"type": "scalar", "value": result["stress"]["maxVonMisesElement"], "unit": "MPa"},
    "reaction_magnitude": {"type": "scalar", "value": result["reaction"]["magnitude"], "unit": "N"},
    "runtime_health": {"type": "table", "path": relative(root / "runtime-health.json")},
    "fields": {"type": "field", "path": relative(result["fieldArtifacts"][0]), "format": "npz"},
}
sensitivity = (result.get("sensitivityArtifacts") or [None])[0]
if sensitivity:
    exports["sensitivity"] = {"type": "artifact", "path": relative(sensitivity), "format": "json"}
write_observation(exports, observation_file)
