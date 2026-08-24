# Pi-CAD gap closure

Current state: GAP_CLOSURE (productive engineering phase).

Close every workstream that can be completed independently.

- If engineering geometry must change, edit the Python source and use the action card's candidate operation. The harness automatically rebuilds, renders, inspects, and compares against Project Head.
- Use the action card's plan operation to keep workstream statuses current.
- Do not hide missing external decisions; mark them blocked_external.
- When gaps are structurally closed, use the action card's legal completion event to move to packaging.
