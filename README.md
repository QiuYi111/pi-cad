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

The `pi` manifest in `package.json` automatically loads all seven extensions
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
- **Obligations cannot be routed around.** Assembly routes owe their generated
  assembly-design and interface-contract records (the only exits from those
  phases) plus current-version assembly-tree and interference Evidence. A route change
  that only adds obligations applies autonomously and resumes at the
  earliest unmet phase; any downgrade requires a one-time authority token
  the harness issues only after a real user turn answers your question —
  an agent-claimed "user approved" never counts.

## The agent contract

The installed package contains a schema-1 `AgentContract` generated from the
active tool catalog, route compiler, phase contracts, events, and obligations.
The same build generates architecture/workflow references and six categorized
tool manuals. CI runs `generate-agent-contract --check`, so code/reference
drift is a build failure. The machine contract is shipped as
`assets/agent-contract.json`; `assets/cookbook-catalog.json` maps every public
tool to its cookbook, optional executable asset, and qualification gate.

At runtime Pi-CAD injects a compact **Current Action Card** with authoritative
route/phase/status, purpose, write scope, available tools, unmet records and
Evidence obligations, current bindings, legal events, guards, recommended
action, and only managed runtimes that probed ready. Normal operation depends
on installed skills, live tool schemas, and this card—not on reading `src/**`.
Illegal transitions return the same recovery information as structured data.

Probe results use immutable complete snapshots. The first screen is a bounded
semantic projection, not a semantic hard limit: faces, occurrences,
interference pairs, Python arrays/tables, and full failure logs are retained as
collections and can be filtered, ordered, and paged to exhaustion. Quota
exhaustion fails explicitly rather than silently dropping detail.

## Harness Kernel v7 and domain Recipes

New work defaults to the transactional v7 Kernel. The generic start action freezes the selected Workflow and Registry Contract; Mechanical routing is a Domain Pack action that replaces the intake snapshot. Active v6 runs remain on v6 and are never auto-migrated. Context providers read only bounded committed snapshots, while Project Head changes become visible only after a completed run is atomically promoted.

Simulation, optimization, drawing, presentation, and analysis-model derivation share one strict `pi-recipe.yaml` protocol. MODEL build/export and typed PROBE operations remain primitives. Each Recipe selects a named argv-form action, declares its exact closure and inputs, runs in a pinned profile, and produces immutable observer snapshots. Evidence-producing runs bind an exact workflow obligation before compute; commit can close only that binding.

### Code Mode compatibility and fast probes

Pi-CAD actions can also be called from `@howaboua/pi-codex-conversion` Code Mode. Direct and nested calls pass through the same v7 Workflow/Registry permission check; `exec`, `wait`, and `notebook` are containers, not authority. Conversion 3.0.19 needs the provider bridge installed once after the conversion package:

```bash
pi install npm:@howaboua/pi-codex-conversion
npm run setup:codex-conversion-compat
```

The setup is version-locked, idempotent, keeps a backup, and refuses unknown package layouts. Read-only `cadctl` observations reuse a bounded persistent Python worker by default, while mutations and Recipe compute remain one-shot/managed processes. Set `PI_CAD_PROBE_WORKER=0` only for diagnosis; compare local startup costs with `npm run benchmark:probe-worker`.

## Simulation, honestly scoped

Simulation V2 follows:

```text
author solver-native Recipe
→ managed compute
→ optional immutable re-observation
→ explicit case-scoped Evidence commit
```

Each new Recipe contains a strict `pi-recipe.yaml`, named managed actions,
an independently revisable observation program, explicit project inputs, and named exports using only
`image | scalar | timeseries | table | field | artifact`. Visual Recipes owe
a primary image and a primary quantitative export; nonvisual Recipes owe a
primary quantitative export. Omitted `outputs` selects the primary floor,
explicit names add to that floor, and `outputs=[]` is invalid.

The harness snapshots only the Recipe and declared inputs, runs without
network access in a pinned runtime, retains full logs and raw state outside
model context, and returns images before bounded quantitative summaries.
Changing only the observer closure creates a new immutable snapshot without rerunning
the solver. Every Observation stores the exact observer contract/files it ran,
their tree/file hashes, rendered plot hashes, and materialized exports, so an
older exact snapshot remains independently auditable and committable after a
later re-observation. Changing compute files or inputs requires a new run.
Legacy `pi-sim.toml` cases remain available through a read-only adapter while
the bundled benchmarks migrate; the adapter does not create a second runtime protocol.

Neither simulate nor observe creates Evidence. Commit verifies the exact run,
observation, runtime identity, declared inputs, current case obligation, and
authoritative artifact (or verified derivation). Evidence records provenance;
it does not assert that engineering requirements pass.

The schema-2 runtime registry declares four exact environments:

