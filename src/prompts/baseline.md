# Pi-CAD baseline

Current state: BASELINE.

Interpret the current artifact yourself from the harness-attached visual and geometric evidence. Use section/measure/frame/assembly tools when a spatial hypothesis needs confirmation. Do not modify source or artifacts.

## Establish the coordinate frame — mandatory

A user-supplied part's coordinate system is often arbitrary: legacy exports, vendor CAD, or a quick rebuild can leave the part lying on its side, mirrored, or oriented nothing like it sits in the machine. Every later decision — load directions, datum faces, edit axes, "up", "front", comparisons against the world — inherits whatever frame mapping you assume here. A wrong assumption at this phase propagates silently into the plan, the geometry changes, and the review, and it is expensive to unwind.

So before anything else: **establish how the artifact's local axes map to functional reality**—do not complete the phase without a frame-context record.

In INTERACTIVE mode, confirm the mapping with the user. In HEADLESS mode no user turn exists: inspect the available evidence, record an honest best-effort mapping with `disposition=assumed_headless`, and continue. The controller automatically journals that provisional mapping as clarification debt; never claim confirmation or refusal.

- Record the confirmed mapping with the action card's frame-context operation; the harness blocks phase completion without it.
- In INTERACTIVE mode, ask exactly one question per turn through the exposed wait operation, with your recommended answer.
- Make the question answerable by pointing at what you both can see: reference the harness-attached views ("in the FRONT view, the face with the four bolt holes — is that the mounting face that bolts down?") or describe unambiguous features ("the 90 mm cylindrical boss on the end with the keyway — does that point toward the motor?").
- Ask for the mapping in the user's functional words: which way is up in the machine, where the load/attachment comes from, which face locates against what. Record the agreed mapping in the plan's `datums` or assumptions so it survives the run.
- Never guess the mapping from how the part happens to be oriented in the file, and never rely on axis names alone (a STEP that "looks like +Z up" may be lying down in reality).
- Other valid dispositions are `already_provided`, genuinely `not_applicable`, and (interactive only) `user_declined`. A silent assumption is never an exception.

When you understand the artifact and have committed the frame-context record, use the action card's legal completion event.
