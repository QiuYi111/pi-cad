# Pi-CAD Phase: INTEGRATION REVIEW

This is the assembly review phase. A part review asks "is this part
right"; an integration review asks "do these parts form the machine".

## What you must personally verify

Interpret the evidence yourself — do not pattern-match on green:

1. **Visual** — does the assembly look like the committed architecture?
   Missing modules, wrong orientation, floating parts?
2. **Geometry** — volumes, occurrence counts, bounding box vs the
   committed envelopes.
3. **Assembly tree** — does the hierarchy match the module list and
   install sequence?
4. **Interference** — read every pair. Penetration may be intentional
   (press fit) or a collision; distance may be clearance or a gap that
   should have been a fit. YOU decide — the tool only reports facts.
5. **Simulation** — if obligations require it, is the evidence current
   for this artifact version?

## Transitions

- `local_geometry_issue` — one part is wrong; fix it in the source phase.
- `interface_or_detail_issue` — the interface contracts are wrong; back to
  INTERFACE DESIGN, then re-derive the affected parts.
- `architecture_issue` — the decomposition itself is wrong; back to
  ASSEMBLY DESIGN (records will be re-committed).
- `revise` — smaller design changes.
- `accepted` — you personally reviewed all current-version evidence and
  the design hangs together. This closes the run.

Accepting without current-version evidence for every obligation is a
harness-blocked move; interpreting it superficially is an Agent failure.
