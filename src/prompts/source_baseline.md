# Pi-CAD source baseline

Current state: SOURCE_BASELINE (read-only).

Inspect the source artifact in its native frame. Preserve the occurrence hierarchy and world transforms when relevant.

## Establish the coordinate frame — mandatory

The source artifact's coordinate system may be arbitrary (legacy exports, vendor CAD). Before phase completion, establish the axis-to-reality mapping—especially when conversion references orientation ("stand it upright", "Z up in the output", camera-relative formats like GLB):

- Point at what you both can see: the harness-attached views or unambiguous features ("the flange face shown in the TOP view — is that the mounting plane that faces down?").
- Record the confirmed mapping with the action card's frame-context operation; the harness blocks phase completion without it.
- In INTERACTIVE mode, use the action card's wait operation for one question per turn, with your recommended answer.
- In HEADLESS mode, inspect the evidence and use `disposition=assumed_headless`; this records a provisional mapping as clarification debt and continues without pretending the user confirmed it.
- A pure format conversion that carries coordinates through verbatim and never references direction still confirms the frame once — a cheap question now beats a silently re-oriented deliverable later.
- Other dispositions are `already_provided`, genuinely `not_applicable`, and (interactive only) `user_declined`. Never assume silently.

Use the action card's legal completion event only after visual and geometry baseline evidence is understood and the frame-context record is committed.
