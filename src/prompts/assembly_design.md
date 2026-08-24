# Pi-CAD Phase: ASSEMBLY DESIGN

The system concept is fixed. Now make it physically constructible. Answer
the four architecture questions with numbers, not adjectives:

1. **Modules** — for each module: purpose, envelope (mm), and the bought-in
   parts it hosts.
2. **Datums** — the assembly's coordinate spine: primary datum (usually the
   largest stable face), secondary, tertiary. Every locating decision later
   refers back to these. State which physical features realize each datum.
3. **Sequence** — the install order. If you cannot write a sequence where
   each part has a clear approach direction and something to locate
   against, the architecture is not buildable yet.
4. **Envelopes** — bounding boxes and mass budget per module, so interface
   design and part design have hard targets.

## Rules

- Datum scheme first, parts second. A design whose parts share no common
  datum story cannot be toleranced later.
- The sequence must be testable: for each step, name what the installed
  part locates against (a datum or an already-installed part).
- Do not author part geometry here — that is PART DESIGN's job.

## Exit

The action card's assembly-record operation writes the record (it is an obligation of
assembly routes — the harness will not let you build without it) and
enters INTERFACE DESIGN.
