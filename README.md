# Pi-CAD

**Agentic mechanical CAD that shows its work.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml/badge.svg)](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Pi-CAD is a mechanical CAD harness for the
[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
An AI agent designs the part, runs the numbers, and walks your engineering
review — but every claim it makes is backed by files you can open, images you
can look at, and hashes that fail loudly if anything changes.

It is built on one simple split of responsibility:

- **Deterministic tools do the geometry and the physics.** build123d/OCP for
  CAD, gmsh for meshing, torch-fem for linear elasticity, NLopt for
  topology optimization. No LLM ever decides a dimension or blesses a stress
  plot.
- **The agent interprets reality** — it reads the fields, the views, and the
  geometry facts, then argues for a design decision in plain language.
- **A state machine enforces the process.** Review cannot be skipped,
  read-only phases cannot mutate the project, and acceptance without
  evidence is structurally impossible.
- **Evidence is hash-bound.** Specs, results, fields, and rendered views are
  stored per run, hashed, and re-verified at every acceptance. Tampered or
  stale evidence is rejected, never silently reused.

> The original design rationale lives in the refactor docs:
> [`refactor/pi-cad-refactoring-whitepaper.md`](refactor/pi-cad-refactoring-whitepaper.md)
> (vision) and [`refactor/pi-cad-engineering-design-v2.md`](refactor/pi-cad-engineering-design-v2.md)
> (implementation plan).

---

## Quick start

Pi-CAD is a Pi package. On headless Debian/Ubuntu systems, install the GLU
runtime used by gmsh, then let Pi clone the package, install its Node
dependencies, and run the package `postinstall` bootstrap for the Python CAD
runtime:

```bash
sudo apt-get install -y libglu1-mesa
pi install git:github.com/QiuYi111/pi-cad
pi list
```

The `pi` manifest in `package.json` automatically loads all eight extensions
and the bundled skills on the next Pi launch; no `-e` flags are needed.

For a development checkout, install dependencies in the checkout and register
that directory as a user package:

```bash
git clone https://github.com/QiuYi111/pi-cad.git
cd pi-cad
npm install
pi install .
pi list
```

Local-package installation links the checkout rather than copying it, so source
changes are picked up on the next Pi launch. Re-run `npm install` only when
dependencies or the Python runtime bootstrap change.

For a one-off launch without installing the package, load the extensions
explicitly:

```bash
pi -e src/extensions/core/index.ts \
   -e src/extensions/probe/index.ts \
   -e src/extensions/geometry/index.ts \
   -e src/extensions/visual/index.ts \
   -e src/extensions/drawing/index.ts \
   -e src/extensions/simulation/index.ts \
   -e src/extensions/presentation/index.ts \
   -e src/extensions/ui/index.ts
```

## Your first part

Try this in a fresh directory:

```text
/cad
"Design a 100 x 80 x 5 mm plate with four 6 mm through holes, centers
10 mm from the edges."
```

The agent will route the run, commit requirements, build the STEP file, and
then — before it can say anything — the harness automatically renders seven
visual views and extracts geometry facts as evidence, bound to the exact
source and artifact hashes. The images come back to you in the conversation.
Review them, ask for changes, and accept:

```text
"Looks good — accept and finish."
```

Useful slash commands:

| Command | What it does |
| --- | --- |
| `/cad` | Show the workspace: project, design head, active run |
| `/cad-status` | Canonical run state, phase, and evidence |
| `/cad-abort` | Abort the active run only; the project head is untouched |

## Routes, not workflows

Routing is a hierarchical description the agent decides in one turn and
the harness compiles a process from — there is no shortcut to select:

```
route = objective × lineage × structure × maturity
        analyze | convert | design
                        greenfield | legacy | hybrid
                                     part | assembly
                                          prototype | engineering | manufacturing | release
```

| Route (examples) | Compiled process |
| --- | --- |
| `design/greenfield/part/engineering` | requirements → part_design → build → review (the fast path, *derived*) |
| `design/legacy/part/engineering` | requirements → baseline → plan → modify → review, with before/after compare |
| `design/greenfield/assembly/engineering` | requirements → system_concept → assembly_design → interface_design → part_design → build → integration_review |
| `design/*/release` | baseline (if any) → audit → gap_closure → package → final_review over nine workstreams |
| `analyze` | baseline → investigate → explain (read-only) |
| `convert` | source_baseline → transform_plan → convert → compare |

Two 0.8 rules matter more than the table:

- **Maturity is a reality floor, not a mood.** Prototype means REAL,
  BUILDABLE, FUNCTIONAL. Maturity only *adds* obligations (manufacturing
  requires drawing evidence; release adds workstreams and presentation
  deliverables) — it never buys a shorter process.
- **Obligations cannot be routed around.** Assembly routes owe
  `cad_commit_assembly_design` and `cad_commit_interface_contracts`
  records (they are the only exits from their phases) plus current-version
  assembly-tree and interference evidence. A mid-process `cad_reroute`
  that only adds obligations applies autonomously and resumes at the
  earliest unmet phase; any downgrade requires a one-time authority token
  the harness issues only after a real user turn answers your question —
  an agent-claimed "user approved" never counts.

## What the agent can actually do

**Control** — `cad_route`, `cad_reroute`, `cad_commit_requirements`,
`cad_commit_plan`, `cad_commit_assembly_design`,
`cad_commit_interface_contracts`, `cad_commit_candidate`, `cad_transition`,
`cad_wait_for_user`, `cad_finish`. `cad_commit_candidate` runs the automatic
observation loop: build → seven visual views → geometry facts →
assembly-tree + interference (assembly routes) → deterministic compare
(legacy/release) → evidence bound to hashes → review.

**Geometry** — `cad_build_step`, `cad_inspect_visual`, `cad_inspect_geometry`,
`cad_inspect_surfaces`, `cad_inspect_section`, `cad_scan_sections`,
`cad_measure`, `cad_compare_geometry`, `cad_assembly_tree`,
`cad_inspect_interference`, `cad_export`.

**Engineering analysis** — Recipe-native `cad_simulate`,
`cad_sim_observe`, `cad_commit_simulation`, plus `cad_optimize`,
`cad_generate_drawing`, and `cad_render_scene`. The former typed structural,
flow, and thermal tools remain deprecated compatibility wrappers.

Simulation V2 takes only `backend`, `runtime`, a Recipe directory, and
optional opaque output names. Physics, materials, boundaries, meshing, and
project-specific metrics live in the solver-native Recipe, never in Pi-CAD's
tool schema. Drawing, optimization, and presentation retain their own typed
contracts.

## Simulation, honestly scoped

Simulation V2 follows:

```text
author solver-native Recipe
→ cad_simulate
→ optional cad_sim_observe
→ cad_commit_simulation
```

Each Recipe contains a strict `pi-sim.toml`, an arbitrary managed entrypoint,
an observation program, explicit project inputs, and named exports using only
`image | scalar | timeseries | table | field | artifact`. Visual Recipes owe
a primary image and a primary quantitative export; nonvisual Recipes owe a
primary quantitative export. Omitted `outputs` selects the primary floor,
explicit names add to that floor, and `outputs=[]` is invalid.

The harness snapshots only the Recipe and declared inputs, runs without
network access in a pinned runtime, retains full logs and raw state outside
model context, and returns images before bounded quantitative summaries.
Changing observation files creates a new immutable snapshot without rerunning
the solver. Changing compute files or inputs requires a new run.
Materialized file exports are interned under the run's `objects/sha256/`
store; unchanged large fields are hard-linked to the same immutable object,
with copy/reflink fallback when hard links are unavailable.

Neither simulate nor observe creates Evidence. Commit verifies the exact run,
observation, runtime identity, declared inputs, current case obligation, and
authoritative artifact (or verified derivation). Evidence records provenance;
it does not assert that engineering requirements pass.

The first managed runtime is `backend=openfoam`, `runtime=openfoam-14`, pinned
to `openfoam14@20260724`. Bootstrap it inside Linux/WSL with
`scripts/bootstrap-openfoam14.sh`. Unit CI uses a stub runtime; the real
qualification Recipe is under `benchmarks/simulation-v2/openfoam14-box`.
The repository-owned SPEC-04 template under
`benchmarks/simulation-v2/spec04-template` includes its OpenFOAM case
generator, three-stage solver runner, convergence/robustness aggregation and
Rev1 release gate. Manufacturing CAD, materials, surface mapping and Rev1
criteria remain ignored authoritative inputs; if absent, it reports
`blocked_external` and cannot emit `SIMULATION_RELEASE_PASS`.

### Deprecated typed compatibility tools

What V1 does well:

- **Linear elastic FEA** with torch-fem, gmsh tet meshing of STEP, or a
  parametric box mesh. Units are pinned: mm / N / MPa.
- **Boundary conditions you can reason about**: nodal force loads that
  *add* when they overlap, fixed constraints that *union* when they overlap.
  Regions select the axis-extreme node slab or explicit node indices.
- **Readable results**: seven rendered views (displacement, von Mises,
  deformed shape…), full fields in NPZ, and a result JSON with reaction
  equilibrium, mesh provenance, and device fallback reasons.
- **Multiple load cases coexist**: normal, peak, and shock load cases on the
  same part are kept side by side, keyed by spec hash.
- **Devices, honestly**: CPU is first-class; CUDA is used when a matching
  CuPy is present; Metal reports an explicit CPU fallback. Nothing pretends.

### Thermal & flow (SU2)

`cad_simulate_flow` and `cad_simulate_thermal` compile canonical specs into
SU2 runs and translate the results back into canonical evidence. The unit
rule is frozen and explicit in the field names: CAD geometry is interpreted
per `geometryUnits` (mm by default) and every physical quantity is SI
(`totalPressurePa`, `temperatureK`, `maxSizeMm`, …) — no implicit mm→m ever
reaches the solver.

- `cad_simulate_flow` — steady single-zone CFD on an explicit watertight
  fluid-domain STEP: compressible Euler, compressible RANS (SA/SST),
  incompressible Navier–Stokes/RANS. Every boundary surface must be
  classified exactly once (total-conditions inlet, pressure outlet, walls);
  results include convergence, per-surface area-weighted means, mass
  balance, raw fields, and views. A converged nozzle run reaches the
  isentropic-table outlet Mach within a few percent.
- **No hidden fluid properties.** Viscous solvers require an explicit
  `fluid.viscosity` contract (constant μ, or Sutherland with your own
  constants); the Reynolds initialization scale is derived from exactly the
  declared model — nothing defaults to air.
- **Convergence is execution validity, not judgment.** A run that does not
  declare and meet its `residualTarget` returns `status=not_converged`:
  raw fields are still shown for diagnosis, but the run creates **no**
  simulation evidence and cannot close a required case.
- `cad_simulate_thermal` — steady solid heat conduction: fixed-temperature
  and fixed-heat-flux boundaries, adiabatic remainder, constant
  conductivity. The 1D slab fixture is checked against `q = kAΔT/L` in CI.
  Boundary heat rates are labeled `reconstructedHeatRateW` because they are
  integrated from the solution's element gradients, not SU2's own
  conservative face fluxes.
- `cad_inspect_surfaces` — deterministic boundary-surface facts (type, area,
  centroid, bbox, normal/axis) plus labeled views. Surface IDs are geometric
  selectors valid for one artifact hash, never semantic labels: deciding
  which face is an inlet is the agent's job.

SU2 ships as an optional pinned runtime (official 8.5.0 "Harrier"
precompiled builds, SHA256-verified) under `.runtime/su2/`; the download
fails soft and `cadctl doctor` reports the capability honestly. Set
`PI_CAD_SU2_BIN` to use your own binary or `PI_CAD_SKIP_SU2=1` to opt out.
A `thermal-fluid-analysis` skill describes how to formulate and interpret
this evidence without pretending to teach the model CFD.

What V1 deliberately does not do: nonlinear materials, pressure/traction
loads, multi-material structural parts, CHT/multi-zone, transient flow,
combustion, or turbomachinery features. The tools return raw deterministic
fields — they never say "safe", "passes", or "works"; that judgment belongs
to the agent and to you.

`cad_optimize` is a clearly-labeled walking skeleton: differentiable SIMP
topology optimization (2D rectangular domain, MMA inner loop) whose output is
density/surface evidence, never a CAD candidate.

## Why you can trust the output

- **Acceptance requires evidence.** An artifact cannot be accepted without
  current visual and geometry evidence — plus simulation evidence when the
  requirements say it is required.
- **Evidence is tamper-evident.** Every evidence artifact is sha256-hashed,
  and the hashes are re-verified at `cad_transition(accepted)` and
  `cad_finish`. A rewritten result file fails verification.
- **Simulation binds to the pre-solve artifact hash.** If the STEP file
  changes while the solver is running, the result is discarded rather than
  bound to the wrong version.
- **Evidence inputs are re-verified too.** Flow/thermal evidence carries its
  hash-bound inputs (canonical spec, product artifact, fluid domain) and
  `cad_transition(accepted)` / `cad_finish` re-hash them; rewriting the
  fluid-domain STEP after the solve invalidates the evidence just like
  rewriting a result file.
- **Unconverged runs are not evidence.** The interpreter decides execution
  validity: runs that miss their declared residual target (or declare none)
  return raw fields under `status=not_converged` and the harness records
  nothing from them.
- **Declared simulation cases must actually run.** When requirements declare
  case-scoped obligations (e.g. `nozzle-outlet` via `cad_simulate_flow`),
  acceptance and finish stay blocked until each case produced current-version
  evidence from the declared tool — a structural FEA run cannot close a flow
  case. The harness compares opaque identities only; it never interprets the
  physics.
- **Candidate changes stale old evidence automatically.** You cannot accept
  a new geometry against last revision's simulation or interference facts.
- **The canonical design is never rewritten for solvers.** When a
  simulation consumes a derived model (fused/bonded/simplified), the spec
  must declare `analysisModel {source, operations}`; the evidence then
  binds to the authoritative design while the derived copy stays a
  hash-bound input. An undeclared derived subject fails closed, and fake
  provenance (a "source" that is not a canonical artifact) fails too.
- **Assembly reality is observed, not assumed.** Every assembly candidate
  auto-records an assembly tree and pairwise interference facts
  (penetration/contact/clearance with volumes and distances — never a
  pass/fail), and integration review cannot accept without them.
- **Release presentation is hash-bound.** The Blender interpreter renders
  from the Assembly Definition (hero/exploded stills, turntable and
  assembly animation) and writes a manifest binding the subject artifact
  hash, spec hash, renderer settings, and every output sha256; release
  closure verifies the required deliverables exist in current evidence.
- **Unavailable backends say so.** Missing Blender, PDF drawing, or GD&T
  support is reported as unavailable — the harness never substitutes a fake
  verifier.
- **Plays well with other plugins.** Pi-CAD manages only its own `cad_*`
  tools, as a phase overlay on the session's active tool set — it never
  uninstalls or re-activates another extension's tools, and phase policy is
  enforced at call time, not merely by hiding tools.

## Configuration

| Variable | Effect |
| --- | --- |
| `PI_CAD_UV` | Override the `uv` executable on native Linux |
| `PI_CAD_WSL_DISTRO` | WSL distribution used by a Windows Node host (default `Ubuntu`) |
| `PI_CAD_VENV` | Point installer and runtime at an existing virtualenv |
| `PI_CAD_SKIP_CUPY` | Skip the best-effort CuPy install (`1` to opt out) |
| `PI_CAD_SU2_BIN` | Use an external SU2_CFD binary for flow/thermal |
| `PI_CAD_SKIP_SU2` | Skip the optional SU2 runtime download (`1` to opt out) |
| `PI_CAD_SU2_RUNTIME` | Alternative root for the managed SU2 runtime |
| `PI_CAD_BLENDER_BIN` | Use an external Blender binary for presentation |
| `PI_CAD_SKIP_BLENDER` | Skip the optional Blender runtime download (`1` to opt out) |
| `PI_CAD_BLENDER_RUNTIME` | Alternative root for the managed Blender runtime |

Blender follows the same optional-pinned-runtime contract as SU2: a
`blender` on PATH always wins, the manifest-pinned 4.5 LTS archive is
SHA256-verified, the download fails soft, and `cadctl doctor` reports the
capability honestly. When no Blender is available, `cad_render_scene`
returns an explicit `unavailable` — an honest evidence state, never a
substitute render.

Runtime capability checks (the "doctor" report) are a **live probe** of the
Python that would actually be used, honored once per session — not a stale
install-time snapshot.

## Tests & CI

```bash
npm test          # or: bash scripts/test.sh
```

TypeScript harness tests + Python backend tests, including a cantilever
mesh-convergence check against beam theory, load/constraint overlap
semantics, negative validation matrices, evidence tampering,
artifact-mutation races, an SU2 1D-conduction slab against `q = kAΔT/L`,
and a supersonic-nozzle flow smoke case (convergence, mass balance,
isentropic-ballpark outlet Mach). SU2 cases skip themselves when the
optional runtime is unavailable. CI runs the full suite on a fresh install
(Linux CPU) on every push.

## What lives on disk

A working directory is a long-lived **design project**; each workflow
activity is a short-lived **run**:

```text
.pi-cad/
├── project.json      # design head: current source/STEP/hashes + accepted evidence
└── runs/
    └── run-.../      # state, events, records,
                      └── evidence/<kind>/<id>/   # spec.json + results + views
```

`cad_route` creates a run when the project is idle; `cad_finish` and
`/cad-abort` clear it. The design head survives aborts. Legacy single-state
layouts are migrated automatically.

## Repository map

| Area | Path |
| --- | --- |
| Harness core (state machine, policies, evidence, context memory) | `src/core/` |
| Control plane (phase contracts: phase → capability grants) | `src/control/` |
| Observation layer (ObservationBundle/Renderer/Profiles) | `src/observations/` |
| Capability modules (MODEL / PROBE / SIMULATE) | `src/modules/` |
| Tool extensions (probe, geometry, visual, drawing, simulation, presentation, UI) | `src/extensions/` |
| Route ontology + workflow compiler | `src/shared/route.ts`, `src/workflows/compiler.ts` |
| Layered prompts | `src/prompts/` |
| Deterministic Python backend | `python/cadctl/` |
| SU2 interpreter (config compiler, mesh bridge, parsers) | `python/cadctl/simulation/su2_*.py` |
| Interference & section interpreters | `python/cadctl/interference.py`, `python/cadctl/sections.py` |
| Blender presentation interpreter | `python/cadctl/presentation.py`, `presentation_driver.py` |
| Skills (thermal-fluid analysis, assembly design) | `skills/` |
| Spec templates | `assets/templates/` |
| Refactor plan + review (runtime-v2 architecture) | `refactor/` |

### Runtime architecture (v2)

Control Plane (`src/control` phase contracts + `src/core` state machine)
decides what is allowed and required. Capability modules decide how
engineering computation runs: MODEL (`src/modules/model` — ModelBackend
adapters, candidate finalizer), PROBE (`src/modules/probe` — preset
registry behind the unified `cad_probe` tool), SIMULATE
(`src/modules/simulate` — shared spec-freeze → solve → observe
lifecycle). The Observation Layer (`src/observations`) normalizes every
backend envelope into visual-first agent observations, and the context
runtime (`src/core/observation-index.ts`) indexes them so post-compaction
recall (`cad_recall_observation`) can rehydrate engineering visuals.
Adding a CAD backend means implementing `ModelBackend`; adding an
observation means adding a probe preset — neither touches workflow code.

## Validation performed

Real end-to-end runs (with `openai-codex/gpt-5.6-luna`, thinking=medium):
quick plate build, read-only plate analysis, 5→4 mm plate modification with
compare evidence, greenfield pen stand, and a release handoff with honest
closed/blocked workstreams — all reaching `done` with evidence intact.

## License

MIT — see [LICENSE](LICENSE).
