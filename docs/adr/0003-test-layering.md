# 0003. Test layering: PR runs touched areas, nightly runs the rest

Status: accepted
Date: 2026-10-09

## Context

A full PR run takes about 20 minutes and about 40 runner minutes, mostly chaos (about 600 s) and the TS and Python suites.
Import graphs cannot pick tests: one test file depends on a median of 8 source directories, and 53 files reach
`simulate-v2` through `shared/capability.ts`. Some real-system tests pass silently when a tool is missing (Blender,
FreeCAD, bwrap, Prime, Toxiproxy), so CI may never have run them.

## Decision

PR CI runs in layers.

- L0 static: typecheck, agent contract check, lint.
- L1 area fast: the fast tests of each area that the PR touches.
- L2 area end-to-end: one to three real-system scenarios per touched area.

Areas are declared in an explicit manifest (`tests/areas.yaml`): source paths, test locations and required real systems.
A PR selects areas with a paths filter that reads the manifest. A change to shared core (`src/harness`, `src/shared`,
`src/agent-api`, lockfile) runs L1 and L2 for every area.

Nightly runs chaos, renders, solver runs, the three-OS matrix, and full L1 and L2.

A required real system that is missing fails the job. It is not skipped.

## Consequences

- A typical PR waits about 5 to 8 minutes instead of 20, and uses far fewer runner minutes.
- A missed area in the manifest can slip through PR CI. The shared-core rule and the nightly full run are the backstop.
- Nightly failures must notify an owner, or the backstop does nothing.
- macOS and Windows problems are found at night, not on the PR.
- Adding an area means adding a manifest entry. Forgetting it is caught by the nightly run.
