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

> The original design rationale lives in [`pi-cad-whitepaper.md`](pi-cad-whitepaper.md).

---

## Quick start

```bash
git clone https://github.com/QiuYi111/pi-cad.git
cd pi-cad
npm install
```

`npm install` also builds the Python CAD runtime (a package-local venv with
build123d, gmsh, torch-fem, and friends). On headless Linux you will
additionally want the GLU runtime that gmsh links:

```bash
sudo apt-get install -y libglu1-mesa
```

Then launch Pi with the seven extensions:

```bash
pi -e src/extensions/core/index.ts \
   -e src/extensions/geometry/index.ts \
   -e src/extensions/visual/index.ts \
   -e src/extensions/drawing/index.ts \
   -e src/extensions/simulation/index.ts \
   -e src/extensions/presentation/index.ts \
   -e src/extensions/ui/index.ts
```

(When Pi-CAD is installed as a Pi package, the `pi` key in `package.json`
loads all seven automatically — no flags needed.)

## Your first part

Try this in a fresh directory:

```text
/cad
"Route a quick workflow: a 100 x 80 x 5 mm plate with four 6 mm through
holes, centers 10 mm from the edges."
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

## Seven workflows

Route with plain language ("analyze this STEP", "release the current head")
and Pi-CAD picks the workflow; you never manage run IDs.

| Workflow | Use it when |
| --- | --- |
| `quick` | The part is fully specified — just build it |
| `analyze` | You have a STEP and want a read-only diagnosis |
| `modify` | Controlled redesign of an existing part, with before/after compare |
| `greenfield` | New concept → intent → build, with optional domain analysis |
| `hybrid` | Merge a legacy baseline with a new concept |
| `convert` | Convert a source baseline to another format (e.g. STEP → STL) |
| `release` | Audit, close gaps, package, and hand off — with drawing/BOM workstreams |

## What the agent can actually do

**Control** — `cad_route`, `cad_commit_requirements`, `cad_commit_plan`,
`cad_commit_candidate`, `cad_transition`, `cad_wait_for_user`, `cad_finish`.
`cad_commit_candidate` runs the automatic observation loop: build → seven
visual views → geometry facts → deterministic compare (modify/convert) →
evidence bound to hashes → review.

**Geometry** — `cad_build_step`, `cad_inspect_visual`, `cad_inspect_geometry`,
`cad_inspect_surfaces`, `cad_inspect_section`, `cad_measure`,
`cad_compare_geometry`, `cad_assembly_tree`, `cad_export`.

**Engineering analysis** — `cad_simulate`, `cad_simulate_flow`,
`cad_simulate_thermal`, `cad_optimize`, `cad_generate_drawing`,
`cad_render_scene`.

All engineering tools take structured arguments (material, loads,
constraints, mesh, views, directions). You never point them at a spec file or
an output directory — the harness canonicalizes the spec into run-scoped
evidence storage itself, which is why even read-only review phases can run a
simulation without touching your project tree. Unknown physics, load types,
constraint types, regions, or a second material are rejected with an error,
not guessed.

## Simulation, honestly scoped

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
  a new geometry against last revision's simulation.
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
| `PI_CAD_PYTHON` | Use this Python binary for all cadctl calls |
| `PI_CAD_VENV` | Point installer and runtime at an existing virtualenv |
| `PI_CAD_SKIP_CUPY` | Skip the best-effort CuPy install (`1` to opt out) |
| `PI_CAD_SU2_BIN` | Use an external SU2_CFD binary for flow/thermal |
| `PI_CAD_SKIP_SU2` | Skip the optional SU2 runtime download (`1` to opt out) |
| `PI_CAD_SU2_RUNTIME` | Alternative root for the managed SU2 runtime |

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
| Harness core (state machine, policies, evidence) | `src/core/` |
| Tool extensions (geometry, visual, drawing, simulation, presentation, UI) | `src/extensions/` |
| Workflow definitions (all seven) | `src/workflows/` |
| Layered prompts | `src/prompts/` |
| Deterministic Python backend | `python/cadctl/` |
| SU2 interpreter (config compiler, mesh bridge, parsers) | `python/cadctl/simulation/su2_*.py` |
| Skills (thermal-fluid analysis) | `skills/` |
| Spec templates | `assets/templates/` |

## Validation performed

Real end-to-end runs (with `openai-codex/gpt-5.6-luna`, thinking=medium):
quick plate build, read-only plate analysis, 5→4 mm plate modification with
compare evidence, greenfield pen stand, and a release handoff with honest
closed/blocked workstreams — all reaching `done` with evidence intact.

## License

MIT — see [LICENSE](LICENSE).
