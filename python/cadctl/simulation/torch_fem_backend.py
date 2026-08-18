from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

from .base import DeviceInfo, SimulationBackend, SimulationBackendError
from .mesh import mesh_step_tetra, structured_tetra_box


def resolve_device(requested: str = "auto") -> DeviceInfo:
    import torch

    torch_cuda = bool(torch.cuda.is_available())
    mps_hardware = bool(
        getattr(getattr(torch.backends, "mps", None), "is_available", lambda: False)()
    )
    cupy = False
    try:
        import cupy  # noqa: F401

        cupy = True
    except Exception:
        cupy = False
    # torch-fem's GPU sparse solver requires CuPy. Do not advertise CUDA as
    # usable without it. MPS has no torch-fem sparse backend in 0.6: always
    # fall back to CPU explicitly.
    cuda_usable = torch_cuda and cupy
    actual = "cpu"
    fallback = None
    if requested == "auto":
        if cuda_usable:
            actual = "cuda"
        elif mps_hardware or torch_cuda:
            fallback = "cuda/cupy missing" if torch_cuda else "mps sparse backend unavailable"
        else:
            fallback = None
    elif requested == "cuda":
        if cuda_usable:
            actual = "cuda"
        else:
            fallback = "cuda requires cupy; cupy not installed" if torch_cuda else "cuda unavailable"
    elif requested == "mps":
        fallback = "torch-fem has no MPS sparse solver; explicit CPU fallback"
    # Float64 is the torch-fem recommended default for all Pi-CAD devices.
    return DeviceInfo(requested, actual, "float64", fallback, cuda_usable, cupy, mps_hardware)


def _select_nodes(nodes: np.ndarray, region: dict[str, Any], tolerance: float) -> np.ndarray:
    if "indices" in region:
        return np.asarray(region["indices"], dtype=int)
    axis = region.get("axis", "x")
    side = region.get("side", "min")
    coord = {"x": 0, "y": 1, "z": 2}[axis]
    values = nodes[:, coord]
    if side == "min":
        return np.flatnonzero(values <= values.min() + tolerance)
    return np.flatnonzero(values >= values.max() - tolerance)


def _parse_material(spec: dict[str, Any]) -> tuple[float, float]:
    materials = spec.get("materials") or []
    if not materials:
        raise SimulationBackendError("simulation spec requires at least one material")
    material = materials[0]
    E = float(material.get("E", material.get("youngs_modulus", 0)))
    nu = float(material.get("nu", material.get("poisson_ratio", 0)))
    if E <= 0 or not (0 <= nu < 0.5):
        raise SimulationBackendError("invalid linear elastic material constants")
    return E, nu


def _apply_regions(model: Any, nodes: np.ndarray, spec: dict[str, Any], mesh_size: float) -> None:
    import torch

    tol = max(float(spec.get("selectionTolerance", mesh_size * 0.75)), 1e-9)
    model.constraints[:] = False
    model.forces[:] = 0.0

    for constraint in spec.get("constraints") or []:
        if constraint.get("type") != "fixed":
            raise SimulationBackendError(
                f"constraint type {constraint.get('type')!r} is unsupported; V1 supports only fixed"
            )
        region = constraint.get("region") or constraint.get("nodes") or {}
        selected = _select_nodes(nodes, region, tol)
        if "indices" in region:
            selected = np.asarray(region["indices"], dtype=int)
        if len(selected) == 0:
            raise SimulationBackendError("constraint region selected no nodes")
        dofs = constraint.get("dofs", [0, 1, 2])
        if not isinstance(dofs, (list, tuple)) or any(int(d) not in (0, 1, 2) for d in dofs):
            raise SimulationBackendError("fixed constraint dofs must be a subset of [0,1,2]")
        model.constraints[selected, :] = False
        for dof in dofs:
            model.constraints[selected, int(dof)] = True

    for load in spec.get("loads") or []:
        if load.get("type") != "nodal_force":
            raise SimulationBackendError(
                f"load type {load.get('type')!r} is unsupported; V1 supports only nodal_force"
            )
        region = load.get("region") or load.get("nodes") or {}
        selected = _select_nodes(nodes, region, tol)
        if "indices" in region:
            selected = np.asarray(region["indices"], dtype=int)
        if len(selected) == 0:
            raise SimulationBackendError("load region selected no nodes")
        if load.get("vector") is None:
            raise SimulationBackendError("nodal_force requires vector")
        vector = np.asarray(load["vector"], dtype=np.float64)
        if vector.shape != (3,):
            raise SimulationBackendError("load.vector must be a 3-vector")
        if load.get("distribute", "total") == "total":
            vector = vector / len(selected)
        model.forces[selected, :] = torch.as_tensor(vector, dtype=model.nodes.dtype, device=model.nodes.device)


