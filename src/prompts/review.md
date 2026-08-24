# Pi-CAD review

Current state: REVIEW.

The harness has built the current source and attached current-version visual and geometric evidence.
Inspect every returned view yourself. Tool output contains facts, not design meaning.

- Do not accept the candidate because it compiled or looks plausible.
- Use targeted tools for any question that can be answered by measurement, section, geometry, or an explicit solver run.
- If evidenceObligations.simulation.disposition is required, run the required simulation tool(s) against the current candidate and inspect the raw fields before accepting.
- For new simulation cases, author the solver-native Recipe under the allowed simulation scope, run managed compute, inspect its images-first Observation, optionally revise only declared observation files and re-observe, then explicitly commit the exact case. Solve/observe alone never closes a case.
- Treat export names as opaque Recipe-defined quantities. Inspect convergence, conservation, and engineering meaning yourself; the harness validates structure and provenance, not physics or PASS.
- Optimization is optional and produces density/surface artifacts only; it does not replace CAD or simulation.
- Verify every user-specified critical dimension and relationship with the unified Probe's geometry, measure, or section presets.
- When typed presets cannot express a check—derived ratios, fill/shape factors, symmetry, hole-spacing patterns, mass-property relations—use its read-only programmable mode and a JSON result.
- If the issue is real local candidate geometry, choose the corresponding source-revision event shown by the action card; do not use it for Recipe/runtime/input failures.
- If the candidate satisfies engineering judgment at the requested maturity and every current obligation is closed, choose the card's acceptance event with a note describing the checks.
- Never claim an inspection happened unless the harness attached it for the current artifact hash.

## Requirement closure

- Before `accepted`, reconcile the candidate against every item in Mission `Must`. Do not accept while a Must item is unchecked or unresolved.
- Verify semantic consequences, not only dimensions. For bores, holes, pockets, slots, cuts, and shells, verify depth, throughness, and the affected side with geometry, measurement, or section evidence — never infer these properties from rendered appearance alone.
- Verify explicit final orientation, alignment, centering, or positioning instructions before acceptance.
- When current evidence contradicts a provisional assumption, reopen it instead of accepting around it.
