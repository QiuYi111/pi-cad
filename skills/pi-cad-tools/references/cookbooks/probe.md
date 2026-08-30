# Probe and observation cookbook

## Applicable / not applicable

Use the unified Probe for read-only facts, views, selectors, measurements, sections, comparison, assembly hierarchy, interference, or a bounded programmable B-Rep calculation. Do not use it to mutate CAD or assign engineering semantics to geometric selectors.

## Environment and permissions

Ordinary presets require exactly one target: `subject=current|baseline` or `args.artifact`. Compare requires explicit `before` and `after`. Python requires only `subject`, `purpose`, and `code`; it rejects arbitrary artifact args, imports, subprocesses, network, and writes.

## Minimum valid input

```json
{"preset":"geometry","subject":"current","purpose":"establish overall geometry"}
```

```json
{"preset":"measure","subject":"current","purpose":"verify hole spacing","args":{"metric":"distance","a":"#c0","b":"#c1"}}
```

```json
{"preset":"compare","purpose":"verify conversion","args":{"before":"input.step","after":"output.step"}}
```

## Complete working example

1. Run geometry/surfaces to discover the current hash-bound shape and selectors.
2. Run only the measurement/section/interference question needed for the decision.
3. Read `resolvedSubject.source/path/sha256` and `observationId` from the result.
4. When detail is not on the first screen, recall the observation without a collection to get its catalog; then page a collection with filters/order and continue using `nextCursor`.

For 444 faces, the first result reports totals, type distribution, area range, and catalog metadata. The complete `surfaces` collection remains in `payload.json.gz`; page it at up to 200 rows per transfer. For 231 interference pairs, prioritize contact/penetration summaries and page the complete `pairs` collection.

## Preflight

- Pick the narrowest preset; use Python only if no typed preset expresses the question.
- Supply exactly one permitted subject form.
- Never reuse selectors after the resolved artifact hash changes.
- Derive expected values from the requirement contract, not from construction constants copied into the probe. Include a discriminator for a plausible wrong placement, axis, Boolean direction, or feature interpretation.
- For Python, assign a JSON-serializable `result`; keep scalars/small objects inline and allow arrays/tables to become collections. Inventory and filter entities by geometric type before reading type-specific properties such as radius or axis. Prefer plain bounded loops and lists over unsupported builtins, imports, or generator-heavy shortcuts.

## Expected Observation

Images precede text. Text contains a bounded semantic projection, exact resolved subject, immutable observation ID, and collection catalog/counts. Raw envelopes remain in immutable tool details, not default context.

## Common failures and next action

- Schema rejection: remove unknown/inapplicable fields; do not guess aliases.
- Missing bound subject: bind/propose the correct artifact or use an explicit permitted artifact target.
- Empty or oversized Python prose: return structured values; arrays become pageable collections.
- Stale selector: rerun discovery on the new artifact.
- Legacy summary: `detailUnavailable=legacy`; rerun only if full detail is now required.

## Retry stop condition

Do not repeat a probe unless the artifact changed or the new probe answers a materially different question. Page the existing immutable collection instead of re-probing to overcome context limits.

## Provenance and Evidence meaning

Probe snapshots are immutable observations bound to resolved subject hashes. Probe does not itself create or close Simulation Evidence.
