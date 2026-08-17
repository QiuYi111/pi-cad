# Pi-CAD

Harness-native agentic mechanical CAD on Pi, implemented from
`pi-cad-whitepaper.md`.

> Tools expose reality. Agent interprets reality. Workflow defines process.
> Harness enforces workflow. Skills improve reasoning.

## Implemented architecture

| Layer | Path |
| --- | --- |
| Pi-CAD core harness | `src/extensions/core/index.ts` |
| Geometry tools | `src/extensions/geometry/index.ts` |
| Visual/section tools | `src/extensions/visual/index.ts` |
| Drawing plugin | `src/extensions/drawing/index.ts` |
| Simulation plugin | `src/extensions/simulation/index.ts` |
| Presentation plugin | `src/extensions/presentation/index.ts` |
| Read-only UI/status | `src/extensions/ui/index.ts` |
| Shared protocol/state/capability | `src/shared/` |
| Workflow registry | `src/workflows/registry.ts` |
| Layered state prompts | `src/prompts/` |
| Deterministic Python backend | `python/cadctl/` |
| Spec templates | `assets/templates/` |

## Workflows

- `quick` — fully specified direct geometry
- `analyze` — read-only STEP/CAD diagnosis
- `modify` — baseline, plan, controlled redesign, before/after compare
- `greenfield` — concept, optional domain analysis, intent, build
- `hybrid` — legacy baseline plus greenfield concept merge
- `convert` — source baseline, transform plan, conversion, compare
- `release` — audit, gap closure, package, final review with nine workstream statuses

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
cad_generate_drawing        cad_run_simulation
cad_render_scene
```

Unavailable optional backends are returned explicitly (`simulation.run`,
Blender/FFmpeg presentation, PDF drawing, standards-compliant GD&T). The
harness never substitutes a fake verifier or upgrades unavailable evidence.

## Python backend setup

```bash
scripts/bootstrap-python.sh
```

The bootstrap prefers `.venv`; on systems without ensurepip it installs into
repository-local `.python/site-packages`. Set `PI_CAD_PYTHON` to override the
Python binary used by the harness.

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

Use `/cad` to activate, or let the Agent call `cad_route` from intake.
Use `/cad-status` for the canonical state and `/cad-abort` to abort.

## Canonical project state

```text
.pi-cad/
├── task.json / state.json
├── events.jsonl
├── records/
├── evidence/{visual,geometry,compare,section,drawing,fea,presentation}
└── artifacts/manifest.json
```

State persists across session restart and is the only workflow authority.
Session entries and UI are projections of `.pi-cad/state.json`.

## Real-model validation performed

With `openai-codex/gpt-5.6-luna` (`thinking=medium`):

- `quick` plate: 100×80×5, four Ø6 holes, delivered STEP + source, state done.
- `analyze` plate inspection: read-only, verified all dimensions, state done.
- `modify` old plate: 5 mm → 4 mm height, holes preserved, compare evidence, state done.
- `greenfield` pen stand: concept → intent → build → review, STEP + source, state done.
- `release` plate supplier handoff: workstreams closed/blocked honestly, state done.

`convert` is covered by harness integration tests (STEP → STL sidecar), and
all seven workflows are covered by pure state-machine tests.
