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
`cad_inspect_section`, `cad_measure`, `cad_compare_geometry`,
`cad_assembly_tree`, `cad_export`.

**Engineering analysis** — `cad_simulate`, `cad_optimize`,
`cad_generate_drawing`, `cad_render_scene`.

All four engineering tools take structured arguments (material, loads,
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

What V1 deliberately does not do: nonlinear materials, pressure/traction
loads, arbitrary CAD-face boundary conditions (a deterministic mesh-boundary
inspector is the planned next step), and multi-material parts. The tool
returns raw deterministic fields — it never says "safe" or "passes"; that
judgment belongs to the agent and to you.

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

Runtime capability checks (the "doctor" report) are a **live probe** of the
Python that would actually be used, honored once per session — not a stale
install-time snapshot.

## Tests & CI

```bash
npm test          # or: bash scripts/test.sh
```

31 TypeScript harness tests + 19 Python backend tests, including a
cantilever mesh-convergence check against beam theory, load/constraint
overlap semantics, negative validation matrices, evidence tampering, and
artifact-mutation races. CI runs the full suite on a fresh install (Linux
CPU) on every push.

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
| Spec templates | `assets/templates/` |

## Validation performed

Real end-to-end runs (with `openai-codex/gpt-5.6-luna`, thinking=medium):
quick plate build, read-only plate analysis, 5→4 mm plate modification with
compare evidence, greenfield pen stand, and a release handoff with honest
closed/blocked workstreams — all reaching `done` with evidence intact.

## License

MIT — see [LICENSE](LICENSE).
