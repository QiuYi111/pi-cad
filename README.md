# Pi-CAD

Harness-native agentic mechanical CAD on Pi, implemented from
`pi-cad-whitepaper.md`.

> Tools expose reality. Agent interprets reality. Workflow defines process.
> Harness enforces workflow. Skills improve reasoning.

## Implemented architecture

| Layer | Path |
| --- | --- |
| Pi-CAD core harness | `src/core/` + `src/extensions/core/index.ts` |
| Geometry tools | `src/extensions/geometry/index.ts` |
| Visual/section tools | `src/extensions/visual/index.ts` |
| Read-only UI/status | `src/extensions/ui/index.ts` |
| Optional drawing plugin | `src/extensions/drawing/index.ts` |
| Optional simulation plugin | `src/extensions/simulation/index.ts` |
| Optional presentation plugin | `src/extensions/presentation/index.ts` |
| Optional aggregate entry | `src/extensions/optional/index.ts` |
| Project store / task store | `src/shared/store.ts` (`CadProjectStore`, `CadTaskStore`) |
| Shared protocol/state/capability | `src/shared/` |
| Workflow data modules | `src/workflows/{quick,analyze,modify,greenfield,hybrid,convert,release}.ts` |
| Layered state prompts | `src/prompts/` |
| Deterministic Python backend | `python/cadctl/` |
| Spec templates | `assets/templates/` |

`cad-core` is deliberately not a God Object:

```text
src/core/
├── runtime.ts          # Pi lifecycle glue
├── controller.ts       # cad_* control-action tools
├── state-machine.ts    # data-driven workflow engine
├── policies.ts         # mutation / active-tool policy
├── auto-actions.ts     # baseline/candidate observation loop
├── continuation.ts     # agent_settled auto-resume
├── context.ts          # layered prompt composition
└── evidence.ts         # hash binding, stale tracking, file guards
```

## Workflows

- `quick` — fully specified direct geometry
- `analyze` — read-only STEP/CAD diagnosis
- `modify` — baseline, plan, controlled redesign, before/after compare
- `greenfield` — concept, optional domain analysis, intent, build
- `hybrid` — legacy baseline plus greenfield concept merge
- `convert` — source baseline, transform plan, conversion, compare
- `release` — audit → writable gap closure (engineering changes + candidate loop) → audit → package → final review, with nine workstream statuses

## Control protocol

```text
cad_route
cad_commit_requirements
cad_commit_plan
cad_commit_candidate
cad_transition
cad_wait_for_user
cad_finish
```

`cad_commit_candidate` owns the automatic loop:
build → visual views → geometry facts → (modify/convert) deterministic compare
→ evidence bound to source/artifact hashes → review.

## Deterministic capability tools

```text
cad_build_step              cad_inspect_visual
cad_inspect_geometry        cad_inspect_section
cad_measure                 cad_compare_geometry
cad_assembly_tree           cad_export
cad_generate_drawing        cad_simulate
cad_optimize                cad_render_scene
```

`cad_simulate` uses the torch-fem linear elasticity backend with gmsh STEP
meshing. `cad_optimize` runs a differentiable SIMP topology optimization with
an NLopt MMA inner loop; its output is density/surface evidence and never
updates Project Head directly.

### Evidence obligations

`cad_commit_requirements` / `cad_commit_plan` accept:

```json
{
  "evidenceObligations": {
    "simulation": {
      "disposition": "required",
      "rationale": "strength controls acceptance"
    }
  }
}
```

When `simulation.disposition = required`, `cad_transition(accepted)` and
`cad_finish` require current-artifact simulation evidence. In the analyze
workflow the obligation binds to the baseline artifact instead of a new
candidate. Candidate changes stale the old simulation automatically.

`cad_simulate`, `cad_optimize`, `cad_generate_drawing`, and `cad_render_scene`
take structured arguments (material, loads, constraints, mesh, views,
directions); the harness canonicalizes them into a run-scoped
`evidence/<kind>/<id>/spec.json` and rejects unknown physics, load types,
constraint types, regions, and multi-material specs instead of guessing. No
tool exposes a spec path or output directory to the agent, so read-only phases
can produce evidence without project-tree mutation.

