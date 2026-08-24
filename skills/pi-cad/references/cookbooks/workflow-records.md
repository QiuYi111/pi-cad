# Workflow records and decisions cookbook

Use the generated workflow contract and the Current Action Card for exact tools, fields, permissions, and transitions. This cookbook supplies authoring judgment; it does not duplicate the registry.

## Applicable / not applicable

Use for requirements, frame context, plans, assembly/interface records, review decisions, clarification, blockers, transitions, Evidence commit, and finish. Do not use narrative text as a substitute for a committed record or legal transition.

## Environment and permissions

The action card is authoritative. Only write in its allowed scope. A simulation-capable read-only phase may author `simulation/**`; it may not change design CAD. Project Head and `.pi-cad/**` are harness-owned.

## Minimum valid input

- Requirements: mission, inputs, constraints, Must/Should acceptance assertions, assumptions/open unknowns, deliverables, and evidence cases.
- Frame: source frame, interpreted axes/origin/units, confidence, and disposition.
- Plan: ordered source or investigation actions tied to requirements and evidence.
- Assembly/interface: ownership, datums, locating/DOF, fit, fastening, access, and verification.
- Review: exact current artifact/evidence bindings, findings, unresolved risks, and one legal decision.

## Complete working example

Route first, commit the whole task contract, then follow the action card. Commit phase-owned records through their dedicated commit operation. After source authoring, propose a candidate; in review, inspect current observations and simulation obligations. A solver success is not Evidence: inspect its immutable observation and commit the exact case only when appropriate. Use only a transition event shown by the card.

## Preflight

- Confirm route, phase, status, allowed writes, unmet records/cases, and current artifact hash from the card.
- Confirm every claim names its current source or Evidence binding.
- Confirm the contemplated event is listed as legal and is not a commit-only event.
- Confirm changed requirements were recommitted before rerouting or mutation.

## Expected Observation

The tool response returns new canonical state or a committed immutable record. An illegal transition returns phase, attempted event, allowed events/targets, unmet obligations, allowed commit tools, and suggested actions.

## Common failures and next action

- Missing Recipe/observer: remain in the simulation-capable review phase and edit only `simulation/**`.
- Missing source-authored derivation/analysis input: use the existing `revise` edge to the source phase.
- Real candidate geometry defect: use `local_geometry_issue`; never use it for Recipe/runtime/input failures.
- Missing external material/load/boundary: clarify in interactive mode or declare an external blocker in headless mode.
- Stale Evidence: rerun/recommit against the current artifact and current case.

## Retry stop condition

Stop when the same blocker remains without new authority/input, when no legal action can close it, or when a repeated structured failure says the owning file/runtime state must change. Do not retry an identical call.

## Provenance and Evidence meaning

Records prove that a controlled decision was committed. Evidence proves a tool result is bound to exact inputs and hashes. Neither alone proves the engineering requirement passes; review supplies that judgment.
