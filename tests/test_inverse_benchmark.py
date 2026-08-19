"""Jet-engine inverse-design benchmark (0.8, whitepaper section 15.4).

A complete deterministic inverse loop, using only interpreters:

    1. build a nozzle with a parameterized outlet radius,
    2. inspect surfaces (selectors, not semantics),
    3. compile a flow spec and solve with SU2,
    4. read the observed outlet Mach,
    5. compare against the isentropic 1D prediction for the built area
       ratio,
    6. INVERT: pick the outlet radius the area-ratio table says achieves
       the target Mach, rebuild, re-run,
    7. verify the second design lands within tolerance of the target.

The inverse step is exact table math, not optimization theater: the loop
proves the evidence chain (geometry -> surface facts -> spec -> solve ->
observation) closes on a second iteration without human re-labeling.

SU2-gated: skips when the optional runtime is unavailable.
"""

from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

NOZZLE_TEMPLATE = '''
"""Parameterized converging-diverging nozzle fluid domain."""
from build123d import Axis, BuildLine, BuildPart, BuildSketch, Line, make_face, revolve

OUTLET_R = {outlet_r}
THROAT_R = 25.0
INLET_R = 50.0

PROFILE = [
    (0.0, INLET_R),
    (60.0, INLET_R),
    (120.0, THROAT_R),
    (300.0, OUTLET_R),
    (320.0, OUTLET_R),
]

with BuildPart() as nozzle:
    with BuildSketch() as sk:
        with BuildLine() as ln:
            for (x1, r1), (x2, r2) in zip(PROFILE, PROFILE[1:]):
                Line((x1, r1), (x2, r2))
            Line((PROFILE[-1][0], PROFILE[-1][1]), (PROFILE[-1][0], 0.0))
            Line((PROFILE[-1][0], 0.0), (PROFILE[0][0], 0.0))
            Line((PROFILE[0][0], 0.0), (PROFILE[0][0], PROFILE[0][1]))
        make_face()
    revolve(axis=Axis.X)

result = nozzle.part
'''


def su2_available() -> bool:
    import os
    import shutil

    from cadctl.simulation.su2_backend import resolve_su2_binary

    if os.environ.get("PI_CAD_SU2_BIN") and Path(os.environ["PI_CAD_SU2_BIN"]).exists():
        return True
    if shutil.which("SU2_CFD"):
        return True
    try:
        resolve_su2_binary()
        return True
    except Exception:
        return False


def area_ratio_for_mach(mach: float, gamma: float = 1.4) -> float:
    """Isentropic supersonic area ratio A/A* for a given Mach number."""
    exponent = (gamma + 1) / (2 * (gamma - 1))
    term = (1 + (gamma - 1) / 2 * mach * mach) ** exponent
    return (1 / mach) * term


def mach_for_area_ratio(ratio: float, gamma: float = 1.4) -> float:
    """Invert the isentropic area-ratio relation (supersonic branch).

    A/A* is strictly increasing for M>1, so bisection is exact and robust
    (a Newton step near M=1 diverges because the function has a minimum
    there).
    """
    low, high = 1.0 + 1e-9, 20.0
    for _ in range(200):
        mid = (low + high) / 2
        if area_ratio_for_mach(mid, gamma) < ratio:
            low = mid
        else:
            high = mid
    return (low + high) / 2


def build_nozzle(root: Path, outlet_r: float) -> Path:
    from cadctl.model import run_source

    source = root / f"nozzle_{outlet_r:.2f}.py"
    source.write_text(NOZZLE_TEMPLATE.format(outlet_r=outlet_r), encoding="utf-8")
    step = root / f"nozzle_{outlet_r:.2f}.step"
    result = run_source(str(source), step)
    assert result.get("exitCode") == 0, result
    return step


def run_cadctl(*args: str, cwd: Path, timeout: int = 3600) -> dict:
    import os
    import subprocess
    import sys

    env = {**os.environ, "PYTHONPATH": str(ROOT / "python")}
    proc = subprocess.run(
        [sys.executable, "-m", "cadctl", *args],
        cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr)
    return json.loads(proc.stdout)


