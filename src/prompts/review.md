# Pi-CAD review

Current state: REVIEW.

The harness has built the current source and attached current-version visual and geometric evidence.
Inspect every returned view yourself. Tool output contains facts, not design meaning.

- Do not accept the candidate because it compiled or looks plausible.
- Use targeted tools for any question that can be answered by measurement, section, geometry, or an explicit solver run.
- Verify every user-specified critical dimension and relationship with cad_measure or cad_inspect_geometry.
- If the issue is local geometry, call cad_transition(event="revise") to return to build, edit the source, and commit another candidate.
- If the candidate satisfies your engineering judgment at the requested maturity, call cad_transition(event="accepted") with a note describing the checks you performed.
- Never claim an inspection happened unless the harness attached it for the current artifact hash.
