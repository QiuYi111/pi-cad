# 0002. FreeCAD (`cad.part`) is the default modeling path

Status: accepted
Date: 2026-10-06 (decided); recorded 2026-10-09

## Context

The skill documentation says the default modeling path is FreeCAD, `cad.part`. `src/modules/model/backend.ts`
has `DEFAULT_MODEL_BACKEND = "build123d"`. This looked like a disagreement, but the two settings control different
things:

- `cad.part` is the Agent API path (`part-*` operations through `src/shared/freecad-worker.ts`). The skill sends the
  agent there first.
- `DEFAULT_MODEL_BACKEND` selects the backend of the `cad_build` tool, which builds a Python source file. The only
  registered backend is build123d. There is no FreeCAD `ModelBackend`.

## Decision

FreeCAD (`cad.part`) is the default modeling path for the agent. `cad_build` keeps build123d as its backend.
`DEFAULT_MODEL_BACKEND` does not change, because no FreeCAD backend exists for `cad_build`.

## Consequences

- No code change. Docs and code agree once the two settings are read as two different things.
- A FreeCAD `cad_build` backend (build from `.FCStd`, export STEP through the worker) would be new feature work.
  If it is built, a later ADR can switch `DEFAULT_MODEL_BACKEND`.
