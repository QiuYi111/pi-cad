# Structural model definition

Record the authoritative model or verified analysis derivation, material law and units, loads, constraints, mesh controls, and every simplification. Constraints should remove only physical rigid-body modes; an over-constrained model can look stiff and plausible while producing false reactions.

Apply distributed loads over physical regions when appropriate. Check resultant force and moment against the intended load case. Resolve geometric surface identifiers with `cad_probe` before assigning engineering meaning.

Use the managed CUDA runtime for production. A Recipe requesting CUDA must fail unavailable if the GPU, driver, CuPy, architecture, or sparse solve probe is invalid; never reroute it to CPU.
