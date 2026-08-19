# Pi-CAD Phase: INTERFACE DESIGN

The assembly architecture is committed. Interfaces are where assemblies
fail: they are the contracts between modules, and they must be complete
before any part geometry is authored.

## What you owe this phase

One contract per module pair that touches (mates, fastens, locates, seals):

- **purpose** — what this interface is for (locate, drive, seal, ...).
- **locating** — which features on each side locate against which datum.
  Say the scheme explicitly (pin-in-hole, face-stop, piloted bolt...).
- **dof** — which of the six degrees of freedom the interface constrains,
  and which it deliberately leaves free.
- **fasteners** — type, size, count, torque class; or why none.
- **fits** — the fit class and tolerance at each locating feature.
- **assemblyDirection** — the approach direction parts must travel.
- **toolAccess** — how a wrench/driver/fixture reaches the fasteners.

## Rules

- Over-constraining is the classic error: two pins + face + bolt pattern
  fighting each other. State the DOF budget explicitly.
- Every contract must reference the assembly datums by name.
- Interfaces to bought-in parts (motor flange, bearing bore) are
  non-negotiable inputs — look them up, do not invent them.

## Exit

`cad_commit_interface_contracts` writes the record (an obligation at
engineering maturity and above) and enters PART DESIGN, where parts are
derived backwards from these contracts.
