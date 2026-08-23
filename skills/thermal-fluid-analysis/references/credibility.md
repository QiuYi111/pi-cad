# Thermal-fluid credibility

Check residual behavior together with physical balances. For flow, verify mass imbalance and boundary flux direction. For thermal cases, verify total heat input and output. For transient or multiphase work, check timestep/Courant control and conservation over time.

Refine mesh and timestep around the quantity supporting acceptance. Confirm that boundary placement and domain extent do not dominate the result. Separate numerical convergence from engineering validity.

Use the images-first Observation to inspect fields and geometry, then quantitative exports and health. A successful run may still be an engineering failure and can be committed for audit; interrupted or provenance-invalid runs cannot.