| Backend | Runtime | Intended use |
| --- | --- | --- |
| `openfoam` | `openfoam-14` | pinned `openfoam14@20260724`; transient and multiphase finite-volume work |
| `su2` | `su2-8.5.0` | SHA256-pinned official archive; steady flow and solid thermal work |
| `torch-fem` | `torch-fem-0.9-cu126` | production CUDA structural solves and optimization |
| `torch-fem` | `torch-fem-0.9-cpu` | explicit CI, debugging, and small cases only |

Bootstrap them inside native Linux or WSL with
`scripts/bootstrap-openfoam14.sh`, `scripts/bootstrap-su2-8.5.0.sh`, and
`scripts/bootstrap-torch-fem-runtimes.sh`. Under WSL, Pi-CAD, Node, `uv`,
Recipe entrypoints, and observers all run inside the same Linux distribution;
Windows-host Node and cross-host process/path translation are unsupported.
Entrypoints and observers use `uv run --offline --frozen` in the selected
immutable runtime.

Formal runs use bubblewrap, a user systemd scope, no network, read-only
runtime mounts, bounded CPU/RAM/PIDs/wall time, and a workspace quota. Runtime
identity covers installed files and versions. CUDA identity also includes the
driver/runtime, GPU model, VRAM, compute capability, PyTorch, CuPy, and a real
sparse-solve probe. UV runtime probes are declared by each registry entry, not
hard-coded into the generic runner. Trusted Solver health always exposes the
requested and actual accelerator in Observation context; Recipe health tables
cannot override it. The OpenFOAM qualification Recipe is under
`benchmarks/simulation-v2/openfoam14-box`.
The repository-owned SPEC-04 template under
`benchmarks/simulation-v2/spec04-template` includes its OpenFOAM case
generator, three-stage solver runner, convergence/robustness aggregation and
Rev1 release gate. Manufacturing CAD, materials, surface mapping and Rev1
criteria remain ignored authoritative inputs; if absent, it reports
`blocked_external` and cannot emit `SIMULATION_RELEASE_PASS`.

### Structural, thermal, and flow Recipes

There are no public typed physics wrappers. The unified Probe is the only probe
entry point, and every new simulation uses the Recipe-native lifecycle.
Physics, units, materials, loads, constraints, boundary conditions, meshing,
solver controls, and project metrics live in the Recipe.

The `structural-analysis` skill ships a torch-fem linear-elastic Recipe that
exports deformation/stress imagery, maximum displacement and von Mises,
reaction balance, fields, mesh/solver/accelerator health, and optional
differentiable sensitivity. The production runtime pins torch-fem 0.9.0,
PyTorch 2.13.0+cu126, CuPy 14.1.1, and Python 3.12. It verifies PyTorch CUDA,
CuPy device access, compute capability, and a real GPU sparse solve. Missing
or incompatible CUDA returns `unavailable`; CPU is never selected implicitly.
Production Evidence must report `actualDevice=cuda`.

The workflow state is currently schema 6. Simulation V2 introduced the clean
v5 transition; the later immutable-requirements revision advanced the shared
workflow schema to v6 without changing the Simulation Recipe or Observation
wire protocols.

The `thermal-fluid-analysis` skill ships SU2 steady-flow and solid-thermal
Recipe templates and explains when OpenFOAM is the better model. Templates
reuse the deterministic config compiler, mesher, parser, and visualization,
but require explicit surface mappings and physical inputs. SU2 is launched
only from `/opt/pi-cad-runtime/su2/8.5.0`; host PATH and binary environment
overrides are intentionally ignored.

The optimization operation runs the differentiable 2D SIMP/MMA skeleton in the managed
CUDA runtime by default. It produces optimization artifacts, not CAD and not
Simulation Evidence. Selecting CPU is explicit and binds a different runtime
identity.

The skill layers are `pi-cad` for workflow and evidence, `pi-cad-tools` for
the complete active tool catalog, and focused engineering skills for general
mechanical design, parametric modeling, assemblies, manufacturing, structural
analysis, and thermal-fluid analysis.

#### SU2 model contracts retained in Recipes

The two supplied SU2 Recipes compile explicit case data into solver configs
and translate native results into generic Observation exports. Geometry units
and every physical quantity remain explicit; no implicit mm→m conversion is
allowed to reach the solver.

- **Steady-flow Recipe** — single-zone CFD on an explicit watertight
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
- **Solid-thermal Recipe** — steady conduction with fixed-temperature
  and fixed-heat-flux boundaries, adiabatic remainder, constant
  conductivity. The 1D slab fixture is checked against `q = kAΔT/L` in CI.
  Boundary heat rates are labeled `reconstructedHeatRateW` because they are
  integrated from the solution's element gradients, not SU2's own
  conservative face fluxes.
