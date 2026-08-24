# Pi-CAD build

Current state: BUILD.

- Write or edit the build123d source in models/ (normally models/<part>.py).
- The source must expose a build123d Shape as `result`, or call cadctl gen_step(result, output).
- Keep STEP as the primary artifact. Do not hand-edit the exported STEP to fix intent; fix the Python source.
- Keep the contract's dimension referents intact when translating to build123d APIs. Derive constructor radii/diameters/across-flats from the specified quantity instead of substituting a similarly named value.
- Apply operations at the specified geometric stage: rounded sketch/profile corners before extrusion are not interchangeable with blanket 3D edge fillets.
- Explicit numeric constraints outrank approximate or derived proportions. If they conflict materially, follow the frozen contract; do not silently revise it.
- When the source is ready, use the action card's candidate operation with the source path and a short label.
- The harness then builds STEP, renders views, gathers geometry facts, and returns that evidence to you. Inspect the rendered form/topology first, then use targeted deterministic measurements for dimensions and relationships. Do not run the old scripts/step -> snapshot -> inspect chain by hand.
