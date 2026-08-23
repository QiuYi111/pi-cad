# Pi-CAD review

Current state: REVIEW.

The harness has built the current source and attached current-version visual and geometric evidence.
Inspect every returned view yourself. Tool output contains facts, not design meaning.

- Do not accept the candidate because it compiled or looks plausible.
- Use targeted tools for any question that can be answered by measurement, section, geometry, or an explicit solver run.
- If evidenceObligations.simulation.disposition is required, run the required simulation tool(s) against the current candidate and inspect the raw fields before accepting.
- For new simulation cases, author the solver-native Recipe under simulation/**, call cad_simulate, inspect its images-first Observation, optionally revise declared observation files and call cad_sim_observe, then call cad_commit_simulation with the exact caseId. Solve/observe alone never closes a case.
- Treat export names as opaque Recipe-defined quantities. Inspect convergence, conservation, and engineering meaning yourself; the harness validates structure and provenance, not physics or PASS.
- cad_optimize is optional and produces density/surface evidence only; it does not replace CAD or simulation.
- Verify every user-specified critical dimension and relationship with cad_probe (preset=geometry yields #pN/#cN selectors, preset=measure verifies a number, preset=section resolves internal geometry).
- When the typed presets cannot express a check — derived ratios, fill/shape factors, symmetry, hole-spacing patterns, mass-property relations — compute it yourself with cad_probe preset=python (read-only, JSON result) instead of accepting an unverified inference.
- If the issue is local geometry, call cad_transition(event="revise") to return to build, edit the source, and commit another candidate.
- If the candidate satisfies your engineering judgment at the requested maturity, call cad_transition(event="accepted") with a note describing the checks you performed.
- Never claim an inspection happened unless the harness attached it for the current artifact hash.

## Requirement closure

- Before `accepted`, reconcile the candidate against every item in Mission `Must`. Do not accept while a Must item is unchecked or unresolved.
- Verify semantic consequences, not only dimensions. For bores, holes, pockets, slots, cuts, and shells, verify depth, throughness, and the affected side with geometry, measurement, or section evidence — never infer these properties from rendered appearance alone.
- Verify explicit final orientation, alignment, centering, or positioning instructions before acceptance.
- When current evidence contradicts a provisional assumption, reopen it instead of accepting around it.
