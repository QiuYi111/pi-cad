# CADTestBench × Pi-CAD Benchmark

External deterministic benchmark loop for the Pi-CAD harness (plan v0.1,
Jira JIN-30). One command takes a CADTestBench prompt through the
**unmodified production harness** to a scored, fully-logged run:

```
CADTestBench prompt (adapted) → pi -p + Pi-CAD extensions → STEP artifact
  → bridge wrapper → CADTestBench evaluator → manifest + transcripts
```

## Status

| Phase | State |
| --- | --- |
| 0 experiment contract | ✅ frozen (see `experiment.json` per run + this file) |
| 1 bootstrap | ✅ dedicated venv, frozen dataset snapshot, official evaluator verified |
| 2 STEP bridge parity | ✅ 200/200 samples, see [parity findings](#bridge-parity-findings) |
| 3 one-command runner | ✅ `run.mjs` |
| 4 pilot-5 | ✅ 3/5 exact, 2 harness findings |
| 5 diagnostic-20 baseline | ✅ 18/20 exact, 249/257 CADTests (96.9%) |
| 6 failure analysis | ✅ `classify.py`, 2 DIM/GEOM (REQ-side) + 2 HARNESS stalls |
| 7 harness patch | ✅ commit `8fb170e` (autonomous decision boundary) |
| 8 paired regression | ✅ executed — **integrity audit pending** (see below) |

> **Integrity note (2026-08-20)**: the detailed-200 run was stopped at 89/200
> after a leakage audit found ground-truth material (parity outputs, frozen
> dataset) within the agent's filesystem reach; 4 of 89 samples were
> contaminated. All model runs to date (pilot-5, both diag-20 rounds,
> detailed-200) predate this discovery and their **scores are unaudited**;
> the `8fb170e` completion-rate attribution rests on direct transcript
> evidence and stands. Formal numbers require the isolation fix and a clean
> rerun. See `retrospective-v0.1.md` for the full postmortem.

## Layout

```
benchmarks/cadtestbench/
├── bootstrap.sh          # Phase 1 end-to-end (venv, install, freeze, smoke)
├── freeze-dataset.py     # HF → local parquet snapshot + dataset-lock.json
├── extract-prompts.py    # prompts + frozen adaptation policy
├── select-sets.py        # freeze pilot-5 / diagnostic-20 (deterministic)
├── bridge.py             # STEP→CadQuery wrapper generator (+baseline export)
├── parity.py             # bridge parity test A/B over full partition
├── classify.py           # failure taxonomy (plan §6 codes)
├── compare.py            # paired regression before/after (plan §8)
├── report.py             # first-report generator (plan §17)
├── run.mjs               # the benchmark runner (Phase 3 adapter)
├── dataset-lock.json     # frozen dataset provenance (committed)
├── sets/*.json           # frozen sample sets (committed)
├── data/                 # frozen snapshot + adapted prompts (gitignored)
├── external/CADTestBench/# upstream clone @ e29283c (gitignored)
└── results/              # all runs (gitignored)
```

## Experiment contract (Phase 0)

* **Model**: `openai-codex/gpt-5.6-luna`, thinking `max` — identical for
  baseline and regression.
* **Pi-CAD**: git commit recorded per run in `experiment.json`; production
  extensions only (`core,geometry,visual,ui`) via explicit `-e`, with
  `--no-skills --no-themes`. No benchmark-only tools, no workflow changes.
* **Benchmark**: upstream `CADTestBench` @ `e29283c`, dataset frozen from
  HF `dimitrismallis/CADTestBench` rev `2b9a4a9` into local parquet
  (`dataset-lock.json`, sha256 per file). Evaluation never touches the Hub.
* **Prompt adaptation (frozen policy)**: every CADTestBench prompt
  (200/200 both partitions) literally instructs "Write Python code using
  CADQuery". Pi-CAD is a build123d toolchain, so the code-generation
  instruction is stripped (regex, logged per sample in
  `data/prompts.<partition>.json`) and a fixed task frame is appended:
  *"Deliver the part as a STEP artifact with its Python source."*
  Requirement text (dimensions, features, spatial constraints) is preserved
  byte-for-byte. Same policy for baseline and regression runs.
* **Timeout / retry**: 30 min per sample, 1 attempt (retries only for
  provider transport failures).
* **Artifact resolution**: `project.head.artifactPath` → latest
  `runs.*.currentArtifactPath` → `NO_ARTIFACT`. CAD correctness and harness
  completion are reported as **independent** metrics.
* **Python isolation**: Pi-CAD runtime (build123d/OCP, repo-managed) vs
  evaluator runtime (cadquery 2.8.0 in `.venv/`, uv CPython 3.12.14) —
  the two stacks never share an environment; STEP is the only interface.

## Usage

```bash
./bootstrap.sh                                   # one-time
node run.mjs --set pilot-5                       # pilot
node run.mjs --set diagnostic-20 --label baseline
node run.mjs --sample-ids 00000007 --label probe
node run.mjs --set diagnostic-20 --dry-run       # inspect contract only
.venv/bin/python parity.py --partition detailed  # re-verify bridge
```

Per-sample output (plan §16): `results/<run>/samples/<id>/` contains
`manifest.json` (joined benchmark/agent/harness/evaluation/usage/execution
fields), `prompt.txt`, `session.jsonl` (agent transcript), `pi-cad/`
(state + events + records + evidence), `generated/` (STEP + source),
`cadtest/summary.json` (per-test detail), `stdout.log`/`stderr.log`.

## Bridge parity findings (Phase 2)

Full-partition A/B: official GPT-5.2 CadQuery code evaluated directly vs
the same geometry exported to STEP and re-imported through the bridge.
200/200 samples, 0 export failures. **Exact pass 96 → 94 (−2)**;
22 flipped tests of ~3 037 (0.7%): 13 lost, 9 gained.

Root causes (all documented in `results/parity/detailed/report.{json,md}`):

1. **Shell-based official models (3 samples, 6 tests)** — the official
   baseline itself produces Shell/Compound shapes (not valid solids).
   Direct evaluation sees an in-memory solid; STEP serialization exposes
   the shell structure (`solids=0`). This is a defect of the official
   baseline outputs, **not** of the bridge: Pi-CAD emits validated solids.
   Excluded from frozen sample sets; would be scored as-is if generated by
   Pi-CAD.
2. **STEP seam topology (1 sample, 4 tests)** — face/edge/vertex counts of
   an extruded hexagon change (8→12 faces) because STEP import splits
   periodic seams. Genuine STEP information loss, topology-category only;
   sample excluded from frozen sets.
3. **Tolerance-boundary volumetric flips (6 lost / 6 gained)** — symmetric
   noise around tolerance edges (e.g. shape factor exactly 1.0000), no
   systematic direction. Kept in sets; does not bias before/after
   comparisons since it is direction-symmetric.

**Verdict**: the bridge does not systematically change benchmark results
for valid-solid geometry; adapter noise is enumerated and excluded from
attribution.

## Metrics

Primary: exact task success (all CADTests passed), CADTest pass rate.
Per-category (topo/solid/dim/vol/space/geom) from evaluator
`category_breakdown`. Harness: artifact rate, workflow completion
(`state.json` phase/status), candidate commits, tool calls, error events.
Efficiency: input/cached/output tokens, wall time (from session JSONL
usage records).

## First regression cycle (Phases 5–8)

Baseline (commit `8c852ec`) → failure analysis → patch (`8fb170e`) →
paired regression, same frozen Diagnostic-20 / Luna Max / contract
(asserted identical by `compare.py`):

| metric | baseline | regression |
| --- | --- | --- |
| exact success | 18/20 | 18/20 |
| CADTests passed | 249/257 (96.9%) | 249/257 (96.9%) |
| harness completed | 18/20 | **20/20** |
| total cost | $0.598 | $0.466 |

* **Failure taxonomy** (baseline): 2× REQ-side DIM/GEOM (samples 00000960,
  00996457 — the agent misread "offset by X along the axis" as
  center-to-center distance; official GPT-5.2 fails 00000960 identically),
  2× HARNESS stalls (00000007, 00001490 — geometry already passing all
  CADTests).
* **Patch**: prompt-policy clarification of the autonomous decision boundary
  for `cad_wait_for_user` + maturity obligation warning on `cad_route`
  (production `src/core/controller.ts`, 97/97 TS tests pass). General
  guidance, no benchmark-specific hack.
* **Attribution**: zero score flips; the only changed outcome is that both
  stalled runs now close (12/12 and 14/14 CADTests, phase `done`), plus a
  22% cost reduction from not lingering in review.

Run bundle locations: `results/*_diag20-baseline/` (report.md,
failures.json), `results/*_diag20-regression/` (report.md,
comparison.md), `results/*_pilot5-luna-max/` (report.md).
