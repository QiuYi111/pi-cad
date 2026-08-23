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
    keys = set(region or {})
    if keys == {"indices"}:
        selected = np.asarray(region["indices"], dtype=int)
        if selected.size == 0 or selected.min() < 0 or selected.max() >= len(nodes):
            raise SimulationBackendError("region.indices are empty or outside the mesh")
        return selected
    if keys != {"axis", "side"}:
        raise SimulationBackendError("region must contain either indices or exactly axis+side")
    if region["axis"] not in ("x", "y", "z"):
        raise SimulationBackendError("region.axis must be x, y, or z")
    if region["side"] not in ("min", "max"):
        raise SimulationBackendError("region.side must be min or max")
    coord = {"x": 0, "y": 1, "z": 2}[region["axis"]]
    values = nodes[:, coord]
    if region["side"] == "min":
        return np.flatnonzero(values <= values.min() + tolerance)
    return np.flatnonzero(values >= values.max() - tolerance)


def _parse_material(spec: dict[str, Any]) -> tuple[float, float]:
    materials = spec.get("materials") or []
    if not materials:
        raise SimulationBackendError("simulation spec requires at least one material")
    if len(materials) != 1:
        raise SimulationBackendError("V1 supports exactly one homogeneous material")
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
        model.forces[selected, :] += torch.as_tensor(vector, dtype=model.nodes.dtype, device=model.nodes.device)


