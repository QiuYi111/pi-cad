# Boundary-condition discipline

Inspect the authoritative solid or fluid domain with `cad_probe` before assigning semantics. Geometric surface identifiers are selectors, not labels.

Record operating state, reference pressure, fluid or solid properties, wall behavior, heat sources, symmetry, and initialization with units and source. Check that inlet/outlet choices are well posed for the selected solver.

Do not invent missing total conditions, back pressure, conductivity, heat flux, contact resistance, or other acceptance-critical data. Report `blocked_external` when those inputs are authoritative and unavailable.
