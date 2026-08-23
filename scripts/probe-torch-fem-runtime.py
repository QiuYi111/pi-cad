from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json

import torch


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require", choices=("cuda", "cpu"), required=True)
    args = parser.parse_args()
    payload: dict[str, object] = {
        "torch-fem": importlib.metadata.version("torch-fem"),
        "torch": torch.__version__,
        "torchCudaRuntime": torch.version.cuda,
        "cudaAvailable": torch.cuda.is_available(),
        "cupy": "absent",
        "requestedDevice": args.require,
        "actualDevice": "cpu",
    }
    if args.require == "cuda":
        import cupy as cp
        from cupyx.scipy.sparse import csr_matrix
        from cupyx.scipy.sparse.linalg import spsolve

        if not torch.cuda.is_available():
            raise SystemExit("CUDA runtime requires torch.cuda.is_available(); CPU fallback is forbidden")
        matrix = csr_matrix(cp.asarray([[4.0, 1.0], [1.0, 3.0]]))
        solution = spsolve(matrix, cp.asarray([1.0, 2.0]))
        cp.cuda.Stream.null.synchronize()
        if not bool(cp.all(cp.isfinite(solution))):
            raise SystemExit("CUDA sparse qualification returned non-finite values")
        device = cp.cuda.Device()
        properties = cp.cuda.runtime.getDeviceProperties(device.id)
        payload.update({
            "cupy": importlib.metadata.version("cupy-cuda12x"),
            "actualDevice": "cuda",
            "gpu": properties["name"].decode() if isinstance(properties["name"], bytes) else properties["name"],
            "computeCapability": f"{properties['major']}.{properties['minor']}",
            "vramBytes": int(properties["totalGlobalMem"]),
            "cudaDriverVersion": int(cp.cuda.runtime.driverGetVersion()),
            "cudaRuntimeVersion": int(cp.cuda.runtime.runtimeGetVersion()),
            "cudaLocalRuntimeVersion": int(cp.cuda.get_local_runtime_version()),
            "sparseProbe": solution.get().tolist(),
        })
    else:
        if "+cpu" not in torch.__version__ or importlib.util.find_spec("cupy") is not None:
            raise SystemExit("CPU runtime must contain CPU PyTorch and no CuPy")
        if torch.cuda.is_available():
            raise SystemExit("CPU runtime must not expose a CUDA-enabled PyTorch build")
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
