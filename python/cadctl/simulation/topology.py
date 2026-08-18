from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from ._torchfem_import import import_torchfem


def _device_torch():
    import torch

    return torch


def run_topology(spec: dict[str, Any], workdir: str | Path) -> dict[str, Any]:
    """Differentiable SIMP topology optimization on a fixed FE-native density field.

    The optimizer is the deterministic NLopt MMA inner loop. No LLM is called.
    The result is a density/surface field only; it never updates Project Head.
    """
    import nlopt
    import torch

    torch.set_default_dtype(torch.float64)
    torchfem = import_torchfem()
    from torchfem.materials import IsotropicElasticityPlaneStress
    from torchfem.mesh import rect_tri
    from torchfem.planar import Planar

    domain = spec.get("designDomain") or {}
    x_domain = domain.get("x", [0, 60])
    y_domain = domain.get("y", [0, 20])
    x_domain = [float(x_domain[0]), float(x_domain[1])] if isinstance(x_domain, (list, tuple)) else [0.0, float(x_domain)]
    y_domain = [float(y_domain[0]), float(y_domain[1])] if isinstance(y_domain, (list, tuple)) else [0.0, float(y_domain)]
    lx = x_domain[1] - x_domain[0]
    ly = y_domain[1] - y_domain[0]
    nx = int(domain.get("nx", 48))
    ny = int(domain.get("ny", 16))
    nodes, elements = rect_tri(nx, ny, lx, ly, variant="zigzag")
    nodes = nodes.to(torch.float64)
    nodes[:, 0] += x_domain[0]
    nodes[:, 1] += y_domain[0]
    elements = elements.to(torch.int64)
    n_elem = elements.shape[0]

    E0 = float((spec.get("material") or {}).get("E", 1.0))
    nu = float((spec.get("material") or {}).get("nu", 0.3))
    penalty = float((spec.get("optimizer") or {}).get("penalty", 3.0))
    max_iter = int((spec.get("optimizer") or {}).get("maxIterations", 100))
    volfrac = float((spec.get("constraints") or [{}])[0].get("max", 0.4))
    Emin = float((spec.get("optimizer") or {}).get("Emin", 1e-6))

    x = torch.full((n_elem,), volfrac, dtype=torch.float64, requires_grad=True)

    def assemble(x_np: np.ndarray):
        xt = torch.tensor(x_np, dtype=torch.float64, requires_grad=True)
        E = Emin + (E0 - Emin) * xt**penalty
        material = IsotropicElasticityPlaneStress(E, nu)
        model = Planar(nodes, elements, material, thickness=1.0)
        model.constraints[:] = False
        model.forces[:] = 0.0

        min_x = nodes[:, 0].min()
        min_y = nodes[:, 1].min()
        max_x = nodes[:, 0].max()
        max_y = nodes[:, 1].max()
        tol = min(lx, ly) / max(nx, ny) * 0.75
        left = torch.nonzero(nodes[:, 0] <= min_x + tol, as_tuple=False).ravel()
        model.constraints[left, 0] = True
        bottom_right = torch.nonzero((nodes[:, 0] >= max_x - tol) & (nodes[:, 1] <= min_y + tol), as_tuple=False).ravel()
        model.constraints[bottom_right, 1] = True
        top_left = torch.nonzero((nodes[:, 0] <= min_x + tol) & (nodes[:, 1] >= max_y - tol), as_tuple=False).ravel()
        model.forces[top_left, 1] = -1.0 / max(len(top_left), 1)

        u, *_ = model.solve(
            increments=torch.tensor([0.0, 1.0], dtype=torch.float64),
            differentiable_parameters=[xt],
        )
        compliance = (u * model.forces).sum()
        return compliance, xt

    objective_history: list[float] = []
    constraint_history: list[float] = []
    last_grad: np.ndarray | None = None

    def objective(x_np: np.ndarray, grad: np.ndarray) -> float:
        nonlocal last_grad
        compliance, xt = assemble(x_np)
        compliance.backward()
        g = xt.grad.detach().cpu().numpy().astype(np.float64)
        if grad.size > 0:
            grad[:] = g
        last_grad = g.copy()
        value = float(compliance.detach().cpu().item())
        objective_history.append(value)
        return value

    def constraint(x_np: np.ndarray, grad: np.ndarray) -> float:
        if grad.size > 0:
            grad[:] = 1.0 / (x_np.size * volfrac)
        value = float(np.mean(x_np) / volfrac - 1.0)
        constraint_history.append(value)
        return value

    opt = nlopt.opt(nlopt.LD_MMA, x.numel())
    opt.set_lower_bounds(0.01)
    opt.set_upper_bounds(1.0)
    opt.set_min_objective(objective)
    opt.add_inequality_constraint(constraint, 1e-6)
    opt.set_xtol_rel(1e-4)
    opt.set_maxeval(max_iter)
    x_opt = opt.optimize(x.detach().cpu().numpy().copy())

    density = x_opt.tolist()
    surface_mesh = {
        "nodes": nodes.detach().cpu().numpy().tolist(),
        "elements": elements.detach().cpu().numpy().astype(int).tolist(),
        "density": density,
    }
    result = {
        "mode": "topology_2d_rect_v0",
        "backend": "torch-fem + nlopt MMA",
        "optimizer": {"type": "mma", "maxIterations": max_iter},
        "objective": spec.get("objective", {"type": "compliance", "sense": "minimize"}),
        "constraints": spec.get("constraints"),
        "iterations": len(objective_history),
        "objectiveHistory": objective_history,
        "constraintHistory": constraint_history,
        "bestObjective": min(objective_history) if objective_history else None,
        "finalVolumeFraction": float(np.mean(x_opt)),
        "densityField": density,
        "surfaceMesh": surface_mesh,
        "gradientField": last_grad.tolist() if last_grad is not None else None,
        "policy": "density field only; it is not a CAD candidate and does not update Project Head",
    }
    out_path = Path(workdir) / "optimization-result.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    result["artifact"] = str(out_path)
    return result
