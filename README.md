# Pi-CAD

**Evidence-bound mechanical CAD for Prime Agent.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml/badge.svg)](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Pi-CAD turns [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)
into a workflow-governed mechanical engineering agent. Prime reasons, writes
deterministic build123d source, and coordinates work. Pi-CAD owns authority:
what may happen now, which evidence is current, whether an independent review
is valid, and whether a run is actually complete.

The result is not “an LLM that can export STEP.” It is a CAD runtime in which
every accepted release is connected to a pinned workflow, deterministic source,
hash-bound artifacts, rendered views, programmable B-Rep probes, and a fresh
reviewer verdict.

## Why Prime Agent

Earlier Pi-CAD releases were packaged as a broad Pi extension suite. The
current release moves the authoring experience to Prime Agent while keeping the useful Pi
extension API underneath as an implementation detail.

Prime is a better host for this system because mechanical design is long-running
stateful work, not a sequence of isolated chat turns:

- **Persistent IPython is the control plane.** The agent keeps `ArtifactRef`,
  `Commit`, probe results, and ordinary Python variables alive across turns.
  It calls the small `cad` API directly instead of rediscovering wrappers or
  serializing state through shell commands.
- **RLM fan-out is native.** Assemblies can use ordinary Prime subagents for
  bounded research or part work while the root agent remains responsible for
  one canonical workflow and one authoritative candidate.
- **Long tasks survive context pressure.** Prime provides durable sessions,
  compaction, goals, autonomous continuation, and event-triggered turns. Pi-CAD
  therefore does not need its own competing conversation runtime.
- **Provider and model selection remain Prime concerns.** Pi-CAD does not build
  another model gateway. The author and fresh reviewer use the selected Prime
  provider/model, with the reviewer isolated and budgeted separately.
- **Skills are explicit operating contracts.** Prime loads the CAD and imagegen
  skills tracked by this repository. The public call signatures and required
  handoff order are available without source inspection or API adaptation.
- **Headless completion is real.** A one-shot Prime run exits successfully only
  when the authority sidecar confirms terminal workflow state, a valid final
  PASS, and the exact release commit. Natural-language “done” is not success.

This division is deliberate: Prime owns reasoning, sessions, models, and
subagents; Pi-CAD owns engineering state, effects, evidence, and release
authority.

## The authority model

The current runtime is built around one rule:

> Files are data. Workflow authority exists only in canonical state admitted by
> the State Engine.

A STEP file, JSON document, PNG, or edited `.pi-cad/status.json` cannot advance a
run by existing on disk. Only accepted commits, artifacts, evidence, transitions,
and reviewer results have workflow effect.

```text
Prime author in bwrap
  ├─ persistent IPython + cad Python client
  ├─ project workspace (read/write)
  └─ author-scoped Unix socket
                    │
                    ▼
          Authority sidecar
          ├─ pinned workflow snapshot
          ├─ unified authorize(operation, ...)
          ├─ canonical CAS state outside the project
          ├─ artifact/evidence invalidation
          ├─ reviewer admission and events
          └─ completion gate
                    │
                    ▼
     Fresh Prime reviewer in a separate bwrap
     immutable candidate + probe-only authority
```

The author sandbox cannot see engine source, canonical storage, host
credentials, or reviewer authority. The reviewer gets a different socket and
an immutable subject. Project-local `.pi-cad/status.json` is only an atomic,
non-authoritative projection for humans and tools.

## Current capabilities

### Workflow packages

Workflows are discoverable packages compiled to a kernel-generic immutable
snapshot. A running design is unaffected if the source YAML later changes.

| Package | Intended use |
| --- | --- |
| `mechanical.one-shot` | Greenfield part or assembly through independent review and release |
| `mechanical.modify` | Controlled modification of an existing design |
| `mechanical.analysis` | Bounded read-only engineering investigation |

`mechanical.one-shot` follows:

```text
GRILL → SPEC → CONCEPT
                  ├─ trivial part → PARTS ───────────────┐
                  └─ assembly → INTERFACE → BOM → PARTS → ASSEMBLY
                                                        │
                         FINAL_REVIEW → RELEASE → DONE ◀─┘
```

Detailed CAD is unavailable before concept closure. Assemblies cannot skip
interfaces, architecture/BOM, part work, or assembly verification. The kernel
does not know these mechanical phase names; they come from the installed
package.

### Phase Card v2

Before every provider call, Prime receives exactly one ephemeral card:

```text
WHERE
GOAL
SOP
MUST
CAN
NEXT
STATE
WARNINGS
```

`CAN` is the effective capability set returned by the same authorization engine
used by tools. `MUST` is the exact set of open obligations. `NEXT` contains only
transitions executable now—not every transition declared by the workflow. The
card is bounded, replaced on the next call, and never accumulated into the
permanent trajectory.

### Deterministic CAD and visual evidence

- Author project-local build123d source and expose one `result` shape.
- `cad.model.build()` exports STEP and returns an `ArtifactRef` only after the
  managed visual chain has rendered and attached the required views.
- Rebuilding the same candidate is supported. A successful rebuild atomically
  replaces primitive build evidence, marks older evidence stale, invalidates
  dependent claims/reviews, and makes every previous `ArtifactRef` unusable.
- CadQuery-shaped benchmark requests preserve their geometry and dimensions but
  use the managed build123d backend.

### Programmable probes

Prime can run read-only B-Rep calculations against any project-local
`ArtifactRef` without `inspect.getsource()`:

```python
checks = await cad.probe.run(
    subject=artifact,
    purpose="verify the released envelope and solid count",
    code="result = {'solids': len(shape.solids()), 'size': list(shape.bounding_box().size)}",
)
```

The fenced program receives `shape` and `artifact_path`, must assign a
JSON-serializable `result`, and cannot use unrestricted imports to escape the
effect boundary.

### Concept image generation

The tracked `codex_generate_image` extension is a Prime compatibility port of
MIT-licensed `@crazygit/pi-codex-image-gen` v0.2.2.

- Uses the existing `openai-codex` OAuth session and `chatgpt_account_id`.
- Fixes the image model to `gpt-image-2`; there is no `OPENAI_API_KEY` fallback
  and no Codex CLI subprocess.
- Saves project-relative output inside the current project, normally under
  `.pi/generated-images/<session-id>/`, with traversal and symlink rechecks.
- Requires interactive approval before uploading reference images; headless
  reference editing fails closed.
- Concept images are spatial hypotheses. They gain workflow relevance only when
  referenced by a concept commit and never become geometry authority.

The author sandbox defaults to `PI_OFFLINE=1`. Set `PI_OFFLINE=0` explicitly
for a run that is allowed to call the external Codex Images service.

### Event-driven independent review

The fresh reviewer is an ordinary Prime RLM template, not a privileged special
agent. The sidecar controls admission and authority:

- idempotency key: workflow + contract + artifact identity;
- at most one reviewer for the same candidate;
- immutable subject and reviewer-scoped socket;
- probe-only engineering access;
- `maxProbeCalls=12`, `maxTurns=16`, `wallTimeout=120s`, no compaction;
- verdicts: `pass | fail | unresolved`;
- crash, timeout, empty output, or evidence-free PASS fail closed;
- completion sends an event that wakes the parent Prime turn—no polling loop.

Candidate, specification, or contract revision makes the old review stale.

### Recipe-native engineering compute

Complex deterministic operations use the strict `pi-recipe.yaml` protocol.
The current repository contains managed paths for:

- OpenFOAM 14 finite-volume workflows;
- SU2 8.5.0 steady-flow and solid-thermal workflows;
- torch-fem 0.9 CUDA structural analysis and optimization;
- deterministic drawings, presentation, observation, and re-observation.

Recipes freeze declared inputs and compute closure, run in pinned environments,
retain full raw output outside model context, and materialize typed observations.
Observation is not acceptance: evidence must still be explicitly committed to
the matching workflow obligation.

## Public Python API

Prime normally learns this API from the installed CAD skill. The core author
surface is intentionally small:

```python
import cad

await cad.workflow.list()
await cad.workflow.start("mechanical.one-shot")
await cad.workflow.current()
await cad.workflow.advance("specified")

commit = await cad.commit("spec", variables={"requirements": requirements})
artifact = await cad.model.build("part.py", "part.step")
checks = await cad.probe.run(subject=artifact, purpose="...", code="result = {...}")

final_commit = await cad.commit(
    "review-candidate",
    artifacts=[artifact, "part.py"],
    variables={"checks": checks.value},
)
handle = await cad.review.submit(final_commit)
# Wait for the host review-complete event, then:
verdict = await cad.review.current(handle)
```

Do not guess IDs, inspect source or signatures, poll review state, or retain an
old artifact handle after a rebuild. Use the Python objects returned by the API
and only advance with an event present in the current Phase Card `NEXT`.

## Requirements

The authority runtime currently supports Linux and WSL only.

- Ubuntu or WSL2 Ubuntu
- Node.js 22.19 or newer
- Python 3.11/3.12 managed through `uv`
- Bubblewrap 0.11.1 or compatible
- `libglu1-mesa` for gmsh/OCP-related runtime paths
- a Prime Agent source checkout and a configured Prime provider

The launcher deliberately uses a Prime source checkout because the current
integration tracks Prime extension, IPython, event, and autonomous-gate APIs.

## Development setup

Place the two repositories beside each other:

```text
~/work/
├── prime-agent/
└── pi-cad/
```

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap libglu1-mesa

mkdir -p ~/work
cd ~/work
git clone https://github.com/QiuYi111/prime-agent.git
git clone https://github.com/QiuYi111/pi-cad.git

cd prime-agent
npm ci

cd ../pi-cad
npm install
npm run setup:python
```

Bootstrap the isolated Prime configuration/kernel and authenticate once:

```bash
cd ~/work/pi-cad
PRIME_AGENT_REPO=~/work/prime-agent npm run prime:setup
# In Prime: /login
```

Install the sandboxed launcher globally for your user:

```bash
mkdir -p ~/.local/bin
ln -sfn "$PWD/scripts/prime-cad-launcher.sh" ~/.local/bin/prime-cad
```

Ensure `~/.local/bin` is on `PATH`, then start Prime through Pi-CAD from the
project you want to design in:

```bash
cd /path/to/design-project
PRIME_AGENT_REPO=~/work/prime-agent prime-cad
# Allow external image generation for this run:
PI_OFFLINE=0 PRIME_AGENT_REPO=~/work/prime-agent prime-cad
```

The launcher owns `--cwd`, starts the authority sidecar, creates the author and
reviewer sandboxes, loads only the tracked CAD/imagegen extensions and skills,
and stores canonical state at:

```text
~/.local/share/pi-cad/<sha256(realpath(project))>/
```

For a headless run:

```bash
PRIME_AGENT_REPO=~/work/prime-agent \
prime-cad --provider openai-codex --model gpt-5.6-luna \
  --thinking medium --no-session --mode json --print \
  "Use mechanical.one-shot to design and release a 100 x 80 x 5 mm plate."
```

A one-shot command returns exit code `42` with `WORKFLOW_INCOMPLETE` if the
canonical completion gate is not satisfied.

## Validation

```bash
npm run check:agent-contract
npm run test:ts

PYTHONPATH="$PWD/skills/cad/src" PYTHONDONTWRITEBYTECODE=1 \
uv run --offline --frozen --project python --extra simulation \
  python -m unittest discover -s tests -p 'test_*.py'

npm run check:prime-imagegen
npm run test:prime-imagegen
node tests/prime-cli-smoke.mjs
git diff --check
```

The targeted Prime acceptance baseline includes CADTestBench task `00001817`
at 17/17 CAD tests and RS 9/9, with no probe source-capture failure, no tool/API
adaptation error, one reviewer, and terminal workflow state.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/authority/` | sidecar, bwrap launch, canonical storage, completion gate |
| `src/harness/` | workflow compiler/state, authorization, Phase Card, commits/evidence |
| `src/agent-api/` | narrow transport-independent Agent-facing operations |
| `src/integrations/prime/` | thin Prime Phase Card, image authorization, and review-event adapter |
| `skills/cad/` | public Prime CAD operating contract and Python client |
| `workflow-packages/` | discoverable workflow package YAML |
| `packages/prime-codex-image-gen/` | tracked Codex OAuth image generation extension |
| `recipes/` | strict deterministic compute packages |
| `benchmarks/cadtestbench/` | targeted CADTestBench runner and reports |

The earlier architecture and refactor history remains available under
[`refactor/`](refactor/), but the runtime described in this README is the
released Prime authority runtime.

## Trust model and limitations

- The author project is writable. Use a dedicated project directory or Git
  worktree and review generated source and artifacts.
- Linux/WSL is the only supported authority-sidecar platform today.
- The Prime integration currently follows a source checkout rather than a
  standalone Pi-CAD installer.
- `gpt-image-2` through Codex OAuth is provider-managed and may change outside
  this repository.
- The reviewer proves only its configured evidence contract; it is not a
  substitute for physical testing, manufacturing review, or professional
  engineering sign-off.
- Simulation support is intentionally explicit and scoped. Unsupported
  nonlinear, multi-material, conjugate, combustion, or turbomachinery
  assumptions must be stated rather than silently approximated.

## License

[MIT](LICENSE). The vendored Prime image-generation compatibility package
retains its upstream attribution and license in
[`packages/prime-codex-image-gen`](packages/prime-codex-image-gen).
