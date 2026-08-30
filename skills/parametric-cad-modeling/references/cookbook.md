# build123d authoring cookbook

## Applicable / not applicable

Use for deterministic STEP-first parts and assemblies. Do not use mesh-only modeling for authoritative mechanical geometry or depend on generated face order.

## Environment and permissions

Copy an asset into an allowed model/source directory. Run Python through the project uv environment. Keep all inputs local, named, and deterministic.

## Minimum valid input

Named dimensions, units, datum/origin convention, functional interfaces, and declared STEP output. Assemblies additionally require unique component labels and explicit Locations/joints.

## Complete working example

The part asset builds a centered plate from named dimensions and cuts a compound set of holes. The assembly asset builds labeled components at explicit datums and exports the compound. Replace its parameters and interface names, not the deterministic output contract.

## Preflight

- Make a compact contract table before construction: classify values as authoritative, derived, assumed, or unresolved; state local/world axes, operation type, and attachment plane. Do not hide an unresolved acceptance-critical coordinate in source.
- Select topology by stable geometric conditions (orientation, extrema, radius/area), not face index. See [build123d topology selection](https://build123d.readthedocs.io/en/stable/topology_selection.html).
- Use explicit datum planes/Locations and semantic labels/joints for assemblies. See [build123d assemblies](https://build123d.readthedocs.io/en/latest/assemblies.html).
- State `Align` or an equivalent datum placement on every attachment-sensitive primitive. Verify each primitive's bounds and each stacked/tangent interface plane before composition; do not rely on constructor centering defaults.
- Combine repeated cutters before one Boolean operation; avoid long incremental fuse/cut loops. For a through-cut, overrun only along the cut axis, then verify every intended center/axis and entry/exit rim or face.
- Check positive dimensions, wall/edge distance, expected solid/occurrence count, bounding box, and volume. After each Boolean, also check retained external datums, connectivity, and material added or removed at the intended locus.

## Expected Observation

Deterministic build provenance, STEP artifact, visual views, geometry totals, and (for assembly) hierarchy/interference summaries with pageable detail.

## Common failures and next action

Fragile selector: rewrite using a stable geometric filter. Boolean failure: inspect overlap/tolerance and combine operations. Wrong assembly pose: repair datum/Location ownership, not downstream geometry.

## Retry stop condition

Stop unchanged build retries. Clarify missing authoritative dimensions/interfaces before inventing them.

## Provenance and Evidence meaning

Source and STEP hashes prove regeneration lineage. Only candidate commit/review can advance Project Head.
