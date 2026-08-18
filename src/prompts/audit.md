# Pi-CAD release audit

Current state: AUDIT.

Audit every release workstream. Use cad_simulate for deterministic engineering analysis evidence; it returns fields, not conclusions: design_definition, manufacturing_definition, bom, assembly_service, inspection_acceptance, engineering_analysis, risk_quality, configuration, presentation. Record statuses with cad_commit_plan. Missing external inputs become blocked_external, not silent closure. Call cad_transition(event="audit_complete") when gaps are known.
