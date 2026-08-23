from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def cadctl_env() -> dict:
    env = os.environ.copy()
    entries = [str(ROOT / "python")]
    venv = ROOT / ".venv" / "bin" / "python"
    site = ROOT / ".python" / "site-packages"
    if site.exists() and not venv.exists():
        entries.append(str(site))
    if env.get("PYTHONPATH"):
        entries.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(entries)
    return env


def run_cadctl(*args: str, cwd: Path, timeout: int = 3600) -> dict:
    proc = subprocess.run(
        [sys.executable, "-m", "cadctl", *args],
        cwd=cwd,
        env=cadctl_env(),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr)
    return json.loads(proc.stdout)


def su2_ready() -> bool:
    try:
        envelope = run_cadctl("doctor", "--json", cwd=ROOT, timeout=240)
    except Exception:
        return False
    return envelope.get("capabilities", {}).get("thermalFluid", {}).get("status") == "ready"


def make_slab(root: Path) -> Path:
    from cadctl.model import run_source

    step = root / "slab.step"
    result = run_source(str(ROOT / "tests" / "fixtures" / "slab.py"), step)
    assert result.get("exitCode") == 0, result
    return step


def make_nozzle(root: Path) -> Path:
    from cadctl.model import run_source

    step = root / "nozzle.step"
    result = run_source(str(ROOT / "tests" / "fixtures" / "nozzle.py"), step)
    assert result.get("exitCode") == 0, result
    return step


class SurfaceInspectionTests(unittest.TestCase):
    def test_inspect_surfaces_returns_facts_and_stable_selectors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            step = make_slab(Path(tmp))
            a = run_cadctl(
                "inspect-surfaces", "--artifact", str(step), cwd=Path(tmp),
            )
            self.assertTrue(a["ok"], a)
            payload = a["payload"]
            self.assertEqual(payload["surfaceCount"], 6)
            self.assertTrue(payload["artifactHash"])
            for surface in payload["surfaces"]:
                self.assertRegex(surface["id"], r"^surf-[0-9a-f]{10}$")
                self.assertIn("area", surface)
                self.assertIn("centroid", surface)
                self.assertIn("bbox", surface)
                self.assertIn("type", surface)
                if surface["type"] == "plane":
                    self.assertIn("normal", surface)
                # Facts only: the tool never returns engineering semantics.
                self.assertNotIn("semantic", surface)
                self.assertNotIn("meaning", surface)

            # Determinism: the same bytes always give the same IDs.
            b = run_cadctl("inspect-surfaces", "--artifact", str(step), cwd=Path(tmp))
            self.assertEqual(
                [s["id"] for s in a["payload"]["surfaces"]],
                [s["id"] for s in b["payload"]["surfaces"]],
            )

    def test_unknown_surface_ids_fail_closed(self) -> None:
        from cadctl.simulation.surface_selector import resolve_surface_ids

        with tempfile.TemporaryDirectory() as tmp:
            step = make_slab(Path(tmp))
            with self.assertRaises(ValueError) as ctx:
                resolve_surface_ids(step, ["surf-doesnotexist"])
            self.assertIn("unknown surface IDs", str(ctx.exception))


class FlowValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        # Validation checks existence; the pure-schema tests do not solve.
        (ROOT / "duct.step").touch(exist_ok=True)

    def tearDown(self) -> None:
        try:
            (ROOT / "duct.step").unlink()
        except FileNotFoundError:
            pass

    def base_spec(self) -> dict:
        return {
            "caseId": "duct",
            "fluidDomain": "duct.step",
            "geometryUnits": "mm",
            "physics": {"type": "compressible_euler"},
            "fluid": {"model": "ideal_gas", "gamma": 1.4, "gasConstantJPerKgK": 287.05},
            "initial": {"mach": 0.25, "temperatureK": 288.15, "pressurePa": 101325.0},
            "boundaries": [
                {"type": "total_conditions_inlet", "surfaces": ["surf-a"], "totalPressurePa": 150000.0, "totalTemperatureK": 300.0, "flowDirection": [1, 0, 0]},
                {"type": "pressure_outlet", "surfaces": ["surf-b"], "staticPressurePa": 101325.0},
                {"type": "wall", "surfaces": ["surf-c"], "thermal": "adiabatic"},
            ],
            "mesh": {"maxSizeMm": 8.0},
            "convergence": {"maxIterations": 100, "residualTarget": -6.0},
        }

    def test_valid_spec_passes(self) -> None:
        from cadctl.simulation.flow_api import validate_flow_spec

        ok, errors = validate_flow_spec(self.base_spec())
        self.assertTrue(ok, errors)

    def test_fail_closed_semantics(self) -> None:
        from cadctl.simulation.flow_api import validate_flow_spec

        def expect_error(mutate, fragment: str) -> None:
            import copy

            spec = self.base_spec()
            mutate(spec)
            ok, errors = validate_flow_spec(spec)
            self.assertFalse(ok, errors)
            self.assertTrue(any(fragment in e for e in errors), (fragment, errors))

        expect_error(lambda s: s.pop("caseId"), "caseId is required")
        expect_error(lambda s: s.pop("fluidDomain"), "fluidDomain is required")
        expect_error(lambda s: s.update(turbulnce=1), "unknown keys")
        expect_error(lambda s: s["physics"].update(type="turbomachinery"), "physics.type")
        expect_error(lambda s: s["physics"].update(type="compressible_rans"), "turbulence")
        expect_error(lambda s: s["physics"].update(turbulence="sst"), "only valid for RANS")
        expect_error(lambda s: s["fluid"].update(model="constant_density"), "ideal_gas")
        expect_error(lambda s: s["fluid"].update(densityKgPerM3=1.2), "unknown keys")
        expect_error(lambda s: s["initial"].pop("mach"), "initial.mach")
        expect_error(lambda s: s["boundaries"][0].update(totalPresurePa=1), "unknown keys")
        expect_error(
            lambda s: s["boundaries"].insert(0, {"type": "velocity_inlet", "surfaces": ["surf-z"], "velocityMPerS": 2.0, "temperatureK": 300.0, "flowDirection": [1, 0, 0]}),
            "requires incompressible physics",
        )
        expect_error(
            lambda s: s["boundaries"][2].update(thermal={"heatFluxWPerM2": 100.0}),
            "requires compressible_rans",
        )
        expect_error(lambda s: s["mesh"].update(maxSizeMm=0), "maxSizeMm")
        expect_error(lambda s: s.update(geometryUnits="inch"), "geometryUnits")
        expect_error(
            lambda s: s["physics"].update(type="compressible_rans", turbulence="sst"),
            "requires fluid.viscosity",
        )
        expect_error(
            lambda s: s["fluid"].update(
                viscosity={"model": "sutherland", "muRefPas": 1.716e-5, "temperatureRefK": 273.15}
            ),
            "not applicable to compressible_euler",
        )
        expect_error(
            lambda s: (
                s["physics"].update(type="incompressible_ns"),
                s["fluid"].update(viscosity={"model": "water"}),
            ),
            "fluid.viscosity.model must be constant or sutherland",
        )

    def test_compile_cfg_requires_full_surface_coverage(self) -> None:
        from cadctl.simulation.su2_config import compile_flow_cfg

        spec = self.base_spec()
        spec["boundaries"][2]["surfaces"] = ["surf-a"]  # double classification
        with self.assertRaises(ValueError) as ctx:
            compile_flow_cfg(spec, "m.su2", 0.5, ["surf-a", "surf-b", "surf-c"])
        self.assertIn("classified by both", str(ctx.exception))

        spec["boundaries"][2]["surfaces"] = []
        with self.assertRaises(ValueError) as ctx:
            compile_flow_cfg(spec, "m.su2", 0.5, ["surf-a", "surf-b", "surf-c"])
        self.assertIn("uncovered", str(ctx.exception))

    def test_rans_cfg_emits_declared_viscosity_and_derived_reynolds(self) -> None:
        from cadctl.simulation.su2_config import compile_flow_cfg

        spec = self.base_spec()
        spec["physics"] = {"type": "compressible_rans", "turbulence": "sst"}
        spec["fluid"]["viscosity"] = {
            "model": "sutherland",
            "muRefPas": 1.716e-5,
            "temperatureRefK": 273.15,
            "sutherlandConstantK": 110.4,
        }
        text = compile_flow_cfg(spec, "m.su2", 0.5, ["surf-a", "surf-b", "surf-c"])
        # The declared constants reach SU2 verbatim; nothing defaults to air.
        self.assertIn("VISCOSITY_MODEL= SUTHERLAND", text)
        self.assertIn("MU_REF= 1.716e-05", text)
        self.assertIn("MU_T_REF= 273.15", text)
        self.assertIn("SUTHERLAND_CONSTANT= 110.4", text)
        # Reynolds derived from the declared model at the freestream state,
        # not from a hidden Sutherland assumption.
        rho = 101325.0 / (287.05 * 288.15)
        a = (1.4 * 287.05 * 288.15) ** 0.5
        mu = 1.716e-5 * (288.15 / 273.15) ** 1.5 * (273.15 + 110.4) / (288.15 + 110.4)
        expected = rho * 0.25 * a * 0.5 / mu
        self.assertIn(f"REYNOLDS_NUMBER= {expected!r}", text)

    def test_incompressible_cfg_requires_declared_constant_viscosity(self) -> None:
        from cadctl.simulation.su2_config import compile_flow_cfg

        spec = {
            "caseId": "duct",
            "fluidDomain": "duct.step",
            "geometryUnits": "mm",
            "physics": {"type": "incompressible_ns"},
            "fluid": {
                "model": "constant_density",
                "densityKgPerM3": 1000.0,
                "viscosity": {"model": "constant", "muPas": 1e-3},
            },
            "initial": {"velocityMPerS": 2.0},
            "boundaries": [
                {"type": "velocity_inlet", "surfaces": ["surf-a"], "velocityMPerS": 2.0, "temperatureK": 300.0, "flowDirection": [1, 0, 0]},
                {"type": "pressure_outlet", "surfaces": ["surf-b"], "staticPressurePa": 0.0},
                {"type": "wall", "surfaces": ["surf-c"], "thermal": "adiabatic"},
            ],
            "mesh": {"maxSizeMm": 8.0},
        }
        text = compile_flow_cfg(spec, "m.su2", 0.5, ["surf-a", "surf-b", "surf-c"])
        self.assertIn("SOLVER= INC_NAVIER_STOKES", text)
        self.assertIn("VISCOSITY_MODEL= CONSTANT_VISCOSITY", text)
        self.assertIn("MU_CONSTANT= 0.001", text)
        # A missing viscosity contract must fail closed, not fall back to air.
        import copy

        broken = copy.deepcopy(spec)
        del broken["fluid"]["viscosity"]
        with self.assertRaises(ValueError) as ctx:
            compile_flow_cfg(broken, "m.su2", 0.5, ["surf-a", "surf-b", "surf-c"])
        self.assertIn("requires fluid.viscosity", str(ctx.exception))

    def test_compiled_cfg_is_deterministic_and_dimensional(self) -> None:
        from cadctl.simulation.su2_config import compile_flow_cfg

        spec = self.base_spec()
        text = compile_flow_cfg(spec, "m.su2", 0.5, ["surf-a", "surf-b", "surf-c"])
        self.assertIn("SOLVER= EULER", text)
        self.assertIn("MARKER_INLET= ( surf-a, 300.0, 150000.0, 1.0, 0.0, 0.0 )", text)
        self.assertIn("MARKER_OUTLET= ( surf-b, 101325.0 )", text)
        self.assertIn("MARKER_EULER= ( surf-c )", text)
        self.assertIn("ITER= 100", text)
        # Fixed numerics: no invented physics in the compiled world.
        self.assertIn("CFL_NUMBER= 2.0", text)
        again = compile_flow_cfg(spec, "m.su2", 0.5, ["surf-a", "surf-b", "surf-c"])
        self.assertEqual(text, again)


class ThermalValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        (ROOT / "slab.step").touch(exist_ok=True)

    def tearDown(self) -> None:
        try:
            (ROOT / "slab.step").unlink()
        except FileNotFoundError:
            pass

    def base_spec(self) -> dict:
        return {
            "caseId": "slab",
            "artifact": "slab.step",
            "geometryUnits": "mm",
            "material": {"conductivityWPerMK": 16.2},
            "boundaries": [
                {"type": "temperature", "surfaces": ["surf-hot"], "temperatureK": 1150.0},
                {"type": "temperature", "surfaces": ["surf-cold"], "temperatureK": 300.0},
            ],
            "mesh": {"maxSizeMm": 25.0},
        }

    def test_valid_spec_passes(self) -> None:
        from cadctl.simulation.thermal_api import validate_thermal_spec

        ok, errors = validate_thermal_spec(self.base_spec())
        self.assertTrue(ok, errors)

    def test_fail_closed_semantics(self) -> None:
        from cadctl.simulation.thermal_api import validate_thermal_spec

        def expect_error(mutate, fragment: str) -> None:
            import copy

            spec = self.base_spec()
            mutate(spec)
            ok, errors = validate_thermal_spec(spec)
            self.assertFalse(ok, errors)
            self.assertTrue(any(fragment in e for e in errors), (fragment, errors))

        expect_error(lambda s: s["boundaries"].clear(), "boundaries is required")
        expect_error(
            lambda s: s["boundaries"].__setitem__(0, {"type": "heat_flux", "surfaces": ["surf-hot"], "heatFluxWPerM2": 10.0})
            or s["boundaries"].__setitem__(1, {"type": "heat_flux", "surfaces": ["surf-cold"], "heatFluxWPerM2": -10.0}),
            "at least one temperature boundary",
        )
        expect_error(lambda s: s["material"].update(conductivty=1), "unknown keys")
        expect_error(lambda s: s["material"].update(conductivityWPerMK=-1), "must be a number > 0")
        expect_error(lambda s: s["boundaries"][0].update(temperatureK=-5), "temperatureK")

    def test_thermal_cfg_adds_adiabatic_remainder(self) -> None:
        from cadctl.simulation.su2_config import compile_thermal_cfg

        text = compile_thermal_cfg(self.base_spec(), "s.su2", ["surf-hot", "surf-cold", "surf-side1", "surf-side2"])
        self.assertIn("SOLVER= HEAT_EQUATION", text)
        self.assertIn("MARKER_ISOTHERMAL= ( surf-hot, 1150.0, surf-cold, 300.0 )", text)
        # Unlisted surfaces become the documented adiabatic remainder.
        self.assertIn("surf-side1, 0.0", text)
        self.assertIn("surf-side2, 0.0", text)
        self.assertIn("THERMAL_CONDUCTIVITY_CONSTANT= 16.2", text)


