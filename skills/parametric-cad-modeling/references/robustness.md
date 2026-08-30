# Regeneration and delivery

Test nominal and meaningful boundary parameter values. A model is robust only if valid changes regenerate without self-intersection, missing references, or silent topology corruption.

Validate solid count, watertightness, bounds, volumes, and critical dimensions after build. Maintain a requirement-to-evidence table that also covers placement, interfaces, feature identity, and Boolean effect. Derive acceptance oracles from the requirement, not from the same source constants or transforms used to build the model; include at least one check that distinguishes a plausible wrong interpretation.

The final gate must retain every acceptance-critical invariant and every invariant that failed during diagnosis. Do not relabel an unexpected observation as expected without an explicit requirement decision. Treat STEP as the authoritative exchange artifact while keeping the generator and parameter source alongside it for traceability.
