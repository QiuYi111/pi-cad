# Generated workflow contract

> Generated from route compiler, phase grants, and obligation registry. Do not edit.

The per-turn Current Action Card is authoritative for the active route. This document explains every possible phase/event without requiring source inspection.

## Phases

### intake

Choose the route before engineering work.

- Mutation policy: read_only
- Grants: file_read, route
- Tools: read, grep, find, ls, cad_route
- Required records: none
- Possible events: none

### requirements

Commit the authoritative mission and acceptance contract.

- Mutation policy: read_only
- Grants: file_read, shell, commit_requirements, wait_for_user
- Tools: read, grep, find, ls, bash, cad_commit_requirements, cad_wait_for_user
- Required records: none
- Possible events: none

### build

Author and propose greenfield or hybrid CAD.

- Mutation policy: source_only
- Grants: file_read, shell, file_edit_source, observe, observe_interference, model_build, deliverable, commit_candidate, transition, wait_for_user
- Tools: read, grep, find, ls, bash, edit, write, cad_probe, cad_recall_observation, cad_build_step, cad_export, cad_generate_drawing, cad_render_scene, cad_commit_candidate, cad_transition, cad_wait_for_user
- Required records: none
- Possible events: none

### review

Interpret current part evidence and decide acceptance or regression.

- Mutation policy: read_only
- Grants: file_read, shell, file_edit_recipe, observe, observe_interference, observe_programmable, simulate, optimize, transition, wait_for_user, commit_plan
- Tools: read, grep, find, ls, bash, edit, write, cad_probe, cad_recall_observation, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_optimize, cad_transition, cad_wait_for_user, cad_commit_plan
- Required records: none
- Possible events: revise→build/modify, local_geometry_issue→build/modify, interface_or_detail_issue→part_design, architecture_issue→concept/part_design/plan, accepted→audit/ready, intent_issue→plan

### ready

Perform deterministic closure checks and finish.

- Mutation policy: read_only
- Grants: file_read, shell, observe, observe_interference, model_build, deliverable, file_edit_recipe, simulate, finish
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_build_step, cad_export, cad_generate_drawing, cad_render_scene, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_finish
- Required records: none
- Possible events: none

### done

Terminal completed workflow.

- Mutation policy: read_only
- Grants: file_read
- Tools: read, grep, find, ls
- Required records: none
- Possible events: none

### baseline

Understand the existing design and its frame.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, file_edit_recipe, simulate, commit_frame_context, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_commit_frame_context, cad_wait_for_user
- Required records: frame_context
- Possible events: baseline_understood→assembly_design/concept/investigate/plan/system_concept

### investigate

Probe an artifact until the relevant cause is understood.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, file_edit_recipe, simulate, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_wait_for_user
- Required records: none
- Possible events: more_probe→investigate, cause_understood→explain

### explain

Deliver evidence-bound analysis findings.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, file_edit_recipe, simulate, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_wait_for_user
- Required records: none
- Possible events: findings_delivered→ready

### plan

Plan modifications to a legacy part.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, commit_plan, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, cad_commit_plan, cad_wait_for_user
- Required records: none
- Possible events: none

### modify

Author and propose legacy CAD changes.

- Mutation policy: source_only
- Grants: file_read, shell, file_edit_source, observe, observe_interference, model_build, deliverable, commit_candidate, transition, wait_for_user
- Tools: read, grep, find, ls, bash, edit, write, cad_probe, cad_recall_observation, cad_build_step, cad_export, cad_generate_drawing, cad_render_scene, cad_commit_candidate, cad_transition, cad_wait_for_user
- Required records: none
- Possible events: none

### concept

Select a coherent hybrid-part concept.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, file_edit_recipe, simulate, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_wait_for_user
- Required records: none
- Possible events: domain_work_needed→domain_analysis, explore_more→concept, direction_selected→part_design

### domain_analysis

Resolve a bounded domain question before concept selection.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, file_edit_recipe, simulate, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_wait_for_user
- Required records: none
- Possible events: domain_question_answered→concept/system_concept

### source_baseline

Understand the source before conversion.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, file_edit_recipe, simulate, commit_frame_context, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_commit_frame_context, cad_wait_for_user
- Required records: frame_context
- Possible events: baseline_understood→transform_plan

