# Pi-CAD gap closure

Current state: GAP_CLOSURE (productive engineering phase).

Close every workstream that can be completed independently.

- If engineering geometry must change, edit the Python source and call cad_commit_candidate. The harness automatically rebuilds, renders, inspects, and compares the candidate against the project head.
- Use cad_commit_plan to keep workstream statuses current.
- Do not hide missing external decisions; mark them blocked_external.
- When gaps are structurally closed, call cad_transition(event="workstreams_structurally_closed") to move to package.