def run_flow(root: Path, step: Path) -> dict:
    surfaces = run_cadctl("inspect-surfaces", "--artifact", str(step), cwd=root)
    facts = surfaces["payload"]["surfaces"]
    outlet_x = 320.0
    inlet = next(s["id"] for s in facts if s["type"] == "plane" and abs(s["centroid"][0]) < 1e-9)
    outlet = next(s["id"] for s in facts if s["type"] == "plane" and abs(s["centroid"][0] - outlet_x) < 1e-6)
    walls = [s["id"] for s in facts if s["type"] != "plane"]
    spec = {
        "caseId": "nozzle-outlet",
        "fluidDomain": str(step),
        "geometryUnits": "mm",
        "physics": {"type": "compressible_euler"},
        "fluid": {"model": "ideal_gas", "gamma": 1.4, "gasConstantJPerKgK": 287.05},
        "initial": {"mach": 0.25, "temperatureK": 288.15, "pressurePa": 101325.0},
        "boundaries": [
            {"type": "total_conditions_inlet", "surfaces": [inlet], "totalPressurePa": 420000.0, "totalTemperatureK": 1150.0, "flowDirection": [1, 0, 0]},
            {"type": "pressure_outlet", "surfaces": [outlet], "staticPressurePa": 101325.0},
            {"type": "wall", "surfaces": walls, "thermal": "adiabatic"},
        ],
        "mesh": {"maxSizeMm": 14.0, "minSizeMm": 5.0},
        "convergence": {"maxIterations": 1500, "residualTarget": -6.0},
    }
    spec_path = root / "spec.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    envelope = run_cadctl(
        "simulate-flow", "run", "--spec", str(spec_path), "--output-dir", str(root / "out"), cwd=root,
    )
    assert envelope["ok"], envelope
    payload = envelope["payload"]
    assert payload["status"] == "solved", payload.get("reason")
    return payload["boundaries"][outlet]


@unittest.skipUnless(su2_available(), "SU2 runtime unavailable")
class InverseNozzleBenchmark(unittest.TestCase):
    TARGET_MACH = 2.2

    def test_inverse_loop_converges_on_target_outlet_mach(self):
        throat_r = 25.0
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            # Iteration 1: a first-guess outlet radius. Observe reality
            # before inverting — the 0.7 walking skeleton documented that
            # this coarse Euler mesh reads a few percent above the 1D
            # isentropic table for this geometry family, so the loop
            # calibrates on the observed point instead of assuming the
            # table is exact.
            first_r = 40.0
            step1 = build_nozzle(root, first_r)
            outlet1 = run_flow(root, step1)
            observed1 = outlet1["areaWeightedMean_Mach"]
            ratio1 = (first_r / throat_r) ** 2
            predicted1 = mach_for_area_ratio(ratio1)
            self.assertGreater(observed1, 1.0)
            self.assertLess(observed1, 3.0)
            # The 1D table must at least rank this geometry supersonic and
            # be within the coarse-mesh band documented in 0.7.
            self.assertLess(abs(observed1 - predicted1) / predicted1, 0.35,
                            f"observed {observed1:.3f} vs 1D {predicted1:.3f}")

            # Iteration 2: invert through the area-ratio table, calibrated
            # by the first observation. The effective area ratio of the
            # family is A_eff(M1) at r1; scale r to move it to A_eff(target).
            effective_ratio1 = area_ratio_for_mach(observed1)
            target_ratio = area_ratio_for_mach(self.TARGET_MACH)
            second_r = first_r * math.sqrt(target_ratio / effective_ratio1)
            step2 = build_nozzle(root, second_r)
            outlet2 = run_flow(root, step2)
            observed2 = outlet2["areaWeightedMean_Mach"]

            # The inverse design lands within tolerance of the target —
            # without any human re-labeling of surfaces between iterations.
            self.assertLess(abs(observed2 - self.TARGET_MACH) / self.TARGET_MACH, 0.10,
                            f"inverse design observed {observed2:.3f}, target {self.TARGET_MACH}")

            # And the calibration actually moved the design toward the
            # target, not away from it.
            self.assertLess(abs(observed2 - self.TARGET_MACH), abs(observed1 - self.TARGET_MACH))


if __name__ == "__main__":
    unittest.main()
