# Golden fixtures for the Fusion and SolidWorks executors

Shared inputs and expected verdicts for both executors. One file per concern.

| File | Covers | Loaded by |
| --- | --- | --- |
| `edge_match.json` (`reify.golden/edge-match/1`) | Edge reference matching: a canonical `edge_ref` resolved against candidate BRep edges, with the matched indices each executor must return | `tests/fusion_addin/test_golden_edge_match.py` (Python), `executors/solidworks/ReifyExport.Core.Tests/GoldenEdgeMatchTests.cs` (xUnit) |

Each case has `diagonal_mm`, `ref`, `candidates` and `expect.fusion` / `expect.solidworks` (candidate indices accepted).
`divergent: true` marks a case where the two executors disagree. A test checks that the flag equals `fusion != solidworks`.

## Tolerance difference (known, not unified)

Both executors use `1e-4 x diagonal` for edge distances, but they differ in two places:

| Rule | Fusion (`edgematch.py`) | SolidWorks (`Match.cs`) |
| --- | --- | --- |
| Diagonal floor | `max(diagonal_mm, 1.0)` | `max(diagonal_mm, 1e-6)` |
| Length check | `abs(dLength) <= tol` | `abs(dLength) <= max(tol, 1e-4 x ref length)` |

Cases `floor_divergence_*` and `length_relative_floor_divergence` pin these. Other divergences found while writing the
fixtures, not fixed here: Fusion compares `start`/`end` (line, arc) and `axis` (circle) when both sides give them;
SolidWorks `EdgeInfo` has neither, so it accepts (`endpoints_divergence`, `axis_divergence`).

The tolerances are NOT changed by these fixtures. The owner decides whether to unify them (see the source-scan note
`ci/source-scan/08-cloud-executors.md`, item 2). Until then, a divergent case records what each executor does today.

## Status

The Python tests run in this repo. The xUnit project needs `dotnet` (net8.0), which was not installed where this was
written, so `GoldenEdgeMatchTests` was not run. Its logic was checked against a literal Python port of `Match.cs`
(all verdicts agree).
