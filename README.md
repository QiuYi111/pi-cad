# Pi-CAD

**Let the model search the design space. Let the runtime remember what is true.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml/badge.svg)](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Pi-CAD turns [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) into
an autonomous mechanical design agent. Give it a product brief: it can clarify
requirements, explore concepts, write deterministic CAD, render and inspect the
result, revise it, request an independent review, and release the accepted
source and STEP artifact.

The difference is simple: Pi-CAD does not treat a plausible model response—or
the mere existence of a STEP file—as completion. A design is complete only when
its requirements, source, geometry, evidence, and review still agree.

## 1. Design philosophy: free search, governed progress

An agent is an inverse solver. The LLM searches through semantic space—forming
hypotheses, writing code, choosing experiments—while its actions move the real
project through artifact space toward a set of acceptable solutions.

The harness has two jobs at that boundary: construct what the model sees, and
interpret what the model returns. A better specialist agent therefore does not
come from putting more instructions and more tool schemas into one enormous
prompt. It comes from choosing better representations for context, actions, and
engineering state.

### Keep semantic search free; govern changes to the world

A Skill can teach good practice, but it can only advise. A production workflow
must also make obligations and authority executable. Pi-CAD workflows specify
what must be submitted, which effects are currently allowed, and which exits
are legal. They constrain progression through the project—not the model's
private reasoning or the code it may compose to solve the current problem.

Before each model call, Pi-CAD derives a small ephemeral Phase Card from the
current state: where the run is, what remains mandatory, what can happen now,
and what transitions are possible. The card changes with the phase instead of
mixing the entire state machine into permanent context. Workflow packages are
plain, discoverable documents, so they can be selected, inspected, versioned,
and improved much like Skills.

### Treat context as managed working memory

Generic agents tend to flatten the mission, domain knowledge, tool manuals,
files, and changing state into the same message history. Those layers have
different lifetimes and should not compete for the same attention.

Prime gives the agent a persistent IPython workbench. Requirements, specs,
artifact handles, probe results, and intermediate calculations can remain as
typed Python values across turns. Large files and raw solver output stay outside
the prompt; the agent recalls or transforms them when needed. Pi-CAD injects
only the current operational boundary and the most useful observations.

This is working memory rather than another archive: the agent can calculate
with it, pass it between bounded subagents, and feed the same value into several
tools without repeatedly rediscovering paths or reconstructing state.

### Make tools programmable at the right level

Bash and raw CAD libraries are valuable because they are composable. They are
not, by themselves, an efficient agent interface. Mechanical engineering APIs
are fragmented across libraries, file formats, solver versions, and backend-
specific conventions. Asking the model to relearn that surface on every task
wastes context and produces inconsistent observations.

Pi-CAD exposes stable Python operations over those backends. Prime still writes
code and freely composes operations in IPython, but the operations normalize
inputs, identities, failure modes, and results. A build returns the views the
agent needs to see; a simulation can turn a huge numeric stream into a bounded
plot and typed facts. Managed tooling is therefore not mainly about hiding a
library. It is about controlling what enters context after an effect.

### Pass artifacts as values, not locations

A file path says where some bytes happen to be. It does not say what they are,
which build produced them, whether they are current, or which evidence and
review refer to them. An `ArtifactRef` carries identity, type, provenance, and
revision semantics while still resolving to a real project-local file.

That distinction matters in long tasks and multi-agent work. The same artifact
can flow from modeling to meshing, probing, simulation, and review without each
participant rebuilding its meaning from a filename. If the design is rebuilt,
old handles, observations, and verdicts become stale together.

### Close the loop with evidence outside the author

Seeing is necessary for spatial work; measurement is decisive; final judgment
should not belong to the author. Managed builds force visual feedback, bounded
B-Rep probes test the exact artifact, and a fresh isolated Prime reviewer checks
an immutable candidate with probe-only authority. A crash, timeout, empty
answer, evidence-free PASS, or stale review fails closed.

In short: Prime owns the search and the working memory. Pi-CAD owns admissible
effects, managed observations, artifact truth, and completion. The model stays
creative where creativity helps; the runtime stays strict where engineering
facts must survive.

## 2. Killer demos

### A. Brief → tested part → release

Ask:

> Design a 100 × 80 × 5 mm mounting plate with four corner holes. Preserve at
> least 8 mm edge distance, add printable edge fillets, and release a STEP file.

Pi-CAD guides Prime through requirements, concept, deterministic build123d
source, rendered views, geometric probes, fresh review, and release. The agent
does not need to rediscover wrappers or inspect implementation source; the
current Phase Card tells it exactly what must be closed, what it may do, and
which transitions are legal.

What this demonstrates:

- a reproducible source model and STEP artifact, not geometry trapped in chat;
- mandatory images returned by the build rather than optional screenshots;
- measurements made against the built B-Rep rather than inferred from code;
- automatic evidence invalidation after every rebuild;
- an independently reviewed release with a machine-enforced completion gate.

The current targeted CADTestBench acceptance case `00001817` passes CAD tests
17/17 and rubric score 9/9 with a single reviewer and terminal workflow state.

### B. Product idea → visual concept → real assembly

Ask:

> Design a foldable phone stand for a desk. Explore a compact modern form,
> support portrait and landscape use, and make the hinge and stops printable.

In the concept phase, Prime may generate a reference image through the existing
Codex OAuth session and use it as a spatial hypothesis. It must then turn the
idea into explicit interfaces, architecture/BOM, individual parts, and an
assembled candidate. Detailed CAD is unavailable until the concept is
committed; an assembly cannot skip its interface and part obligations.

What this demonstrates:

- image generation used for exploration without becoming geometry authority;
- different paths for a trivial part and a real assembly;
- ordinary Prime RLM fan-out for bounded part research or authoring;
- one canonical assembly candidate, even when several agents contribute;
- independent final review of the actual immutable assembly artifact.

### C. Existing design → controlled change or engineering answer

Ask:

> Increase this bracket's mounting holes from 4.2 mm to 5.0 mm without changing
> its outer envelope. Verify the result and release a new revision.

or:

> Inspect this STEP model and report its exact bounding box, solid count, and
> minimum wall-risk areas. Do not modify it.

Use `mechanical.modify` for a traceable revision and `mechanical.analysis` for a
bounded read-only investigation. Prime can probe any project-local
`ArtifactRef`; it does not need decorator source capture or ad-hoc API
adaptation. More involved deterministic work can be packaged as strict recipes,
including managed OpenFOAM, SU2, and torch-fem paths.

What this demonstrates:

- modification and analysis are first-class workflows, not special prompts;
- old evidence cannot silently certify a new revision;
- programmable checks stay bound to the artifact they measured;
- raw compute can remain outside model context while typed observations enter
  the evidence record.

## 3. Get started

Pi-CAD currently supports Ubuntu and WSL2. You need Node.js 22.19+, Python
3.11/3.12 managed by `uv`, Bubblewrap, and a configured Prime provider.

### Install

Keep the Prime Agent and Pi-CAD repositories beside each other:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap libglu1-mesa

mkdir -p ~/work && cd ~/work
git clone https://github.com/QiuYi111/prime-agent.git
git clone https://github.com/QiuYi111/pi-cad.git

cd prime-agent && npm ci
cd ../pi-cad
npm install
npm run setup:python
PRIME_AGENT_REPO=~/work/prime-agent npm run prime:setup
```

Run `/login` once in the Prime session opened by setup. Then install the launcher:

```bash
mkdir -p ~/.local/bin
ln -sfn "$PWD/scripts/prime-cad-launcher.sh" ~/.local/bin/prime-cad
```

Make sure `~/.local/bin` is on `PATH`.

### Run your first design

Start inside a dedicated design project or Git worktree:

```bash
mkdir -p ~/designs/mounting-plate
cd ~/designs/mounting-plate
PRIME_AGENT_REPO=~/work/prime-agent prime-cad
```

Then ask Prime:

```text
Use mechanical.one-shot to design and release a 100 × 80 × 5 mm mounting
plate with four 5 mm corner holes and at least 8 mm edge distance.
```

Useful workflow entry points are:

| Workflow | Use it for |
| --- | --- |
| `mechanical.one-shot` | A new part or assembly through review and release |
| `mechanical.modify` | A controlled revision of an existing design |
| `mechanical.analysis` | Read-only geometric or engineering investigation |

External concept-image generation is disabled by default. Enable it only for a
run that should access the Codex Images service:

```bash
PI_OFFLINE=0 PRIME_AGENT_REPO=~/work/prime-agent prime-cad
```

### Headless use

```bash
PRIME_AGENT_REPO=~/work/prime-agent \
prime-cad --provider openai-codex --model gpt-5.6-luna \
  --thinking medium --no-session --mode json --print \
  "Use mechanical.one-shot to design and release a 100 × 80 × 5 mm plate."
```

The command returns exit code `42` with `WORKFLOW_INCOMPLETE` unless canonical
state contains a terminal workflow, the exact release commit, and a valid final
PASS.

### Validate a checkout

```bash
npm run check:agent-contract
npm run test:ts

PYTHONPATH="$PWD/skills/cad/src" PYTHONDONTWRITEBYTECODE=1 \
uv run --offline --frozen --project python --extra simulation \
  python -m unittest discover -s tests -p 'test_*.py'

npm run check:prime-imagegen
npm run test:prime-imagegen
node tests/prime-cli-smoke.mjs
```

## Current scope

Pi-CAD currently provides deterministic build123d authoring, visual-first
builds, artifact-bound B-Rep probes, concept image generation through Codex
OAuth, immutable workflow packages, event-driven independent review, sandboxed
author/reviewer roles, and recipe-native engineering compute.

The authority runtime currently supports Linux/WSL and follows a Prime source
checkout. It does not replace physical testing, manufacturing review, or
professional engineering sign-off. Unsupported simulation assumptions must be
stated rather than silently approximated.

Canonical state lives outside the project at
`~/.local/share/pi-cad/<sha256(realpath(project))>/`; project-local
`.pi-cad/status.json` is only a human-readable projection.

## License

[MIT](LICENSE). The image-generation compatibility package retains its upstream
attribution and license in
[`packages/prime-codex-image-gen`](packages/prime-codex-image-gen).