@unittest.skipUnless(su2_ready(), "SU2 runtime is not available")
class Su2WalkingSkeletonTests(unittest.TestCase):
    def test_thermal_slab_matches_analytic_conduction(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            step = make_slab(root)
            surfaces = run_cadctl("inspect-surfaces", "--artifact", str(step), cwd=root)
            facts = surfaces["payload"]["surfaces"]
            hot = next(s["id"] for s in facts if s.get("normal", [0, 0, 1])[2] == -1)
            cold = next(s["id"] for s in facts if s.get("normal", [0, 0, 1])[2] == 1)
            spec = {
                "caseId": "slab-axial",
                "artifact": str(step),
                "geometryUnits": "mm",
                "material": {"conductivityWPerMK": 16.2},
                "boundaries": [
                    {"type": "temperature", "surfaces": [hot], "temperatureK": 1150.0},
                    {"type": "temperature", "surfaces": [cold], "temperatureK": 300.0},
                ],
                "mesh": {"maxSizeMm": 25.0},
                "convergence": {"maxIterations": 3000, "residualTarget": -9.0},
            }
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            from cadctl.simulation.thermal_api import run_thermal

            payload = run_thermal(str(spec_path), str(root / "out"), stage="run")
            self.assertEqual(payload["status"], "solved")
            self.assertEqual(payload["backend"], "su2")
            self.assertEqual(payload["caseId"], "slab-axial")
            analytic = 16.2 * 0.01 * 850 / 0.5
            hot_rate = abs(payload["boundaries"][hot]["reconstructedHeatRateW"])
            cold_rate = abs(payload["boundaries"][cold]["reconstructedHeatRateW"])
            self.assertLess(abs(hot_rate - analytic) / analytic, 0.06, (hot_rate, analytic))
            self.assertLess(abs(cold_rate - analytic) / analytic, 0.06, (cold_rate, analytic))
            self.assertGreater(payload["temperature"]["minK"], 295.0)
            self.assertLess(payload["temperature"]["maxK"], 1155.0)
            self.assertTrue(Path(payload["artifact"]).exists())
            self.assertTrue(payload["fieldArtifacts"])
            self.assertTrue(payload["visualization"]["views"])

    def test_unmet_residual_target_returns_not_converged_and_creates_no_evidence(self) -> None:
        """Regression: a run that misses its own declared residual standard must
        not claim "solved". The harness records simulation evidence only for
        status == solved, so a not_converged run can never close a required
        case even though its raw fields are still returned."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            step = make_slab(root)
            surfaces = run_cadctl("inspect-surfaces", "--artifact", str(step), cwd=root)
            facts = surfaces["payload"]["surfaces"]
            hot = next(s["id"] for s in facts if s.get("normal", [0, 0, 1])[2] == -1)
            cold = next(s["id"] for s in facts if s.get("normal", [0, 0, 1])[2] == 1)
            spec = {
                "caseId": "slab-impossible",
                "artifact": str(step),
                "geometryUnits": "mm",
                "material": {"conductivityWPerMK": 16.2},
                "boundaries": [
                    {"type": "temperature", "surfaces": [hot], "temperatureK": 1150.0},
                    {"type": "temperature", "surfaces": [cold], "temperatureK": 300.0},
                ],
                "mesh": {"maxSizeMm": 30.0},
                "convergence": {"maxIterations": 1, "residualTarget": -12.0},
            }
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            from cadctl.simulation.thermal_api import run_thermal

            payload = run_thermal(str(spec_path), str(root / "out"), stage="run")
            self.assertEqual(payload["status"], "not_converged")
            self.assertIn("did not reach", payload["reason"])
            self.assertEqual(payload["caseId"], "slab-impossible")
            # Raw fields are still written for inspection.
            self.assertTrue((root / "out" / "thermal-result.json").exists())

    def test_missing_residual_target_never_qualifies_as_solved(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            step = make_slab(root)
            surfaces = run_cadctl("inspect-surfaces", "--artifact", str(step), cwd=root)
            facts = surfaces["payload"]["surfaces"]
            hot = next(s["id"] for s in facts if s.get("normal", [0, 0, 1])[2] == -1)
            cold = next(s["id"] for s in facts if s.get("normal", [0, 0, 1])[2] == 1)
            spec = {
                "caseId": "slab-no-target",
                "artifact": str(step),
                "geometryUnits": "mm",
                "material": {"conductivityWPerMK": 16.2},
                "boundaries": [
                    {"type": "temperature", "surfaces": [hot], "temperatureK": 1150.0},
                    {"type": "temperature", "surfaces": [cold], "temperatureK": 300.0},
                ],
                "mesh": {"maxSizeMm": 30.0},
            }
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            from cadctl.simulation.thermal_api import run_thermal

            payload = run_thermal(str(spec_path), str(root / "out"), stage="run")
            self.assertEqual(payload["status"], "not_converged")
            self.assertIn("no convergence.residualTarget", payload["reason"])

    def test_nozzle_flow_produces_supersonic_outlet_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            step = make_nozzle(root)
            surfaces = run_cadctl("inspect-surfaces", "--artifact", str(step), cwd=root)
            facts = surfaces["payload"]["surfaces"]
            inlet = next(s["id"] for s in facts if s["type"] == "plane" and abs(s["centroid"][0]) < 1e-9)
            outlet = next(s["id"] for s in facts if s["type"] == "plane" and abs(s["centroid"][0] - 320.0) < 1e-6)
            walls = [s["id"] for s in facts if s["type"] != "plane"]
            spec = {
                "caseId": "nozzle-outlet",
                "artifact": str(step),
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
            from cadctl.simulation.flow_api import run_flow

            payload = run_flow(str(spec_path), str(root / "out"), stage="run")
            self.assertEqual(payload["status"], "solved")
            self.assertEqual(payload["caseId"], "nozzle-outlet")
            self.assertGreater(payload["mesh"]["nodeCount"], 500)
            self.assertLess(payload["massBalance"]["relativeImbalance"], 0.05, payload["massBalance"])
            outlet_mach = payload["boundaries"][outlet]["areaWeightedMean_Mach"]
            self.assertGreater(outlet_mach, 1.0, outlet_mach)
            self.assertLess(outlet_mach, 3.0, outlet_mach)

    def test_incompressible_ns_runs_with_declared_viscosity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            step = make_nozzle(root)
            surfaces = run_cadctl("inspect-surfaces", "--artifact", str(step), cwd=root)
            facts = surfaces["payload"]["surfaces"]
            inlet = next(s["id"] for s in facts if s["type"] == "plane" and abs(s["centroid"][0]) < 1e-9)
            outlet = next(s["id"] for s in facts if s["type"] == "plane" and abs(s["centroid"][0] - 320.0) < 1e-6)
            walls = [s["id"] for s in facts if s["type"] != "plane"]
            spec = {
                "caseId": "nozzle-water",
                "fluidDomain": str(step),
                "geometryUnits": "mm",
                "physics": {"type": "incompressible_ns"},
                "fluid": {
                    "model": "constant_density",
                    "densityKgPerM3": 1000.0,
                    "viscosity": {"model": "constant", "muPas": 1e-3},
                },
                "initial": {"velocityMPerS": 2.0},
                "boundaries": [
                    {"type": "velocity_inlet", "surfaces": [inlet], "velocityMPerS": 2.0, "temperatureK": 300.0, "flowDirection": [1, 0, 0]},
                    {"type": "pressure_outlet", "surfaces": [outlet], "staticPressurePa": 0.0},
                    {"type": "wall", "surfaces": walls, "thermal": "adiabatic"},
                ],
                "mesh": {"maxSizeMm": 16.0},
                "convergence": {"maxIterations": 600, "residualTarget": -6.0},
            }
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            from cadctl.simulation.flow_api import run_flow

            payload = run_flow(str(spec_path), str(root / "out"), stage="run")
            self.assertIn(payload["status"], {"solved", "not_converged"})
            # The declared viscosity is the one in the compiled cfg; nothing
            # defaulted to air anywhere in the pipeline.
            cfg = (root / "out" / "case.cfg").read_text(encoding="utf-8")
            self.assertIn("VISCOSITY_MODEL= CONSTANT_VISCOSITY", cfg)
            self.assertIn("MU_CONSTANT= 0.001", cfg)
            if payload["status"] == "solved":
                self.assertLess(payload["massBalance"]["relativeImbalance"], 0.05, payload["massBalance"])

    def test_mid_solve_artifact_mutation_discards_flow_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            step = make_nozzle(root)
            surfaces = run_cadctl("inspect-surfaces", "--artifact", str(step), cwd=root)
            facts = surfaces["payload"]["surfaces"]
            inlet = next(s["id"] for s in facts if s["type"] == "plane" and abs(s["centroid"][0]) < 1e-9)
            outlet = next(s["id"] for s in facts if s["type"] == "plane" and abs(s["centroid"][0] - 320.0) < 1e-6)
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
                "mesh": {"maxSizeMm": 20.0},
                "convergence": {"maxIterations": 50},
            }
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(spec), encoding="utf-8")

            from cadctl.simulation import flow_api

            original_run_su2 = flow_api.run_su2

            def mutating_run_su2(config_path, workdir, timeout_s=5400.0):
                # Fire between run_flow's pre-hash and its post-solve check.
                with open(step, "ab") as handle:
                    handle.write(b"\n")
                return original_run_su2(config_path, workdir, timeout_s=timeout_s)

            flow_api.run_su2 = mutating_run_su2
            try:
                payload = flow_api.run_flow(str(spec_path), str(root / "out"), stage="run")
            finally:
                flow_api.run_su2 = original_run_su2
            self.assertEqual(payload["status"], "discarded")
            self.assertIn("changed during simulation", payload["reason"])


if __name__ == "__main__":
    unittest.main()


from cadctl.simulation.flow_api import validate_flow_spec  # noqa: E402
from cadctl.simulation.thermal_api import validate_thermal_spec  # noqa: E402


class AnalysisModelDeclaration(unittest.TestCase):
    """0.8 review P0-6: derivation records, not free-form declarations."""

    def _flow_spec(self, domain, **extra):
        spec = {
            "caseId": "am-1",
            "fluidDomain": domain,
            "geometryUnits": "mm",
            "physics": {"type": "compressible_euler"},
            "fluid": {"model": "ideal_gas", "gamma": 1.4, "gasConstantJPerKgK": 287.05},
            "initial": {"mach": 0.25, "temperatureK": 288.15, "pressurePa": 101325.0},
            "boundaries": [
                {"type": "total_conditions_inlet", "surfaces": ["surf-a"], "totalPressurePa": 150000.0, "totalTemperatureK": 300.0, "flowDirection": [1, 0, 0]},
                {"type": "pressure_outlet", "surfaces": ["surf-b"], "staticPressurePa": 101325.0},
                {"type": "wall", "surfaces": ["surf-c"], "thermal": "adiabatic"},
            ],
            "mesh": {"maxSizeMm": 8.0},
            "convergence": {"maxIterations": 100, "residualTarget": -6.0},
        }
        spec.update(extra)
        return spec

    def _record(self, tmp, source_hash="a" * 64, output_hash="b" * 64, executed=True):
        path = Path(tmp) / "derivation.json"
        path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "sourceHash": source_hash,
                    "outputHash": output_hash,
                    "operations": ["fused"],
                    "executed": executed,
                }
            )
        )
        return path

    def test_analysis_model_is_optional_and_takes_derivation_ref(self):
        with tempfile.TemporaryDirectory() as tmp:
            domain = Path(tmp) / "domain.step"
            domain.write_text("fluid volume")
            ok, errors = validate_flow_spec(self._flow_spec(str(domain)))
            self.assertTrue(ok, errors)

            record = self._record(tmp)
            ok, errors = validate_flow_spec(
                self._flow_spec(str(domain), analysisModel={"derivationRef": str(record)})
            )
            self.assertTrue(ok, errors)

            missing = self._record(tmp)
            missing.unlink()
            ok, errors = validate_flow_spec(
                self._flow_spec(str(domain), analysisModel={"derivationRef": str(missing)})
            )
            self.assertFalse(ok)
            self.assertIn("derivationRef does not exist", " ".join(errors))

    def test_free_form_source_operations_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            domain = Path(tmp) / "domain.step"
            domain.write_text("fluid volume")
            legacy = {"source": "models/part.step", "operations": ["fused"]}
            ok, errors = validate_flow_spec(
                self._flow_spec(str(domain), analysisModel=legacy)
            )
            self.assertFalse(ok)
            self.assertTrue(any("unknown keys" in e and "derivationRef" in e for e in errors))

    def test_thermal_spec_accepts_derivation_ref(self):
        with tempfile.TemporaryDirectory() as tmp:
            slab = Path(tmp) / "slab.step"
            slab.write_text("step bytes")
            record = self._record(tmp)
            spec = {
                "caseId": "am-2",
                "artifact": str(slab),
                "material": {"conductivityWPerMK": 15.0},
                "boundaries": [
                    {"type": "temperature", "surfaces": ["surf-hot"], "temperatureK": 1150.0},
                ],
                "mesh": {"maxSizeMm": 5.0},
                "convergence": {"maxIterations": 10},
                "analysisModel": {"derivationRef": str(record)},
            }
            ok, errors = validate_thermal_spec(spec)
            self.assertTrue(ok, errors)


class AnalysisModelProvenance(unittest.TestCase):
    """The derivation chain is frozen: mid-solve mutation discards."""

    def test_spec_input_paths_freezes_record_and_analysis_source(self):
        from cadctl.provenance import FrozenInputs, spec_input_paths

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            source = tmp / "design.step"
            source.write_text("canonical design bytes")
            derived = tmp / "fused.step"
            derived.write_text("derived bytes")
            record = tmp / "derivation.json"
            record.write_text(
                json.dumps(
                    {
                        "sourceHash": "x" * 64,
                        "outputHash": "y" * 64,
                        "source": str(source),
                        "output": str(derived),
                        "executed": True,
                    }
                )
            )
            spec_path = tmp / "spec.json"
            spec_path.write_text(
                json.dumps(
                    {
                        "caseId": "c",
                        "artifact": str(derived),
                        "analysisModel": {"derivationRef": str(record)},
                    }
                )
            )
            entries = spec_input_paths(spec_path)
            roles = [role for role, _ in entries]
            self.assertIn("derivationRecord", roles)
            self.assertIn("analysisSource", roles)

            frozen = FrozenInputs.freeze(entries)
            self.assertEqual(frozen.changed_role(), None)

            # Mutating the authoritative source mid-solve discards.
            source.write_text("tampered")
            self.assertEqual(frozen.changed_role(), "analysisSource")

            # Mutating the record itself discards too.
            source.write_text("canonical design bytes")
            record.write_text("{}")
            self.assertEqual(frozen.changed_role(), "derivationRecord")


class DerivationExecution(unittest.TestCase):
    """cad_derive_analysis_model executes fuses mechanically."""

    def test_fused_derivation_executes_and_hashes(self):
        import build123d as bd

        from cadctl.analysis_model import run_derivation, validate_derive_spec

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            with bd.BuildPart() as p:
                bd.Box(20, 20, 20, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
                a = p.part
            with bd.BuildPart() as p:
                bd.Box(20, 20, 20, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MAX))
                b = p.part
            source = tmp / "assembly.step"
            bd.export_step(bd.Compound([a, b]), source)

            spec = tmp / "spec.json"
            spec.write_text(json.dumps({"source": str(source), "operations": ["fused"]}))
            record = run_derivation(spec, tmp / "out")
            self.assertTrue(record["executed"])
            fused = bd.import_step(record["output"])
            self.assertEqual(len(fused.solids()), 1)
            self.assertAlmostEqual(fused.volume, 16000.0, places=-1)
            # Re-running is byte-stable for the same source.
            record2 = run_derivation(spec, tmp / "out2")
            self.assertEqual(record["outputHash"], record2["outputHash"])

    def test_authored_derivation_requires_existing_output(self):
        from cadctl.analysis_model import run_derivation, validate_derive_spec

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            source = tmp / "design.step"
            source.write_text("step bytes")
            spec = tmp / "spec.json"
            spec.write_text(
                json.dumps({"source": str(source), "operations": ["simplified"], "output": str(tmp / "nope.step")})
            )
            with self.assertRaises(ValueError):
                run_derivation(spec, tmp / "out")

            ok, errors = validate_derive_spec({"source": str(source), "operations": ["fused", "simplified"]})
            self.assertFalse(ok)
            self.assertTrue(any("cannot be combined" in e for e in errors))
