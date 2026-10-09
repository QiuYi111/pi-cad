# 0002. FreeCAD (`cad.part`) is the default modeling backend

Status: accepted
Date: 2026-10-06 (decided); recorded 2026-10-09

## Context

The skill documentation says the default path is FreeCAD, `cad.part`. The code default in
`src/modules/model/backend.ts` (`DEFAULT_MODEL_BACKEND`) is still `build123d`. Docs and code disagree, and the
agent gets the default from code.

## Decision

FreeCAD (`cad.part`) is the default modeling backend. build123d stays registered and selectable by id, and nothing that
uses it explicitly changes.

## Consequences

- `DEFAULT_MODEL_BACKEND` changes to `cad.part` so code matches the docs. This is a P0 change, pending at the time
  of this record.
- Tests that assume the default must name their backend, or run against FreeCAD. build123d tests keep running on their
  explicit id.
- The FreeCAD runtime becomes a requirement for the default path.
