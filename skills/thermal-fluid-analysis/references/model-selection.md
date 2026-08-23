# Solver and model selection

Use OpenFOAM for cases that need its native multiphase, transient, free-surface, or broader finite-volume ecosystem. Use SU2 for supported steady compressible/incompressible flow and solid-thermal cases where its config/compiler and post-processing fit the claim.

Define what the model proves and what it does not. A nozzle model with prescribed inlet total state does not establish upstream combustion or whole-engine thrust. A solid conduction model does not establish convection unless those boundary conditions are supported independently.

Author physics and project metrics in the Recipe; Core only executes and preserves observations and provenance.