### transform_plan

Plan deterministic conversion.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, commit_plan, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, cad_commit_plan, cad_wait_for_user
- Required records: none
- Possible events: none

### convert

Produce and propose the converted artifact.

- Mutation policy: source_only
- Grants: file_read, shell, file_edit_source, observe, observe_interference, model_build, deliverable, commit_candidate, transition, wait_for_user
- Tools: read, grep, find, ls, bash, edit, write, cad_probe, cad_recall_observation, cad_build_step, cad_export, cad_generate_drawing, cad_render_scene, cad_commit_candidate, cad_transition, cad_wait_for_user
- Required records: none
- Possible events: none

### compare

Compare converted output to its source.

- Mutation policy: read_only
- Grants: file_read, shell, file_edit_recipe, observe, observe_interference, observe_programmable, simulate, optimize, transition, wait_for_user, commit_plan
- Tools: read, grep, find, ls, bash, edit, write, cad_probe, cad_recall_observation, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_optimize, cad_transition, cad_wait_for_user, cad_commit_plan
- Required records: none
- Possible events: repair→convert, accepted→ready

### audit

Audit release workstreams and identify gaps.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, observe_interference, model_build, deliverable, file_edit_recipe, simulate, commit_assembly_design, commit_interface_contracts, commit_plan, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, cad_build_step, cad_export, cad_generate_drawing, cad_render_scene, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_commit_assembly_design, cad_commit_interface_contracts, cad_commit_plan, cad_wait_for_user
- Required records: none
- Possible events: audit_complete→gap_closure, workstreams_structurally_closed→package

### gap_closure

Author engineering changes that close release gaps.

- Mutation policy: allowed
- Grants: file_read, shell, file_edit_source, observe, observe_interference, model_build, deliverable, file_edit_recipe, simulate, optimize, commit_candidate, commit_plan, transition, wait_for_user
- Tools: read, grep, find, ls, bash, edit, write, cad_probe, cad_recall_observation, cad_build_step, cad_export, cad_generate_drawing, cad_render_scene, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_optimize, cad_commit_candidate, cad_commit_plan, cad_transition, cad_wait_for_user
- Required records: none
- Possible events: workstreams_structurally_closed→package

### package

Create closure deliverables without inventing engineering intent.

- Mutation policy: allowed
- Grants: file_read, shell, file_edit_source, observe, observe_interference, model_build, deliverable, file_edit_recipe, simulate, optimize, commit_plan, transition, wait_for_user
- Tools: read, grep, find, ls, bash, edit, write, cad_probe, cad_recall_observation, cad_build_step, cad_export, cad_generate_drawing, cad_render_scene, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_optimize, cad_commit_plan, cad_transition, cad_wait_for_user
- Required records: none
- Possible events: package_prepared→final_review

### final_review

Verify release evidence and deliverables.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, file_edit_recipe, simulate, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_wait_for_user
- Required records: none
- Possible events: artifact_issue→package, engineering_issue→gap_closure, accepted→ready

### system_concept

Select the assembly architecture.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, file_edit_recipe, simulate, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, edit, write, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_wait_for_user
- Required records: none
- Possible events: domain_work_needed→domain_analysis, explore_more→system_concept, direction_selected→assembly_design

### assembly_design

Commit module ownership, datums, and install sequence.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, commit_assembly_design, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, cad_commit_assembly_design, cad_wait_for_user
- Required records: assembly_design
- Possible events: assembly_design_committed→interface_design

### interface_design

Commit explicit module interface contracts.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, commit_interface_contracts, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, cad_commit_interface_contracts, cad_wait_for_user
- Required records: interface_contracts
- Possible events: interface_contracts_committed→part_design

### part_design

Commit the part implementation plan.

- Mutation policy: read_only
- Grants: file_read, shell, observe, transition, commit_plan, wait_for_user
- Tools: read, grep, find, ls, bash, cad_probe, cad_recall_observation, cad_transition, cad_commit_plan, cad_wait_for_user
- Required records: none
- Possible events: plan_committed→build/modify

### integration_review

Verify the complete assembly, interfaces, interference, and simulations.

