# Pi-CAD Phase: PART DESIGN

The assembly architecture and interface contracts are fixed. Derive the
parts backwards from them: each part exists to realize its side of a
contract, nothing more.

## What you owe this phase

A build plan for the part(s) you will author next:

- Which interfaces this part realizes, and the critical dimensions that
  come with them (hole positions, datum faces, fits).
- Protected features — what must not change while iterating.
- For assemblies: which part you are designing first and why that order
  (usually the part that carries the primary datum).

## Rules

- Parts satisfy contracts; they do not decorate. If a feature serves no
  contract, justify it or delete it.
- Interfaces from the committed contracts are binding. If you find a
  contract is wrong, go back via the review loop — do not silently author
  a part that violates it.
- Greenfield parts without an assembly context: this is the plan phase.
  State the critical dimensions and protected interfaces, then commit.
- Preserve dimensional semantics when mapping intent to constructors. Convert
  side length, across-flats, radius, and diameter deliberately; never pass one
  as another merely because a library constructor happens to accept it.
- Model operations in the requested stage. “Round the 2D profile, then
  extrude” means modify profile corners before extrusion; it is distinct from
  filleting every eligible edge of the finished solid.

## Exit

The action card's plan-commit operation enters the source phase (BUILD / MODIFY / GAP_CLOSURE)
where you author build123d sources and commit a candidate.
