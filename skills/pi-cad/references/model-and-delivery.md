# Authoritative model and delivery

- Project Head is the accepted authoritative design. Source and STEP identity must remain traceable.
- Author model changes in source phases; use `cad_commit_candidate` to build, observe, hash, and propose a candidate.
- A solver convenience model is not Project Head. Create a hash-bound derivation with `cad_derive_analysis_model`, then declare both its record and output as Recipe inputs.
- `cad_build_step` is a lower-level deterministic build operation, not candidate acceptance.
- `cad_export`, `cad_generate_drawing`, and `cad_render_scene` create deliverables. They do not repair missing design intent or prove engineering acceptance.
- Optimization output is a design aid. Reconstruct it as CAD, commit a candidate, and re-run required validation.