- The Probe's surfaces preset — deterministic boundary-surface facts (type, area,
  centroid, bbox, normal/axis) plus labeled views. Surface IDs are geometric
  selectors valid for one artifact hash, never semantic labels: deciding
  which face is an inlet is the agent's job.

SU2 uses the official 8.5.0 "Harrier" archive with a pinned SHA256 and is
bootstrapped explicitly under `/opt/pi-cad-runtime`. Missing installation is
reported as `unavailable`; production execution never searches host PATH.

Solver support does not justify overclaiming model scope. Recipes and skills
must state unsupported nonlinear, multi-material, conjugate, combustion, or
turbomachinery assumptions when they matter. Tools return observations and
provenance; engineering judgment remains outside Core.

## Why you can trust the output

- **Acceptance requires evidence.** An artifact cannot be accepted without
  current visual and geometry evidence — plus simulation evidence when the
  requirements say it is required.
- **Evidence is tamper-evident.** Every evidence artifact is sha256-hashed,
  and the hashes are re-verified at acceptance and finish. A rewritten result
  file fails verification.
- **Simulation is explicit-commit only.** Solve and observe never create
  Evidence. Commit re-verifies the frozen Recipe, runtime identity, inputs,
  Observation, and authoritative artifact or derivation.
- **Declared simulation cases must actually run.** When requirements declare
  case-scoped obligations (for example `nozzle-outlet` through managed simulation),
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
| `PI_CAD_UV` | Override the Linux `uv` executable |
| `PI_CAD_ENABLE_DEV_RUNTIMES` | Advertise development-only runtimes such as explicit torch-fem CPU (`1`) |
| `CUDA_VISIBLE_DEVICES` | Select the CUDA device exposed to the managed runtime |
| `PI_CAD_BLENDER_BIN` | Use an external Blender binary for presentation |
| `PI_CAD_SKIP_BLENDER` | Skip the optional Blender runtime download (`1` to opt out) |
| `PI_CAD_BLENDER_RUNTIME` | Alternative root for the managed Blender runtime |

Blender remains a separate optional presentation runtime: a `blender` on
PATH wins, the manifest-pinned 4.5 LTS archive is
SHA256-verified, the download fails soft, and `cadctl doctor` reports the
capability honestly. When no Blender is available, the presentation renderer
returns an explicit `unavailable` — an honest evidence state, never a
substitute render.

Runtime qualification is performed outside the prompt path and persisted as
a registry-hash-bound availability record. The prompt path only reads that
bounded record (`ready` or `unknown`); `PI_CAD_REQUALIFY_RUNTIME=1` explicitly
forces a fresh qualification at execution time.

## Tests & CI

```bash
npm test          # or: bash scripts/test.sh
```

TypeScript protocol/harness tests and Linux `uv run` Python tests cover
strict manifests and paths, Observation materialization, explicit commit,
runtime limits, CUDA fail-closed behavior, structural refinement/balance and
sensitivity, SU2 analytic conduction and flow conservation, and OpenFOAM
qualification. Ordinary CI uses stubs or the explicitly selected CPU runtime;
production GPU qualification is never fabricated.

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

The generated route operation creates a run when the project is idle; finish and
`/cad-abort` clear it. The design head survives aborts. Legacy single-state
layouts are migrated automatically.

## Repository map

| Area | Path |
| --- | --- |
| Harness core (state machine, policies, evidence, context memory) | `src/core/` |
| Control plane (phase contracts: phase → capability grants) | `src/control/` |
| Observation layer (ObservationBundle/Renderer/Profiles) | `src/observations/` |
| Capability modules (MODEL / PROBE / SIMULATE) | `src/modules/` |
| Tool extensions (probe, geometry, drawing, simulation, presentation, UI) | `src/extensions/` |
| Skill routing, engineering references, and Recipe assets | `skills/` |
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
registry behind the unified Probe), SIMULATE
(`src/modules/simulate-v2` — Recipe/input freeze → managed compute → immutable
Observation snapshots → explicit Evidence commit). The Observation Layer (`src/observations`) normalizes every
backend envelope into visual-first agent observations, and the context
runtime (`src/core/observation-index.ts`) indexes them so post-compaction
observation recall can rehydrate engineering visuals and page complete detail.
Adding a CAD backend means implementing `ModelBackend`; adding an
observation means adding a probe preset — neither touches workflow code.

## Validation performed

Real end-to-end runs (with `openai-codex/gpt-5.6-luna`, thinking=medium):
quick plate build, read-only plate analysis, 5→4 mm plate modification with
compare evidence, greenfield pen stand, and a release handoff with honest
closed/blocked workstreams — all reaching `done` with evidence intact.

## License

MIT — see [LICENSE](LICENSE).
