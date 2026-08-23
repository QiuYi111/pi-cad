from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path.cwd()
workspace = Path(os.environ["PI_SIM_OBSERVATION_FILE"]).parent
status_path = ROOT / "spec04-status.json"
status = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {"schema": 1, "status": "blocked_external", "releaseVerdict": None}
report_dir = ROOT / "report"
report_dir.mkdir(exist_ok=True)
report_path = report_dir / "release-report.json"

if status.get("status") != "computed":
    report = {**status, "validForRelease": False, "releaseVerdict": None}
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    observation = {"schema": 1, "exports": {"release_report": {"type": "artifact", "path": report_path.relative_to(workspace).as_posix(), "format": "json"}}}
    Path(os.environ["PI_SIM_OBSERVATION_FILE"]).write_text(json.dumps(observation), encoding="utf-8")
    raise SystemExit(0)

raw = ROOT / "results"
required = ["phase-distribution.png", "pressure-history.json", "robustness.json", "convergence.json", "metrics.json"]
missing = [name for name in required if not (raw / name).is_file()]
if missing:
    report_path.write_text(json.dumps({"schema": 1, "status": "blocked_external", "missing": missing, "validForRelease": False, "releaseVerdict": None}, indent=2), encoding="utf-8")
    Path(os.environ["PI_SIM_OBSERVATION_FILE"]).write_text(json.dumps({"schema": 1, "exports": {"release_report": {"type": "artifact", "path": report_path.relative_to(workspace).as_posix(), "format": "json"}}}), encoding="utf-8")
    raise SystemExit(0)

metrics = json.loads((raw / "metrics.json").read_text(encoding="utf-8"))
checks = {key: metrics.get(key) for key in ("postPlugTrappedGas", "peakPressure", "peakForce", "poseError", "massError")}
criteria = json.loads((ROOT / ".ignored-benchmark-inputs" / "rev1-spec-pack" / "release-criteria.json").read_text(encoding="utf-8"))
limits = criteria["limits"]
passed = (
    all(value is not None for value in checks.values())
    and float(checks["postPlugTrappedGas"]) <= float(limits["maxPostPlugTrappedGas"])
    and float(checks["peakPressure"]) <= float(limits["maxPeakPressure"])
    and float(checks["peakForce"]) <= float(limits["maxPeakForce"])
    and float(checks["poseError"]) <= float(limits["maxPoseError"])
    and float(checks["massError"]) <= float(limits["maxMassError"])
    and bool(metrics.get("converged"))
    and bool(metrics.get("robust"))
)
report = {"schema": 1, "status": "complete", "checks": checks, "limits": limits, "validForRelease": passed, "releaseVerdict": "SIMULATION_RELEASE_PASS" if passed else "SIMULATION_RELEASE_FAIL"}
report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
exports = {
    "phase_distribution": {"type": "image", "path": (raw / "phase-distribution.png").relative_to(workspace).as_posix()},
    "post_plug_trapped_gas": {"type": "scalar", "value": float(metrics["postPlugTrappedGas"]), "unit": "mm3"},
    "pressure_history": {"type": "timeseries", "path": (raw / "pressure-history.json").relative_to(workspace).as_posix()},
    "release_report": {"type": "artifact", "path": report_path.relative_to(workspace).as_posix(), "format": "json"},
    "robustness": {"type": "table", "path": (raw / "robustness.json").relative_to(workspace).as_posix()},
    "convergence": {"type": "table", "path": (raw / "convergence.json").relative_to(workspace).as_posix()},
}
Path(os.environ["PI_SIM_OBSERVATION_FILE"]).write_text(json.dumps({"schema": 1, "exports": exports}), encoding="utf-8")
