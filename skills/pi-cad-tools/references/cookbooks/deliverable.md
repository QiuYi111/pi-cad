# Deliverable authoring cookbook

## Applicable / not applicable

Use for deterministic exports, drawings, and explicit render/scene specifications. Do not use packaging to invent tolerances, repair geometry, or prove analysis.

## Environment and permissions

Follow action-card write scope. Source STEP remains authoritative; sidecars and presentation files retain hash-bound provenance.

## Minimum valid input

Export: source artifact and format/output. Drawing: views, units, dimensions/notes explicitly supported by requirements. Scene: models, transforms, camera, lighting, output, and animation intent.

## Complete working example

Verify current artifact hash, author a structured drawing or scene spec, generate the deliverable, inspect its visual/metadata result, and include it in package/final review without claiming more than it shows.

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
