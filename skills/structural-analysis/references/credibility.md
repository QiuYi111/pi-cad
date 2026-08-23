# Structural credibility

Before interpreting fields, verify solver health, actual accelerator, mesh quality, reaction balance, and load/result units. Compare total reactions with applied force and moment.

Perform mesh refinement on the quantity that supports the claim. Peak stress at a point load, sharp re-entrant corner, or ideal fixed edge may be singular; report a physically meaningful averaged or remote measure and explain the limitation.

For differentiable results, compare autograd sensitivity with a finite-difference perturbation at a meaningful step. GPU and CPU qualification may compare numerically, but Evidence remains bound to different runtime identities.
