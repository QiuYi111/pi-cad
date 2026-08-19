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
- If the task is already fully specified (the V0 plate is an example), do not ask ceremonial questions: call cad_commit_requirements directly.
- For routes that start from supplied STEP/CAD (analyze, legacy, hybrid, convert), put every supplied artifact path in inputs[].

## Engineering simulation obligation

- Identify whether the route maturity and explicit physics constraints require engineering simulation evidence.
- Do not require simulation ceremonially.
- If strength, stiffness, thermal, flow, dynamics, or another quantitative physical behavior materially determines acceptance, record evidenceObligations.simulation.disposition = required.
- When distinct questions need distinct solvers, declare opaque simulation cases: evidenceObligations.simulation.cases = [{id, tool}] with tool in cad_simulate, cad_simulate_flow, cad_simulate_thermal. The harness only checks that each case produced current-version evidence from the declared tool; it does not understand the physics.
- Name cases after the claim they support (for example "nozzle-outlet" for an outlet-Mach requirement, "hot-section" for a thermal requirement).
- If the decision can be made without simulation at this maturity, use optional or not_applicable.
- Missing external loads/materials/BCs should become blocked_external rather than invented.
