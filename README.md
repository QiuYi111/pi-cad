# Pi-CAD V0 Walking Skeleton

This repository implements the V0 walking skeleton described in
`pi-cad-whitepaper.md` §17: **Quick workflow only**, with a real deterministic
build123d/STEP backend and Pi harness control.

## What V0 contains

| Layer | Path |
| --- | --- |
| Pi-CAD core harness | `src/extensions/core/index.ts` |
| Geometry tools (`cad_build_step`, `cad_inspect_geometry`, `cad_measure`) | `src/extensions/geometry/index.ts` |
| Visual tool (`cad_inspect_visual`) | `src/extensions/visual/index.ts` |
| Shared protocol / state / capability runner | `src/shared/` |
| Quick workflow state machine | `src/workflows/quick.ts` |
| Layered state prompts | `src/prompts/` |
| Deterministic Python backend | `python/cadctl/` |

## Workflow

```text
/cad  (or cad_route)
Intake -> Requirements -> Build -> Review -> Ready -> Done
```

- Agent calls `cad_route(quick)`.
- Agent calls `cad_commit_requirements`.
- Agent writes `models/*.py` and calls `cad_commit_candidate`.
- Harness automatically runs `build -> inspect_visual -> inspect_geometry`,
  binds evidence to current artifact/source hashes, and enters REVIEW.
- Agent reviews the images, calls `cad_measure` for critical facts, then
  `cad_transition(accepted)` and `cad_finish`.

## Python backend setup

The checked-in V0 test environment uses a private `.python/site-packages`.
For a normal machine:

```bash
python3 -m venv .venv
.venv/bin/pip install -r python/requirements.txt
# or
.venv/bin/pip install -e python
```

Set `PI_CAD_PYTHON` to override the Python binary used by the harness.

## Smoke test

```bash
# Python backend
python3 -m pip install -r python/requirements.txt   # with your preferred env
PYTHONPATH=.python/site-packages:python python3 -m cadctl --help

# Harness unit tests (state machine, persistence)
node tests/run-ts-tests.mjs

# Backend integration tests
PYTHONPATH=.python/site-packages:python python3 -m unittest discover -s tests -p 'test_*.py'
```

## Load in Pi

```bash
pi -e src/extensions/core/index.ts \
   -e src/extensions/geometry/index.ts \
   -e src/extensions/visual/index.ts
```

When the package is installed as a Pi package, the `pi` key in `package.json`
loads all three extensions automatically.

## V0 acceptance criteria

1. `/cad` or CAD flow activation — implemented by `/cad` and `cad_route`.
2. Agent must explicitly route — `cad_route(quick)` is a blocking tool action.
3. Quick requirements can commit with zero extra questions.
4. Agent does not run the old `scripts/step -> snapshot -> inspect` chain.
5. `cad_commit_candidate` auto-builds, renders, and inspects.
6. Review views are bound to the current artifact hash.
7. Source changes mark old evidence stale.
8. Agent can query geometry with `cad_measure`.
9. Harness blocks illegal transitions.
10. `cad_finish` fails unless READY and current evidence exists.
11. Project state survives session restart in `.pi-cad/state.json`.
12. Final delivery is source + STEP.
