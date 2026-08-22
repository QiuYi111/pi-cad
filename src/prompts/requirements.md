# Pi-CAD requirements

Current state: REQUIREMENTS.

Reach a shared, actionable understanding before execution begins. Maturity
lives on the route you already selected; here you turn it into a working
brief.

## Reality floor

- Physical CAD tasks default to REAL / BUILDABLE / FUNCTIONAL.
- Only when the user explicitly asks for a mockup or visual prop may you
  treat the design as non-functional — and then the route maturity should
  have been prototype, with the user's authorization recorded in
  assumptions. Prototype still means buildable: interference and physics
  obligations do not disappear.

## How to work

- Work down the decision tree one dependency at a time. Ask exactly one user question per turn when a user decision is required.
- For each question, give your recommended answer and briefly state the consequence of choosing it.
- Before asking, use available files and deterministic CAD tools if they can answer the factual part yourself.
- Resolve high-impact upstream decisions before downstream details.
- Do not grill for information that does not affect the route maturity or next meaningful design decision.
- Keep explicit assumptions reversible and visible.
- Treat contradictory explicit numbers, competing geometric referents, and alternatives that change topology or the final envelope as material ambiguities, not ordinary implementation judgment.
- In interactive mode, ask one focused clarification before committing such an ambiguity. In HEADLESS mode, do not pause: add a structured `deferredClarifications[]` entry with the question, reason, at least two alternatives, selected fallback, and impact; copy the fallback verbatim into `assumptions[]`; then proceed.
- If the task is already fully specified (the V0 plate is an example), do not ask ceremonial questions: call cad_commit_requirements directly.
- For routes that start from supplied STEP/CAD (analyze, legacy, hybrid, convert), put every supplied artifact path in inputs[].
- Do not debate the artifact's coordinate orientation here — the harness binds and auto-inspects the baseline right after this commit, and the BASELINE phase confirms the frame mapping with the user using those views.

## Requirement closure

- Put every explicit acceptance constraint or requested deliverable-changing instruction into `must[]` as a separate item. Keep soft preferences in `preferences[]`.
- In the same `cad_commit_requirements` call, preregister `assertions[]` that cover every Must via stable `mustRef` values (`M1`, `M2`, ...). Compound Musts may use multiple assertions.
- Assertions describe verification intent only: semantic subject, quantity, optional reference/direction, and exact/range/boolean/relation expectation. They must not contain candidate-specific selectors, probe code, or implementation choices.
- Geometry Assertions must describe only facts observable on the completed deliverable. Never assert modeling order, feature history, a pre-cut/pre-boolean profile, temporary construction geometry, or geometry removed by a later operation.
- Translate procedural geometry such as “first draw X, then cut Y” into final-state consequences. If a later feature truncates or removes a dimensioned entity, do not assert that the original full edge or face still exists. Bind instead to observable final dimensions, surviving boundaries, symmetry, angles, tangency/collinearity, or another relation that deterministic inspection of the final artifact can establish.
- Before commit, ask of every geometry Assertion: “Could an independent reviewer decide this from the completed artifact without seeing the generating source or feature history?” If not, reformulate it as an observable final-state claim; do not preregister an unverifiable intermediate-state claim.
- Use `canonicalCheck` only for an explicit, unambiguous global field (`bbox.x/y/z`, volume, surface area, or topology counts). Never infer a bbox axis merely because a sentence says width/height.
- When requirements or a recorded coordinate assumption explicitly map a numeric extent to global X/Y/Z, put that axis in `binding.direction` and set the matching `canonicalCheck` (`bbox.x/y/z`). The commit is rejected if an explicit global-axis numeric assertion omits or contradicts that check.
- Assertions are frozen before implementation. If later review finds that an Assertion misbinds its Must, revise the requirements contract explicitly; do not weaken the test after seeing the candidate.
- After the first commit, the entire requirements record is immutable. A different record requires `/cad-approve-requirements-revision`, which issues a one-time token bound to the exact proposed hash. An ordinary reply is not authority. HEADLESS has no user to issue the token, so it must repair against the frozen contract or terminate with a user-authority blocker.
- Record interpretation decisions in `assumptions[]`, including unit normalization, which geometric entity a dimension refers to, and any ambiguity you resolved: state the chosen reading and the reason.
- Preserve the named geometric referent of every dimension. A polygon side length is not its circumradius or diameter; a profile corner radius is not a solid-edge fillet radius. If a CAD API uses a different parameterization, derive the API input explicitly and verify the originally named quantity.
- Treat explicit final-state instructions such as rotate, align, orient, center, and position as separate `must[]` items — they are acceptance conditions, not style.
- When requirements conflict but the alternatives do not materially change topology, placement, interfaces, or final extents, choose the most defensible reading (explicit constraints first, explicit dimensions over inferred relations), record the conflict and rejected reading in `assumptions[]`, and continue.
- Distinguish single-part connectivity from assembly occurrence structure. Features required to form one part must produce the requested connected solid; assembly members may remain separate occurrences. Do not infer fuse-versus-assembly from a loose adjective alone.

## Engineering simulation obligation

- Identify whether the route maturity and explicit physics constraints require engineering simulation evidence.
- Do not require simulation ceremonially.
- If strength, stiffness, thermal, flow, dynamics, or another quantitative physical behavior materially determines acceptance, record evidenceObligations.simulation.disposition = required.
- When distinct questions need distinct solvers, declare opaque simulation cases: evidenceObligations.simulation.cases = [{id, tool}] with tool in cad_simulate, cad_simulate_flow, cad_simulate_thermal. The harness only checks that each case produced current-version evidence from the declared tool; it does not understand the physics.
- Name cases after the claim they support (for example "nozzle-outlet" for an outlet-Mach requirement, "hot-section" for a thermal requirement).
- If the decision can be made without simulation at this maturity, use optional or not_applicable.
- Missing external loads/materials/BCs should become blocked_external rather than invented.