V1 simulation boundary conditions are deliberately simple: an `axis+side`
region selects the axis-extreme node slab (all nodes within 0.75× mesh size of
the bounding-box extreme), and `indices` selects explicit mesh nodes. This is
not arbitrary STEP face selection; a deterministic mesh-boundary inspector for
surface-level BCs is planned as the next capability. Simulation evidence for
the same artifact is identified by spec hash, so multiple load cases (normal,
peak, shock) coexist instead of overwriting each other.

Unavailable optional backends are returned explicitly (`simulation.run`,
Blender/FFmpeg presentation, PDF drawing, standards-compliant GD&T). The
harness never substitutes a fake verifier or upgrades unavailable evidence.

## Python backend setup

The Pi package postinstall installs a package-local Python runtime
automatically (`scripts/postinstall.mjs`):

- prefers `uv` / `python -m venv`;
- falls back to `.python/site-packages` when system ensurepip is unavailable;
- installs core CAD and simulation dependencies;
- installs the CuPy wheel matching torch's bundled CUDA when torch reports
  CUDA support (best-effort; CPU-only hosts skip it, and a failed install
  downgrades CUDA simulation to the honest CPU fallback rather than breaking
  the install — set `PI_CAD_SKIP_CUPY=1` to opt out);
- writes `.pi-cad-runtime.json` from `cadctl doctor --json`.

Headless Linux hosts also need `libglu1-mesa` (the gmsh wheel's bundled
library dlopens `libGLU.so.1`): `sudo apt-get install -y libglu1-mesa`.

For a repository checkout without running package install:

```bash
scripts/bootstrap-python.sh
```

Set `PI_CAD_PYTHON` to override the Python binary used by the harness, or
`PI_CAD_VENV` to point both installer and runtime at an existing virtualenv.

## Test

```bash
npm install
npm run test
# or
bash scripts/test.sh
```

Coverage:

- pure workflow state machine: all seven workflows
- harness integration: quick candidate loop, convert candidate loop
- mutation policy, evidence guards, restart recovery
- Python backend: STEP build/inspect/render/section/compare/assembly/export/drawing/capability

## Run in Pi

```bash
pi -e src/extensions/core/index.ts \
   -e src/extensions/geometry/index.ts \
   -e src/extensions/visual/index.ts \
   -e src/extensions/drawing/index.ts \
   -e src/extensions/simulation/index.ts \
   -e src/extensions/presentation/index.ts \
   -e src/extensions/ui/index.ts
```

When installed as a Pi package, the `pi` key in `package.json` loads all
seven extensions automatically.

Use `/cad` to show the workspace, `/cad-status` for canonical state, and
`/cad-abort` to abort only the active workflow run. `cad_route` creates a run
implicitly when the project is IDLE; users do not manage task IDs.

## Canonical project state

A working directory is a long-lived **design project**. Workflow activity is
stored as short-lived **runs**.

```text
.pi-cad/
├── project.json            # projectId + current design head + currentRunId
├── runs/
│   ├── run-20260817-001/
│   │   ├── state.json
│   │   ├── events.jsonl
│   │   ├── records/
│   │   ├── evidence/
│   │   └── artifacts/manifest.json
│   └── run-20260817-002/
│       └── ...
└── artifacts/              # optional future project-level package area
```

- `project.json.head` is the current design: source/STEP/hash + accepted evidence.
- `project.json.currentRunId` is `null` in the normal IDLE state.
- `cad_route` creates a run when the project is IDLE.
- `cad_transition(accepted)` updates the design head for design-producing workflows.
- `cad_finish` and `/cad-abort` clear `currentRunId`; the head remains intact.
- Legacy task/single-state layouts are migrated into runs automatically.

## Real-model validation performed

With `openai-codex/gpt-5.6-luna` (`thinking=medium`):

- `quick` plate: 100×80×5, four Ø6 holes, delivered STEP + source, state done.
- `analyze` plate inspection: read-only, verified all dimensions, state done.
- `modify` old plate: 5 mm → 4 mm height, holes preserved, compare evidence, state done.
- `greenfield` pen stand: concept → intent → build → review, STEP + source, state done.
- `release` plate supplier handoff: workstreams closed/blocked honestly, state done.

`convert` is covered by harness integration tests (STEP → STL sidecar), and
all seven workflows are covered by pure state-machine tests.