class TorchFemBackend(SimulationBackend):
    name = "torch-fem"

    def solve(self, spec: dict[str, Any], workdir: str | Path) -> dict[str, Any]:
        import torch

        from ._torchfem_import import import_torchfem

        import_torchfem()
        from torchfem.materials import IsotropicElasticity3D
        from torchfem.solid import Solid

        device_info = resolve_device(spec.get("device", "auto"))
        if device_info.requested == "cuda" and device_info.actual != "cuda":
            raise SimulationBackendError(
                f"CUDA torch-fem runtime is unavailable ({device_info.fallbackReason or 'unknown reason'}); "
                "CPU fallback is forbidden — select the explicit CPU runtime instead"
            )
        torch.set_default_dtype(torch.float64)
        accelerator: dict[str, Any] = {
            "requestedDevice": device_info.requested,
            "actualDevice": device_info.actual,
            "torchVersion": torch.__version__,
            "torchCudaRuntime": torch.version.cuda,
            "cupyVersion": None,
            "cudaDriverVersion": None,
            "cupyCudaRuntime": None,
            "gpu": None,
            "vramBytes": None,
            "computeCapability": None,
        }
        if device_info.cupyAvailable:
            import cupy

            accelerator.update(
                cupyVersion=cupy.__version__,
                cudaDriverVersion=int(cupy.cuda.runtime.driverGetVersion()),
                cupyCudaRuntime=int(cupy.cuda.runtime.runtimeGetVersion()),
            )
        if device_info.actual == "cuda":
            properties = torch.cuda.get_device_properties(torch.cuda.current_device())
            accelerator.update(
                gpu=properties.name,
                vramBytes=int(properties.total_memory),
                computeCapability=f"{properties.major}.{properties.minor}",
            )

        artifact = spec.get("artifact")
        mesh_spec = spec.get("mesh") or {}
        mesh_size = float(mesh_spec.get("size", 2.0))
        # Bind the artifact version BEFORE meshing; the result is only valid if
        # the artifact is byte-identical after the solve (external mutation
        # would otherwise let the mesh come from version A while evidence binds
        # to version B).
        artifact_hash = None
        if artifact and Path(artifact).exists():
            artifact_hash = hashlib.sha256(Path(artifact).read_bytes()).hexdigest()
        if artifact and artifact_hash is None:
            raise SimulationBackendError(f"artifact does not exist: {artifact}")
        if artifact and Path(artifact).suffix.lower() in (".step", ".stp"):
            if mesh_spec.get("box"):
                raise SimulationBackendError(
                    "artifact and mesh.box are mutually exclusive in V1; the ignored one would "
                    "silently change the mesh source"
                )
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
        sensitivity_requested = (spec.get("sensitivity") or {}).get("type") == "compliance_by_youngs_modulus"
        youngs_modulus = torch.tensor(E, dtype=torch.float64, requires_grad=sensitivity_requested)
        material = IsotropicElasticity3D(youngs_modulus, nu, float((spec.get("materials") or [{}])[0].get("density", 1.0)))
        model = Solid(nodes, elements, material)
        _apply_regions(model, nodes_np, spec, mesh_size)

        u, internal_force, sigma, deformation_gradient, _state = model.solve(
            increments=torch.tensor([0.0, 1.0], dtype=nodes.dtype),
            device=device_info.actual,
            verbose=False,
            differentiable_parameters=[youngs_modulus] if sensitivity_requested else None,
        )
        sensitivity: dict[str, Any] | None = None
        if sensitivity_requested:
            compliance = (u * model.forces).sum()
            derivative = torch.autograd.grad(compliance, youngs_modulus)[0]
            sensitivity = {
                "type": "compliance_by_youngs_modulus",
                "compliance": float(compliance.detach().cpu()),
                "dCompliance_dE": float(derivative.detach().cpu()),
            }

        displacement_mag = torch.linalg.norm(u, dim=1)
        F_cpu = deformation_gradient.detach().cpu().to(torch.float64)
        identity = torch.eye(3, dtype=torch.float64)
        H = F_cpu - identity
        strain = 0.5 * (H + H.transpose(-1, -2))
        strain_magnitude = torch.sqrt(torch.einsum("eij,eij->e", strain, strain))
        internal_force_cpu = internal_force.detach().cpu().to(torch.float64)
        reaction_field = torch.where(
            model.constraints,
            internal_force_cpu,
            torch.zeros_like(internal_force_cpu),
        )
        reaction_vector = reaction_field.sum(dim=0)
        reaction_magnitude = float(torch.linalg.norm(reaction_vector).item())
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
        if artifact and artifact_hash is not None:
            after_hash = hashlib.sha256(Path(artifact).read_bytes()).hexdigest()
            if after_hash != artifact_hash:
                raise SimulationBackendError(
                    "artifact changed during simulation; discarding the result because the mesh "
                    "and the bound artifact version no longer match"
                )

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
            "accelerator": accelerator,
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
                "maxMagnitudeElement": float(strain_magnitude.max().item()),
            },
            "deformationGradient": {
                "maxDeviationFromIdentity": float(torch.linalg.norm(H, dim=(1, 2)).max().item()),
            },
            "reaction": {
                "vector": reaction_vector.tolist(),
                "magnitude": reaction_magnitude,
            },
            "solver": {
                "linear": "differentiable_sparse_solve",
                "device": device_info.actual,
                "dtype": device_info.dtype,
            },
            "interpretationPolicy": "raw deterministic fields only; safety and acceptance are Agent decisions",
        }
        if sensitivity is not None:
            sensitivity_path = Path(workdir) / "sensitivity.json"
            sensitivity_path.write_text(json.dumps(sensitivity, indent=2), encoding="utf-8")
            result["sensitivity"] = sensitivity
            result["sensitivityArtifacts"] = [str(sensitivity_path)]
        fields_path = Path(workdir) / "simulation-fields.npz"
        fields_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            fields_path,
            displacement=u.detach().cpu().numpy(),
            stress=sigma_cpu.numpy(),
            deformationGradient=F_cpu.numpy(),
            strain=strain.numpy(),
            internalForce=internal_force_cpu.numpy(),
            reaction=reaction_field.numpy(),
        )
        out_path = Path(workdir) / "simulation-result.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        result["fieldArtifacts"] = [str(fields_path)]
        out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        result["artifact"] = str(out_path)
        return result
