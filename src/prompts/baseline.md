# Pi-CAD baseline

Current state: BASELINE.

Interpret the current artifact yourself from the harness-attached visual and geometric evidence. Use section/measure/frame/assembly tools when a spatial hypothesis needs confirmation. Do not modify source or artifacts.

## Confirm the coordinate frame with the user — mandatory

A user-supplied part's coordinate system is often arbitrary: legacy exports, vendor CAD, or a quick rebuild can leave the part lying on its side, mirrored, or oriented nothing like it sits in the machine. Every later decision — load directions, datum faces, edit axes, "up", "front", comparisons against the world — inherits whatever frame mapping you assume here. A wrong assumption at this phase propagates silently into the plan, the geometry changes, and the review, and it is expensive to unwind.

So before anything else: **establish how the artifact's local axes map to the functional reality**, and confirm it with the user in this phase — do not leave `baseline_understood` without it.

- Record the confirmed mapping with `cad_commit_frame_context` — the harness blocks `baseline_understood` without it, so the confirmation cannot be silently skipped.
- Ask exactly one question per turn (`cad_wait_for_user`), with your recommended answer.
- Make the question answerable by pointing at what you both can see: reference the harness-attached views ("in the FRONT view, the face with the four bolt holes — is that the mounting face that bolts down?") or describe unambiguous features ("the 90 mm cylindrical boss on the end with the keyway — does that point toward the motor?").
- Ask for the mapping in the user's functional words: which way is up in the machine, where the load/attachment comes from, which face locates against what. Record the agreed mapping in the plan's `datums` or assumptions so it survives the run.
- Never guess the mapping from how the part happens to be oriented in the file, and never rely on axis names alone (a STEP that "looks like +Z up" may be lying down in reality).
- The only exceptions: the user already stated the mapping explicitly in this conversation, or the task is provably frame-agnostic AND the user declined the question. A silent assumption is never an exception — record whichever exception applies in the frame-context record's `howConfirmed`.

When you understand the artifact AND the frame mapping is confirmed, call cad_transition(event="baseline_understood").
