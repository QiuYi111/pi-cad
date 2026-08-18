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
    site = ROOT / ".python" / "site-packages"
    entries = [str(ROOT / "python")]
    if site.exists():
        entries.append(str(site))
    if env.get("PYTHONPATH"):
        entries.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(entries)
    return env


def run_cadctl(*args: str, cwd: Path) -> dict:
    proc = subprocess.run(
        [sys.executable, "-m", "cadctl", *args],
        cwd=cwd,
        env=cadctl_env(),
        capture_output=True,
        text=True,
        timeout=240,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr)
    return json.loads(proc.stdout)


class SimulationTests(unittest.TestCase):
    def test_doctor_reports_torch_fem_and_optimization(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            envelope = run_cadctl("doctor", "--json", cwd=Path(tmp))
            self.assertIn("simulation", envelope["capabilities"])
            self.assertEqual(envelope["capabilities"]["simulation"]["backend"], "torch-fem")
            self.assertEqual(envelope["capabilities"]["differentiableOptimization"]["status"], "ready")

    def test_beam_simulation_walking_skeleton(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spec = root / "beam.json"
            spec.write_text(
                json.dumps(
                    {
                        "backend": "torch-fem",
                        "device": "auto",
                        "physics": {"type": "linear_elasticity"},
                        "mesh": {"element": "tet", "box": [100, 10, 10], "size": 5.0},
                        "materials": [{"name": "steel", "E": 210000.0, "nu": 0.3}],
                        "constraints": [{"type": "fixed", "region": {"axis": "x", "side": "min"}}],
                        "loads": [{"type": "nodal_force", "region": {"axis": "x", "side": "max"}, "vector": [0, 0, -100.0]}],
                    }
                ),
                encoding="utf-8",
            )
            envelope = run_cadctl("simulate", "run", "--spec", str(spec), "--output-dir", str(root / "out"), cwd=root)
            self.assertTrue(envelope["ok"], envelope)
            payload = envelope["payload"]
            self.assertEqual(payload["backend"], "torch-fem")
            self.assertGreater(payload["displacement"]["maxMagnitude"], 0.0)
            self.assertGreater(payload["mesh"]["elementCount"], 0)
            self.assertLess(abs(payload["reaction"]["magnitude"] - 100.0) / 100.0, 0.02)
            self.assertTrue((root / "out" / "simulation-result.json").exists())
            self.assertTrue((root / "out" / "simulation-fields.npz").exists())
            self.assertEqual(payload["visualization"]["status"], "ready")
            self.assertEqual(len(payload["visualization"]["views"]), 7)

    def test_topology_optimization_walking_skeleton(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spec = root / "mbb.json"
            spec.write_text(
                json.dumps(
                    {
                        "mode": "topology",
                        "designDomain": {"x": [0, 60], "y": [0, 20], "nx": 12, "ny": 4},
                        "material": {"E": 1.0, "nu": 0.3},
                        "objective": {"type": "compliance", "sense": "minimize"},
                        "constraints": [{"type": "volume_fraction", "max": 0.5}],
                        "optimizer": {"type": "mma", "maxIterations": 10, "penalty": 3.0, "Emin": 1e-3},
                    }
                ),
                encoding="utf-8",
            )
            envelope = run_cadctl("optimize", "--spec", str(spec), "--output-dir", str(root / "out"), cwd=root)
            self.assertTrue(envelope["ok"], envelope)
            payload = envelope["payload"]
            self.assertGreater(payload["iterations"], 0)
            self.assertLess(abs(payload["finalVolumeFraction"] - 0.5), 0.03)
            self.assertTrue((root / "out" / "optimization-result.json").exists())


    def test_gmsh_meshes_step_artifact(self) -> None:
        from cadctl.model import run_source
        from cadctl.simulation.mesh import mesh_step_tetra

        with tempfile.TemporaryDirectory() as tmp:
            step = Path(tmp) / "plate.step"
            result = run_source(str(ROOT / "tests" / "fixtures" / "plate.py"), step)
            self.assertEqual(result.get("exitCode"), 0)
            mesh = mesh_step_tetra(step, 10.0)
            self.assertGreater(len(mesh["nodes"]), 0)
            self.assertGreater(len(mesh["elements"]), 0)
            self.assertEqual(mesh["elementType"], "tet")

    def test_topology_gradient_finite_difference_spot_check(self) -> None:
        from cadctl.simulation._torchfem_import import import_torchfem

        import_torchfem()
        import torch
        from torchfem.materials import IsotropicElasticityPlaneStress
        from torchfem.mesh import rect_tri
        from torchfem.planar import Planar
        torch.set_default_dtype(torch.float64)
        nodes, elements = rect_tri(6, 2, 10, 4, variant="zigzag")
        nodes = nodes.double()
        elements = elements.long()

        def compliance(rho: torch.Tensor) -> torch.Tensor:
            model = Planar(
                nodes,
                elements,
                IsotropicElasticityPlaneStress(1e-3 + rho**3, 0.3),
                1.0,
            )
            model.constraints[:] = False
            model.forces[:] = 0.0
            model.constraints[nodes[:, 0] <= nodes[:, 0].min() + 0.1, 0] = True
            model.constraints[
                (nodes[:, 0] >= nodes[:, 0].max() - 0.1)
                & (nodes[:, 1] <= nodes[:, 1].min() + 0.1),
                1,
            ] = True
            top = nodes[:, 0] <= nodes[:, 0].min() + 0.1
            model.forces[top, 1] = -1.0 / top.sum()
            u, *_ = model.solve(
                increments=torch.tensor([0.0, 1.0], dtype=torch.float64),
                differentiable_parameters=[rho],
            )
            return (u * model.forces).sum()

        rho = torch.full((elements.shape[0],), 0.5, dtype=torch.float64, requires_grad=True)
        value = compliance(rho)
        value.backward()
        analytical = rho.grad[0].item()
        eps = 1e-5
        rp = rho.detach().clone()
        rp[0] += eps
        rm = rho.detach().clone()
        rm[0] -= eps
        finite = (compliance(rp).item() - compliance(rm).item()) / (2 * eps)
        self.assertLess(abs(analytical - finite) / max(abs(analytical), abs(finite)), 1e-5)


def run_backend(spec: dict, tmp: Path) -> dict:
    from cadctl.simulation.api import run_simulation

    spec_path = tmp / "spec.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    payload = run_simulation(str(spec_path), str(tmp), stage="run")
    assert payload.get("status") == "solved", payload
    return payload


def beam_spec(size: float, *, loads: list[dict], constraints: list[dict]) -> dict:
    return {
        "backend": "torch-fem",
        "device": "auto",
        "physics": {"type": "linear_elasticity"},
        "mesh": {"element": "tet", "box": [100, 10, 10], "size": size},
        "materials": [{"name": "steel", "E": 210000.0, "nu": 0.3}],
        "constraints": constraints,
        "loads": loads,
    }


FACE_MIN = {"axis": "x", "side": "min"}
FACE_MAX = {"axis": "x", "side": "max"}


class SimulationSemanticsTests(unittest.TestCase):
    def test_validate_spec_fails_closed_on_unknown_semantics(self) -> None:
        from cadctl.simulation.api import validate_spec

        def expect_error(spec: dict, fragment: str) -> None:
            ok, errors = validate_spec(spec)
            self.assertFalse(ok, errors)
            self.assertTrue(any(fragment in e for e in errors), (fragment, errors))

        base = {
            "physics": {"type": "linear_elasticity"},
            "mesh": {"element": "tet", "box": [100, 10, 10], "size": 5.0},
            "materials": [{"name": "steel", "E": 210000.0, "nu": 0.3}],
            "constraints": [{"type": "fixed", "region": FACE_MIN}],
            "loads": [{"type": "nodal_force", "region": FACE_MAX, "vector": [0, 0, -100.0]}],
        }
        ok, _ = validate_spec(base)
        self.assertTrue(ok)

        import copy

        def mutate(**kwargs):
            spec = copy.deepcopy(base)
            spec.update(kwargs)
            return spec

        expect_error(mutate(backend="calculix"), "backend must be torch-fem")
        expect_error(mutate(device="gpu"), "device must be one of")
        expect_error(mutate(materials=[{"E": 210000.0, "nu": 0.3}, {"E": 70000.0, "nu": 0.33}]), "exactly one homogeneous material")
        expect_error(mutate(materials=[{"E": -1.0, "nu": 0.3}]), "E > 0")
        expect_error(mutate(materials=[{"E": 210000.0, "nu": 0.5}]), "nu < 0.5")
        expect_error(mutate(mesh={"element": "tet", "box": [100, 10, 10], "size": 0.0}), "mesh.size must be > 0")
        expect_error(mutate(mesh={"element": "hex", "box": [100, 10, 10], "size": 5.0}), "mesh.element must be tet")

        spec = copy.deepcopy(base)
        spec["loads"][0]["type"] = "pressure"
        expect_error(spec, "nodal_force")

        spec = copy.deepcopy(base)
        del spec["loads"][0]["region"]
        expect_error(spec, "region is required")

        spec = copy.deepcopy(base)
        spec["loads"][0]["region"] = {"axis": "x", "side": "minimum"}
        expect_error(spec, "side must be min or max")

        spec = copy.deepcopy(base)
        spec["loads"][0]["region"] = {"axis": "x", "side": "min", "indices": [0, 1]}
        expect_error(spec, "either indices or exactly axis+side")

        spec = copy.deepcopy(base)
        spec["loads"][0]["region"] = {}
        expect_error(spec, "either indices or exactly axis+side")

        spec = copy.deepcopy(base)
        spec["constraints"][0]["dofs"] = [3]
        expect_error(spec, "dofs must be a non-empty subset")

        spec = copy.deepcopy(base)
        spec["constraints"][0]["type"] = "roller"
        expect_error(spec, "type must be fixed")

        spec = copy.deepcopy(base)
        spec["artifact"] = "does-not-exist.step"
        expect_error(spec, "artifact does not exist")

    def test_overlapping_loads_add(self) -> None:
        single = beam_spec(
            6.0,
            loads=[{"type": "nodal_force", "region": FACE_MAX, "vector": [0, 0, -100.0]}],
            constraints=[{"type": "fixed", "region": FACE_MIN}],
        )
        split = beam_spec(
            6.0,
            loads=[
                {"type": "nodal_force", "region": FACE_MAX, "vector": [0, 0, -60.0]},
                {"type": "nodal_force", "region": FACE_MAX, "vector": [0, 0, -40.0]},
            ],
            constraints=[{"type": "fixed", "region": FACE_MIN}],
        )
        with tempfile.TemporaryDirectory() as tmp_a, tempfile.TemporaryDirectory() as tmp_b:
            a = run_backend(single, Path(tmp_a))
            b = run_backend(split, Path(tmp_b))
        self.assertAlmostEqual(
            a["displacement"]["maxMagnitude"],
            b["displacement"]["maxMagnitude"],
            delta=1e-9 * max(1.0, a["displacement"]["maxMagnitude"]),
        )

    def test_overlapping_constraints_union(self) -> None:
        full = beam_spec(
            6.0,
            loads=[{"type": "nodal_force", "region": FACE_MAX, "vector": [0, 0, -100.0]}],
            constraints=[{"type": "fixed", "region": FACE_MIN, "dofs": [0, 1, 2]}],
        )
        overlapped = beam_spec(
            6.0,
            loads=[{"type": "nodal_force", "region": FACE_MAX, "vector": [0, 0, -100.0]}],
            constraints=[
                {"type": "fixed", "region": FACE_MIN, "dofs": [0, 1, 2]},
                {"type": "fixed", "region": FACE_MIN, "dofs": [0]},
            ],
        )
        with tempfile.TemporaryDirectory() as tmp_a, tempfile.TemporaryDirectory() as tmp_b:
            a = run_backend(full, Path(tmp_a))
            b = run_backend(overlapped, Path(tmp_b))
        self.assertAlmostEqual(
            a["displacement"]["maxMagnitude"],
            b["displacement"]["maxMagnitude"],
            delta=1e-9 * max(1.0, a["displacement"]["maxMagnitude"]),
        )

    def test_cantilever_converges_toward_beam_theory(self) -> None:
        # delta = F L^3 / (3 E I), I = b h^3 / 12 with b = h = 10 mm.
        analytic = 100.0 * 100.0**3 / (3.0 * 210000.0 * (10.0 * 10.0**3 / 12.0))
        results = {}
        for size in (6.0, 4.0, 3.0):
            spec = beam_spec(
                size,
                loads=[{"type": "nodal_force", "region": FACE_MAX, "vector": [0, 0, -100.0]}],
                constraints=[{"type": "fixed", "region": FACE_MIN}],
            )
            with tempfile.TemporaryDirectory() as tmp:
                results[size] = run_backend(spec, Path(tmp))
        coarse = results[6.0]["displacement"]["maxMagnitude"]
        medium = results[4.0]["displacement"]["maxMagnitude"]
        fine = results[3.0]["displacement"]["maxMagnitude"]
        # Linear tets are overly stiff: displacement grows monotonically toward
        # the analytic value under refinement, and reaction equilibrium holds.
        self.assertLess(coarse, medium)
        self.assertLess(medium, fine)
        self.assertLess(abs(medium - analytic), abs(coarse - analytic))
        self.assertLess(abs(fine - analytic) / analytic, 0.20)
        self.assertLess(results[3.0]["reaction"]["magnitude"] / 100.0 - 1.0, 0.02)
        self.assertGreater(results[3.0]["strain"]["maxMagnitudeElement"], 0.0)


if __name__ == "__main__":
    unittest.main()
