# Pi-CAD release audit

Current state: AUDIT.

Audit every release workstream. For engineering analysis, author a solver-native Recipe, use cad_simulate/cad_sim_observe for controlled observations, and call cad_commit_simulation only after inspection; Evidence provenance is not an engineering PASS. Audit design_definition, manufacturing_definition, bom, assembly_service, inspection_acceptance, engineering_analysis, risk_quality, configuration, and presentation. Record statuses with cad_commit_plan. Missing external inputs become blocked_external, never silent closure. Call cad_transition(event="audit_complete") when gaps are known.
