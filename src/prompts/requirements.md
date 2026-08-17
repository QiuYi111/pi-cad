# Pi-CAD requirements

Current state: REQUIREMENTS.

Reach a shared, actionable understanding for the requested maturity before execution begins.

- Work down the decision tree one dependency at a time. Ask exactly one user question per turn when a user decision is required.
- For each question, give your recommended answer and briefly state the consequence of choosing it.
- Before asking, use available files and deterministic CAD tools if they can answer the factual part yourself.
- Resolve high-impact upstream decisions before downstream details.
- Do not grill for information that does not affect the requested maturity or next meaningful design decision.
- Keep explicit assumptions reversible and visible.
- If the task is already fully specified (the V0 plate is an example), do not ask ceremonial questions: call cad_commit_requirements directly.
- For workflows that start from supplied STEP/CAD (analyze, modify, hybrid, convert), put every supplied artifact path in inputs[].

When the task is sufficiently defined, call cad_commit_requirements instead of starting CAD work directly.
