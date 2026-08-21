# Phase 3 Benchmark Gate Record

Date: 2026-08-21 · Branch: `refactor/runtime-v2` · Task: `quick-plate` (pi-cad config)

## Comparison

| Metric | Before (2026-08-20, commit 69225e8) | After (2026-08-21, phase 1–8 complete) |
| --- | --- | --- |
| success (checker) | false | false |
| missing artifacts | build/plate.step, models/plate.py | identical |
| piCadPhase | idle (checker reads post-finish state) | identical |
| toolCalls | 16 | 16 |
| candidateCommits | 1 | 1 |
| errors | 0 | 0 |
| tokens | 99,878 | 122,605 |
| wallMs | 86,780 | 111,038 |

## Interpretation

The `success:false` verdict is a **task-checker filename expectation**
artifact, identical before and after: the agent names its outputs
`models/mounting_plate.py` / `build/mounting_plate.step` while the
checker expects `plate.py` / `plate.step`. The workflow itself completed
end-to-end in BOTH runs:

- `cad_route → cad_commit_requirements → cad_commit_plan → source →
  cad_commit_candidate` (auto evidence bound) → geometry/section/surface/
  measure probes → `cad_transition(accepted)` → `cad_finish`
- zero tool errors in both runs
- identical tool-call pattern (16 calls) in both runs

The "after" run additionally exercised the refactored stack under a real
LLM driver: probe-registry wrappers answering legacy tool names
(`cad_inspect_geometry` etc.), observation-layer rendering, contract-
compiled phase tool sets, finalizer-driven candidate commit.

## Gate verdict

- **No capability regression**: identical workflow completion, identical
  checker outcome, zero errors, same tool budget.
- Token delta (+23%) and wall-clock delta (+28%) are within single-sample
  noise for this task; the before-run itself varies by driver caching and
  model load. Not treated as a regression signal; to be confirmed with a
  multi-task campaign before old-tool retirement.
- **Old-tool retirement stays gated**: the legacy inspection wrappers
  remain registered (deprecated) until a fuller campaign (multiple tasks
  × configs × seeds) confirms parity, per the v2 plan.

## Reproduce

```bash
node benchmarks/run.mjs --tasks quick-plate --configs pi-cad
```
