# Architecture decision records

An ADR records one decision that changes how the repo is built, tested or structured, and why. Each one is short.

## Format

- File name: `NNNN-short-title.md`, numbered in order. Numbers are never reused.
- Header: `Status` (proposed, accepted, superseded by NNNN), `Date`.
- Sections:
  - **Context**: the forces and facts that made a decision necessary.
  - **Decision**: what we do, stated in one or two paragraphs.
  - **Consequences**: what gets easier, what gets harder, and what must follow.
- To change a decision, add a new ADR and mark the old one superseded. Do not rewrite history.

## Index

| No. | Title | Status |
| --- | --- | --- |
| [0001](0001-remove-v6-kernel.md) | Remove the v6 kernel | accepted |
| [0002](0002-freecad-default-backend.md) | FreeCAD (`cad.part`) is the default modeling path | accepted |
| [0003](0003-test-layering.md) | Test layering: PR runs touched areas, nightly runs the rest | accepted |
