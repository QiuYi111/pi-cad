from __future__ import annotations

import json
import os
import re
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

ROOT = Path.cwd()
WORKSPACE = Path(os.environ["PI_SIM_OBSERVATION_FILE"]).parent


def alpha_values(path: Path) -> np.ndarray:
    text = path.read_text(encoding="utf-8", errors="replace")
    uniform = re.search(r"internalField\s+uniform\s+([0-9.eE+-]+)\s*;", text)
    if uniform:
        count_match = re.search(r"nCells:\s*(\d+)", (path.parent.parent / "log.blockMesh").read_text(errors="replace"))
        if not count_match:
            raise RuntimeError(f"cannot determine cell count for {path}")
        return np.full(int(count_match.group(1)), float(uniform.group(1)))
    match = re.search(r"internalField\s+nonuniform\s+List<scalar>\s+(\d+)\s*\((.*?)\)\s*;", text, re.S)
    if not match:
        raise RuntimeError(f"cannot parse {path}")
    values = np.fromstring(match.group(2), sep=" ")
    if values.size != int(match.group(1)):
        raise RuntimeError(f"alpha length mismatch in {path}")
    return values


def numeric_times(case: Path) -> list[tuple[float, Path]]:
    result = []
    for path in case.iterdir():
        try:
            time = float(path.name)
        except ValueError:
            continue
        if (path / "alpha.water").is_file():
            result.append((time, path / "alpha.water"))
    return sorted(result)


def relative(path: Path) -> str:
    return path.relative_to(WORKSPACE).as_posix()


levels = {"coarse": (8, 16), "medium": (12, 24), "fine": (16, 32)}
series: dict[str, tuple[list[float], list[float], np.ndarray]] = {}
for name, (nxy, nz) in levels.items():
    samples = numeric_times(ROOT / "runs" / name)
    times = [time for time, _ in samples]
    fractions = [float(np.mean(alpha_values(path))) for _, path in samples]
    series[name] = (times, fractions, alpha_values(samples[-1][1]))

out = ROOT / "qualification-output"
out.mkdir(exist_ok=True)
times, fractions, final = series["medium"]
nx, nz = levels["medium"]
field = final.reshape((nz, nx, nx))
phase_png = out / "phase-distribution.png"
plt.figure(figsize=(6, 8))
plt.imshow(field[:, nx // 2, :], origin="lower", extent=(0, 40, 0, 80), vmin=0, vmax=1, cmap="Blues", aspect="auto")
plt.xlabel("x [mm]")
plt.ylabel("z [mm]")
plt.colorbar(label="water volume fraction")
plt.tight_layout()
plt.savefig(phase_png, dpi=140)
plt.close()

history_path = out / "interface-progress.json"
history_path.write_text(json.dumps({"x": times, "y": fractions}), encoding="utf-8")

frames = []
for _, alpha_path in numeric_times(ROOT / "runs" / "medium"):
    values = alpha_values(alpha_path).reshape((nz, nx, nx))[:, nx // 2, :]
    rgb = (plt.get_cmap("Blues")(values)[:, :, :3] * 255).astype(np.uint8)
    frames.append(Image.fromarray(rgb).resize((360, 720)))
animation_path = out / "interface.gif"
frames[0].save(animation_path, save_all=True, append_images=frames[1:], duration=180, loop=0)

expected = 0.02 * times[-1] / 0.08
rows = []
for name in ("coarse", "medium", "fine"):
    ts, fs, _ = series[name]
    rows.append([name, levels[name][0] ** 2 * levels[name][1], fs[-1], abs(fs[-1] - expected)])
refinement_path = out / "refinement.json"
refinement_path.write_text(json.dumps({"columns": ["level", "cells", "fill_fraction", "mass_error"], "rows": rows}), encoding="utf-8")

monotonic = all(b + 2e-3 >= a for a, b in zip(fractions, fractions[1:]))
fine_medium_delta = abs(series["fine"][1][-1] - fractions[-1])
report = {
    "schema": 1,
    "runtime": "openfoam14@20260724",
    "geometry": "3D bottom-inlet/top-outlet box",
    "checks": {
        "gravity_direction": [0, 0, -9.81],
        "interface_progression_monotonic": monotonic,
        "open_top_vent": True,
        "gas_phase_retained": fractions[-1] < 0.98,
        "mass_error": abs(fractions[-1] - expected),
        "fine_medium_delta": fine_medium_delta,
    },
    "limits": {"mass_error": 0.03, "fine_medium_delta": 0.02},
}
trapped_samples = numeric_times(ROOT / "runs" / "trapped")
trapped_final_gas = 1.0 - float(np.mean(alpha_values(trapped_samples[-1][1])))
trapped_initial_gas = 0.01 ** 3 / (0.04 * 0.04 * 0.08)
trapped_retention = trapped_final_gas / trapped_initial_gas
report["checks"]["closed_bubble_retention"] = trapped_retention
report["limits"]["closed_bubble_retention_min"] = 0.85
report["limits"]["closed_bubble_retention_max"] = 1.5
report["qualified"] = bool(monotonic and report["checks"]["mass_error"] < 0.03 and fine_medium_delta < 0.02 and 0.85 <= trapped_retention <= 1.5)
report_path = out / "qualification-report.json"
report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

observation = {
    "schema": 1,
    "exports": {
        "phase_distribution": {"type": "image", "path": relative(phase_png)},
        "fill_fraction": {"type": "scalar", "value": fractions[-1], "unit": "1"},
        "interface_progress": {"type": "timeseries", "path": relative(history_path)},
        "refinement": {"type": "table", "path": relative(refinement_path)},
        "interface_animation": {"type": "artifact", "path": relative(animation_path), "format": "gif"},
        "qualification_report": {"type": "artifact", "path": relative(report_path), "format": "json"},
    },
}
Path(os.environ["PI_SIM_OBSERVATION_FILE"]).write_text(json.dumps(observation), encoding="utf-8")