class TorchFemBackend(SimulationBackend):
    name = "torch-fem"

    def solve(self, spec: dict[str, Any], workdir: str | Path) -> dict[str, Any]:
        import torch

        from ._torchfem_import import import_torchfem

        import_torchfem()
        from torchfem.materials import IsotropicElasticity3D
        from torchfem.solid import Solid

        device_info = resolve_device(spec.get("device", "auto"))
        torch.set_default_dtype(torch.float64)

        artifact = spec.get("artifact")
        mesh_spec = spec.get("mesh") or {}
        mesh_size = float(mesh_spec.get("size", 2.0))
        if artifact and Path(artifact).suffix.lower() in (".step", ".stp"):
            mesh = mesh_step_tetra(artifact, mesh_size)
        elif artifact is None and mesh_spec.get("box"):
            box = [float(v) for v in mesh_spec["box"]]
            mesh = structured_tetra_box((box[0], box[1], box[2]), mesh_size)
        else:
            raise SimulationBackendError(
                "V1 torch-fem requires artifact (.step/.stp) or mesh.box for the walking skeleton"
            )

        nodes_np = np.asarray(mesh["nodes"], dtype=np.float64)
        elements_np = np.asarray(mesh["elements"], dtype=np.int64)
        E, nu = _parse_material(spec)

        nodes = torch.as_tensor(nodes_np, dtype=torch.get_default_dtype(), device="cpu")
        elements = torch.as_tensor(elements_np, dtype=torch.int64)
        material = IsotropicElasticity3D(E, nu, float((spec.get("materials") or [{}])[0].get("density", 1.0)))
        model = Solid(nodes, elements, material)
        _apply_regions(model, nodes_np, spec, mesh_size)

        u, f, sigma, epsilon, _state = model.solve(
            increments=torch.tensor([0.0, 1.0], dtype=nodes.dtype),
            device=device_info.actual,
            verbose=False,
        )

        displacement_mag = torch.linalg.norm(u, dim=1)
        # Flux tensor is [n_elem, 3, 3]; compute per-element von Mises and
        # expose both element and node-averaged scalar maxima.
        sigma_cpu = sigma.detach().cpu().to(torch.float64)
        dev = sigma_cpu - torch.eye(3, dtype=torch.float64) * torch.einsum("eii->e", sigma_cpu)[:, None, None] / 3.0
        von_mises_elem = torch.sqrt(1.5 * torch.einsum("eij,eij->e", dev, dev))
        if len(elements.shape) == 2:
            counts = torch.bincount(elements.reshape(-1), minlength=nodes.shape[0]).to(torch.float64)
            node_vm = torch.zeros(nodes.shape[0], dtype=torch.float64)
            for e in range(elements.shape[0]):
                node_vm[elements[e]] += von_mises_elem[e]
            node_vm = node_vm / counts.clamp_min(1)

        mesh_identity = json.dumps({"nodes": mesh["nodes"], "elements": mesh["elements"]}, sort_keys=True).encode("utf-8")
        mesh_hash = hashlib.sha256(mesh_identity).hexdigest()
        artifact_hash = None
        if artifact and Path(artifact).exists():
            artifact_hash = hashlib.sha256(Path(artifact).read_bytes()).hexdigest()

        visualization: dict[str, Any] = {"status": "unavailable", "views": []}
        try:
            from .visualization import render_simulation_views

            visual_dir = Path(workdir) / "visualization"
            visualization = render_simulation_views(
                nodes_np,
                elements_np,
                u.detach().cpu().numpy(),
                von_mises_elem.numpy(),
                visual_dir,
                field_name="vonMises",
            )
            visualization["status"] = "ready"
        except Exception as exc:
            visualization["reason"] = str(exc)

        max_disp = float(displacement_mag.detach().cpu().max().item())
        max_vm_elem = float(von_mises_elem.max().item())
        max_vm_node = float(node_vm.max().item())
        reaction = float(f[model.constraints].sum().item())

        result = {
            "units": "mm_N_MPa",
            "backend": self.name,
            "visualization": visualization,
            "artifactHash": artifact_hash,
            "requestedDevice": device_info.requested,
            "actualDevice": device_info.actual,
            "dtype": device_info.dtype,
            "fallbackReason": device_info.fallbackReason,
            "cudaAvailable": device_info.cudaAvailable,
            "cupyAvailable": device_info.cupyAvailable,
            "mpsAvailable": device_info.mpsAvailable,
            "torchVersion": torch.__version__,
            "torchFemVersion": __import__("importlib.metadata", fromlist=["version"]).version("torch-fem"),
            "mesh": {
                "hash": mesh_hash,
                "elementType": mesh.get("elementType"),
                "meshSize": mesh.get("meshSize"),
                "generator": mesh.get("generator"),
                "nodeCount": int(nodes_np.shape[0]),
                "elementCount": int(elements_np.shape[0]),
            },
            "displacement": {
                "maxMagnitude": max_disp,
                "maxAbsComponent": float(u.detach().cpu().abs().max().item()),
            },
            "stress": {
                "maxVonMisesElement": max_vm_elem,
                "maxVonMisesNode": max_vm_node,
            },
            "strain": {
                "maxMagnitude": float(torch.linalg.norm(epsilon.detach().cpu().to(torch.float64).reshape(-1, 3, 3), dim=(1, 2)).max().item()),
            },
            "reaction": {"sum": reaction},
            "solver": {
                "linear": "differentiable_sparse_solve",
                "device": device_info.actual,
                "dtype": device_info.dtype,
            },
            "interpretationPolicy": "raw deterministic fields only; safety and acceptance are Agent decisions",
        }
        fields_path = Path(workdir) / "simulation-fields.npz"
        fields_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            fields_path,
            displacement=u.detach().cpu().numpy(),
            stress=sigma_cpu.numpy(),
            strain=epsilon.detach().cpu().to(torch.float64).numpy(),
            reaction=f.detach().cpu().numpy(),
        )
        out_path = Path(workdir) / "simulation-result.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        result["fieldArtifacts"] = [str(fields_path)]
        out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        result["artifact"] = str(out_path)
        return result
