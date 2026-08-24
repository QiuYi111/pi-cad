from __future__ import annotations

import json
import os
from pathlib import Path

from picad_sim import export as write_observation


root = Path(__file__).resolve().parent
observation_file = Path(os.environ["PI_SIM_OBSERVATION_FILE"]).resolve()
result = json.loads((root / "result.json").read_text(encoding="utf-8"))
views = result.get("visualization", {}).get("views", [])
sensitivity_path = Path((result.get("sensitivityArtifacts") or [""])[0])
if not views or not sensitivity_path:
    raise SystemExit("missing structural visualization or sensitivity artifact")
sensitivity = json.loads(sensitivity_path.read_text(encoding="utf-8"))
relative_error = sensitivity.get("relativeError")
if not isinstance(relative_error, (int, float)):
    raise SystemExit("sensitivity artifact has no finite-difference relativeError")
health = {
    "columns": ["requested", "actual", "gpu", "compute_capability", "torch", "cupy", "torch-fem", "dtype"],
    "rows": [[result.get("requestedDevice"), result.get("actualDevice"), (result.get("accelerator") or {}).get("gpu"), (result.get("accelerator") or {}).get("computeCapability"), result.get("torchVersion"), (result.get("accelerator") or {}).get("cupyVersion"), result.get("torchFemVersion"), result.get("dtype")]],
}
(root / "runtime-health.json").write_text(json.dumps(health), encoding="utf-8")
relative = lambda path: os.path.relpath(Path(path).resolve(), observation_file.parent)
write_observation({
    "von_mises_view": {"type": "image", "path": relative(views[0]["path"])},
    "gradient_relative_error": {"type": "scalar", "value": relative_error, "unit": "1"},
    "sensitivity": {"type": "artifact", "path": relative(sensitivity_path), "format": "json"},
    "runtime_health": {"type": "table", "path": relative(root / "runtime-health.json")},
}, observation_file)
