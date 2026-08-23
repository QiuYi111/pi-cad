from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


METRICS = ("postPlugTrappedGas", "peakPressure", "peakForce", "poseError", "massError")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--criteria", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    criteria = json.loads(args.criteria.read_text(encoding="utf-8"))
    if criteria.get("schema") != 1 or not isinstance(criteria.get("limits"), dict):
        raise ValueError("release-criteria.json must use schema 1 and define limits")
    limits = criteria["limits"]
    records: dict[tuple[str, str], dict] = {}
    for mesh in ("coarse", "nominal", "fine"):
        for robustness in ("low", "nominal", "high"):
            path = args.runs / mesh / robustness / "metrics.json"
            records[(mesh, robustness)] = json.loads(path.read_text(encoding="utf-8"))
    nominal = records[("nominal", "nominal")]
    convergence_rows = []
    for mesh in ("coarse", "nominal", "fine"):
        record = records[(mesh, "nominal")]
        convergence_rows.append([mesh, *[record[name] for name in METRICS]])
    convergence = {"columns": ["mesh", *METRICS], "rows": convergence_rows}
    convergence_delta = max(
        abs(float(records[("fine", "nominal")][name]) - float(nominal[name])) / max(abs(float(records[("fine", "nominal")][name])), 1e-18)
        for name in METRICS
    )
    robustness_rows = []
    for perturbation in ("low", "nominal", "high"):
        record = records[("nominal", perturbation)]
        robustness_rows.append([perturbation, *[record[name] for name in METRICS]])
    robustness = {"columns": ["perturbation", *METRICS], "rows": robustness_rows}
    robustness_spread = max(
        (max(float(records[("nominal", item)][name]) for item in ("low", "nominal", "high")) - min(float(records[("nominal", item)][name]) for item in ("low", "nominal", "high")))
        / max(abs(float(nominal[name])), 1e-18)
        for name in METRICS
    )
    metrics = {
        **{name: nominal[name] for name in METRICS},
        "convergenceDelta": convergence_delta,
        "robustnessSpread": robustness_spread,
        "converged": convergence_delta <= float(limits["maxConvergenceDelta"]),
        "robust": robustness_spread <= float(limits["maxRobustnessSpread"]),
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    (args.output / "convergence.json").write_text(json.dumps(convergence, indent=2), encoding="utf-8")
    (args.output / "robustness.json").write_text(json.dumps(robustness, indent=2), encoding="utf-8")
    shutil.copy2(args.runs / "nominal" / "nominal" / "phase-distribution.png", args.output / "phase-distribution.png")
    shutil.copy2(args.runs / "nominal" / "nominal" / "pressure-history.json", args.output / "pressure-history.json")


if __name__ == "__main__":
    main()
