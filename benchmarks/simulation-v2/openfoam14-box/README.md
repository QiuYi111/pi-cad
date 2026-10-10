# OpenFOAM 14 Simulation V2 qualification

This Recipe is the runtime-backed integration gate for the generic Simulation
V2 protocol. It runs three 3D bottom-inlet/top-outlet meshes plus an independent
closed-gas-bubble retention case. The observer emits an interface image/GIF,
fill history, refinement table, and a machine-readable qualification report.

Run it through `cad_simulate` with `backend=openfoam` and
`runtime=openfoam-14`. Unit CI uses a stub runner; environments with the pinned
runtime use this Recipe as the integration gate.

The checked-in `qualification-baseline/` was produced by
`openfoam14@20260724` with runtime identity
`93f30dfb9419db47b74c31eeecb28999c3427784daa9f37d7532ee28e4c951b3`.

The qualification script (`npm run test:openfoam14`) was removed with the v6
kernel. The checks it ran (host mounts, inherited secrets, and DNS/network access
unavailable inside bubblewrap, plus the temporary-project lifecycle) are no longer
run by a repository script; re-establish them against the v7 simulation runtime
before relying on this baseline.
