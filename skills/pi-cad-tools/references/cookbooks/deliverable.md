# Deliverable authoring cookbook

## Applicable / not applicable

Use primitives for deterministic geometry export. Use Recipe-first `drawing` and `presentation` packages for multi-step drawing/render execution. Do not use packaging to invent tolerances, repair geometry, or prove analysis.

## Environment and permissions

Follow the Action Card write scope. Source STEP remains authoritative. Drawing/presentation compute runs in a pinned, network-denied runtime; the exact Recipe closure, inputs, selected action, observer revision, and exports are snapshotted.

## Minimum valid input

Export: source artifact and format/output. Drawing: a `kind: drawing` `pi-recipe.yaml` plus a `validate|generate` action. Presentation: a `kind: presentation` Recipe plus a `validate|preview|generate|run` action. When the Action Card exposes a Recipe-backed Evidence obligation, pass its exact `obligationRef` and every `requiredOutputs` name.

## Complete working example

Use the exact STEP path and SHA-256 returned by the current build or selected `ArtifactRef`; pass both as `source` and `sourceSha256` to `cad_export`. Do not replace it with a remembered default path or choose a file by modification time. A selected old STEP is allowed when named explicitly; report it as that old artifact revision.

For a named assembly, pass occurrence/feature refs from the identity manifest. Display labels are not unique identifiers. Do not use `solids()[n]`, display order, or bounding-box proximity as a stable object mapping. Anonymous external STEP remains viewable, but its geometry-based fallback IDs only identify solids in that exact artifact revision.

Then author the Recipe/spec and call `cad_generate_drawing({recipe, stage, obligationRef, outputs})` or `cad_render_scene({recipe, stage, obligationRef, outputs})`. The one-shot domain action executes, observes, and explicitly commits either the pre-bound Evidence or non-Evidence artifacts. Inspect previews and immutable export hashes before review.

## Preflight

Check source binding, units, view orientation, scale, required annotations, output path, and capability readiness. Do not add unspecified tolerances or manufacturing notes.

## Expected Observation

Output artifact paths/hashes and previews where supported. A missing optional renderer is reported as capability unavailable rather than forged output.

## Common failures and next action

Missing artifact: bind/propose the current design. Unsupported format/view: revise the spec. Engineering content missing: return to its owning design/requirements phase, not packaging.

## Retry stop condition

Do not retry a missing external renderer or unchanged invalid spec. Stop if required engineering intent is absent.

## Provenance and Evidence meaning

Deliverable Evidence proves the package came from the exact design/spec. It does not prove geometry, strength, flow, thermal behavior, or manufacturability by itself.