- Mutation policy: read_only
- Grants: file_read, shell, file_edit_recipe, observe, observe_interference, observe_programmable, simulate, optimize, transition, wait_for_user, commit_plan
- Tools: read, grep, find, ls, bash, edit, write, cad_probe, cad_recall_observation, cad_simulate, cad_sim_observe, cad_commit_simulation, cad_derive_analysis_model, cad_optimize, cad_transition, cad_wait_for_user, cad_commit_plan
- Required records: none
- Possible events: revise→build/modify, local_geometry_issue→build/modify, interface_or_detail_issue→interface_design, architecture_issue→assembly_design, accepted→audit/ready

## Events

### accepted

Current evidence supports phase acceptance.

- Use when: All current-version obligations and guards are satisfied.
- Do not use when: Final closure uses cad_submit_for_review when active.
- Occurs in: compare, review, final_review, integration_review

### architecture_issue

The part or assembly decomposition is wrong.

- Use when: Module ownership or architecture must change.
- Do not use when: Do not use for local geometry or solver failures.
- Occurs in: review, integration_review

### artifact_issue

Closure packaging artifacts need repair.

- Use when: Engineering is acceptable but package output is defective.
- Do not use when: Do not use for an engineering defect.
- Occurs in: final_review

### assembly_design_committed

The assembly record was committed.

- Use when: cad_commit_assembly_design emitted it.
- Do not use when: Never call cad_transition with it.
- Occurs in: assembly_design

### audit_complete

Release workstreams were audited and classified.

- Use when: Statuses are complete.
- Do not use when: Workstreams remain unassessed.
- Occurs in: audit

### baseline_understood

The bound baseline and frame are understood.

- Use when: Baseline observations and frame record are current.
- Do not use when: Baseline, frame, or required observations are missing.
- Occurs in: baseline, source_baseline

### cause_understood

Evidence is sufficient to explain the condition.

- Use when: Cause and limits are supported.
- Do not use when: Material hypotheses remain untested.
- Occurs in: investigate

### direction_selected

The concept is ready for detailed design.

- Use when: Tradeoffs and assumptions are recorded.
- Do not use when: A required domain question remains.
- Occurs in: system_concept, concept

### domain_question_answered

The bounded domain question is answered.

- Use when: Analysis can inform concept selection.
- Do not use when: The question is unresolved or externally blocked.
- Occurs in: domain_analysis

### domain_work_needed

A bounded domain analysis is needed.

- Use when: A physical question changes the concept.
- Do not use when: Do not use for ordinary implementation judgment.
- Occurs in: system_concept, concept

### engineering_issue

Final review found an engineering gap.

- Use when: Design or evidence must change.
- Do not use when: Do not use for presentation-only defects.
- Occurs in: final_review

### explore_more

Continue concept exploration.

- Use when: Material alternatives remain.
- Do not use when: Do not loop without a discriminating question.
- Occurs in: system_concept, concept

### findings_delivered

The evidence-bound analysis was delivered.

- Use when: Required evidence and cases are closed.
- Do not use when: Do not bypass required simulation evidence.
- Occurs in: explain

### intent_issue

The legacy modification plan misunderstood intent.

- Use when: The intended change must be replanned.
- Do not use when: Do not use for local implementation defects.
- Occurs in: review

### interface_contracts_committed

The interface records were committed.

- Use when: cad_commit_interface_contracts emitted it.
- Do not use when: Never call cad_transition with it.
- Occurs in: interface_design

### interface_or_detail_issue

Interface/detail contracts require redesign.

- Use when: Locating, fit, access, or fastening intent is wrong.
- Do not use when: Do not use for local solid defects.
- Occurs in: review, integration_review

### local_geometry_issue

A concrete local candidate-geometry defect needs source repair.

- Use when: Evidence identifies a real geometry defect.
- Do not use when: Do not use for Recipe, environment, or external-input failures.
- Occurs in: review, integration_review

### more_probe

Continue with another targeted observation.

- Use when: A specific unresolved question remains.
- Do not use when: Do not repeat an identical probe without a new question or subject.
- Occurs in: investigate

### package_prepared

Closure deliverables are ready for review.

- Use when: Package artifacts and provenance exist.
- Do not use when: Package contents are missing or stale.
- Occurs in: package

### plan_committed

The plan record was committed by its dedicated tool.

- Use when: cad_commit_plan emitted it.
- Do not use when: Never call cad_transition with it.
- Occurs in: part_design

