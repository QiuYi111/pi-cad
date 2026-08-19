from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
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
            envelope = run_cadctl(
                "simulate-thermal", "run", "--spec", str(spec_path), "--output-dir", str(root / "out"), cwd=root,
            )
            self.assertTrue(envelope["ok"], envelope)
            payload = envelope["payload"]
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
            # Provenance: artifact pre-hashed and hash-bound in the envelope.
            self.assertIn("artifact", envelope["inputHashes"])
            kinds = {a["kind"] for a in envelope["artifacts"]}
            self.assertIn("simulation_result", kinds)
            self.assertIn("simulation_fields", kinds)
            self.assertIn("simulation_visual", kinds)

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
            envelope = run_cadctl(
                "simulate-thermal", "run", "--spec", str(spec_path), "--output-dir", str(root / "out"), cwd=root,
            )
            payload = envelope["payload"]
            self.assertEqual(payload["status"], "not_converged")
            self.assertIn("did not reach", payload["reason"])
            self.assertEqual(payload["caseId"], "slab-impossible")
            # The envelope itself is ok (the tool ran); the harness's
            # simulation gate keys on status, so this creates no evidence.
            self.assertTrue(envelope["ok"])
            self.assertTrue(any("not_converged" in w for w in envelope["warnings"]))
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
            envelope = run_cadctl(
                "simulate-thermal", "run", "--spec", str(spec_path), "--output-dir", str(root / "out"), cwd=root,
            )
            payload = envelope["payload"]
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
            envelope = run_cadctl(
                "simulate-flow", "run", "--spec", str(spec_path), "--output-dir", str(root / "out"), cwd=root,
            )
            self.assertTrue(envelope["ok"], envelope)
            payload = envelope["payload"]
            self.assertEqual(payload["status"], "solved")
            self.assertEqual(payload["caseId"], "nozzle-outlet")
            self.assertGreater(payload["mesh"]["nodeCount"], 500)
            self.assertLess(payload["massBalance"]["relativeImbalance"], 0.05, payload["massBalance"])
            outlet_mach = payload["boundaries"][outlet]["areaWeightedMean_Mach"]
            self.assertGreater(outlet_mach, 1.0, outlet_mach)
            self.assertLess(outlet_mach, 3.0, outlet_mach)
            self.assertIn("fluidDomain", envelope["inputHashes"])

    def test_mid_solve_spec_rewrite_discards_result(self) -> None:
        """Regression: the canonical spec is part of the frozen invocation
        inputs. Rewriting it while the solver runs must invalidate the run —
        not silently redefine provenance from the rewritten file."""
        import argparse
        import contextlib
        import io

        from cadctl import cli
        from cadctl.simulation import flow_api

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

            original_run_su2 = flow_api.run_su2

            def spec_rewriting_run_su2(config_path, workdir, timeout_s=5400.0):
                # The backend re-checks artifact/fluidDomain but not the spec;
                # the CLI's frozen-input gate must catch this instead.
                spec_path.write_text(
                    json.dumps({**spec, "caseId": "tampered-case"}), encoding="utf-8"
                )
                return original_run_su2(config_path, workdir, timeout_s=timeout_s)

            flow_api.run_su2 = spec_rewriting_run_su2
            try:
                captured = io.StringIO()
                with contextlib.redirect_stdout(captured):
                    exit_code = cli._cmd_simulate_flow(
                        argparse.Namespace(spec=str(spec_path), output_dir=str(root / "out"), stage="run")
                    )
            finally:
                flow_api.run_su2 = original_run_su2
            self.assertEqual(exit_code, 0)
            envelope = json.loads(captured.getvalue())
            self.assertFalse(envelope["ok"])
            self.assertIn("changed during simulation", envelope["payload"]["error"])
            self.assertIn("spec", envelope["payload"]["error"])
            # Reported provenance is still the pre-solve frozen hash, never
            # the rewritten file's.
            frozen_spec_hash = cli._freeze_simulation_inputs(str(spec_path), "validate")[0]["sha256"]
            self.assertNotEqual(envelope["inputHashes"]["spec"], frozen_spec_hash)

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
            envelope = run_cadctl(
                "simulate-flow", "run", "--spec", str(spec_path), "--output-dir", str(root / "out"), cwd=root,
            )
            self.assertTrue(envelope["ok"], envelope)
            payload = envelope["payload"]
            self.assertIn(payload["status"], {"solved", "not_converged"})
            # The declared viscosity is the one in the compiled cfg; nothing
            # defaulted to air anywhere in the pipeline.
            cfg = (root / "out" / "case.cfg").read_text(encoding="utf-8")
            self.assertIn("VISCOSITY_MODEL= CONSTANT_VISCOSITY", cfg)
            self.assertIn("MU_CONSTANT= 0.001", cfg)
            if payload["status"] == "solved":
                self.assertLess(payload["massBalance"]["relativeImbalance"], 0.05, payload["massBalance"])

    def test_mid_solve_artifact_mutation_discards_flow_result(self) -> None:
        import argparse
        import contextlib
        import io

        from cadctl import cli

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
                captured = io.StringIO()
                with contextlib.redirect_stdout(captured):
                    exit_code = cli._cmd_simulate_flow(
                        argparse.Namespace(spec=str(spec_path), output_dir=str(root / "out"), stage="run")
                    )
            finally:
                flow_api.run_su2 = original_run_su2
            self.assertEqual(exit_code, 0)
            envelope = json.loads(captured.getvalue())
            self.assertFalse(envelope["ok"])
            self.assertIn("changed during simulation", envelope["payload"]["error"])


if __name__ == "__main__":
    unittest.main()