### repair

The converted output needs another conversion pass.

- Use when: Comparison found a conversion defect.
- Do not use when: Do not use after verified equivalence.
- Occurs in: compare

### revise

Return to source work for a bounded CAD, sidecar, or analysis-input revision.

- Use when: Source-authored content must change without revisiting architecture.
- Do not use when: Recipe/observer-only changes are allowed in simulation-capable review phases.
- Occurs in: review, integration_review

### workstreams_structurally_closed

Every release workstream has a non-open status.

- Use when: Each is complete, not applicable, or blocked external.
- Do not use when: Do not equate missing evidence with completion.
- Occurs in: audit, gap_closure

## Obligations

- **evidence:assembly** — close: The owning capability's evidence lifecycle. Invalidation: Artifact, requirements, input, case, or provenance change. Recovery: Re-run against the current artifact and recommit when required.
- **evidence:drawing** — close: The owning capability's evidence lifecycle. Invalidation: Artifact, requirements, input, case, or provenance change. Recovery: Re-run against the current artifact and recommit when required.
- **evidence:interference** — close: The owning capability's evidence lifecycle. Invalidation: Artifact, requirements, input, case, or provenance change. Recovery: Re-run against the current artifact and recommit when required.
- **lineage:baseline** — close: The current action card and owning cookbook. Invalidation: Authoritative state change. Recovery: Return to the earliest owning phase.
- **lineage:continuity** — close: The current action card and owning cookbook. Invalidation: Authoritative state change. Recovery: Return to the earliest owning phase.
- **lineage:retained_interfaces** — close: The current action card and owning cookbook. Invalidation: Authoritative state change. Recovery: Return to the earliest owning phase.
- **presentation:assembly_animation** — close: The current action card and owning cookbook. Invalidation: Authoritative state change. Recovery: Return to the earliest owning phase.
- **presentation:exploded** — close: The current action card and owning cookbook. Invalidation: Authoritative state change. Recovery: Return to the earliest owning phase.
- **presentation:hero** — close: The current action card and owning cookbook. Invalidation: Authoritative state change. Recovery: Return to the earliest owning phase.
- **presentation:turntable** — close: The current action card and owning cookbook. Invalidation: Authoritative state change. Recovery: Return to the earliest owning phase.
- **record:assembly_design** — close: The dedicated cad_commit_* tool. Invalidation: Requirements/reroute or review regression. Recovery: Re-enter the owning phase and recommit the full record.
- **record:frame_context** — close: The dedicated cad_commit_* tool. Invalidation: Requirements/reroute or review regression. Recovery: Re-enter the owning phase and recommit the full record.
- **record:interface_contracts** — close: The dedicated cad_commit_* tool. Invalidation: Requirements/reroute or review regression. Recovery: Re-enter the owning phase and recommit the full record.
- **workstream:assembly_service** — close: A truthful non-open release status. Invalidation: Requirements or release package change. Recovery: Re-audit and regenerate affected outputs.
- **workstream:bom** — close: A truthful non-open release status. Invalidation: Requirements or release package change. Recovery: Re-audit and regenerate affected outputs.
- **workstream:configuration** — close: A truthful non-open release status. Invalidation: Requirements or release package change. Recovery: Re-audit and regenerate affected outputs.
- **workstream:design_definition** — close: A truthful non-open release status. Invalidation: Requirements or release package change. Recovery: Re-audit and regenerate affected outputs.
- **workstream:engineering_analysis** — close: A truthful non-open release status. Invalidation: Requirements or release package change. Recovery: Re-audit and regenerate affected outputs.
- **workstream:inspection_acceptance** — close: A truthful non-open release status. Invalidation: Requirements or release package change. Recovery: Re-audit and regenerate affected outputs.
- **workstream:manufacturing_definition** — close: A truthful non-open release status. Invalidation: Requirements or release package change. Recovery: Re-audit and regenerate affected outputs.
- **workstream:presentation** — close: A truthful non-open release status. Invalidation: Requirements or release package change. Recovery: Re-audit and regenerate affected outputs.
- **workstream:risk_quality** — close: A truthful non-open release status. Invalidation: Requirements or release package change. Recovery: Re-audit and regenerate affected outputs.
