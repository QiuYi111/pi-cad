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

## 2. Where Pi-CAD fits

Pi-CAD is not trying to win every form of AI-assisted CAD. The projects below
optimize for different units of work. This is an architectural comparison, not
an output-quality leaderboard; there is not yet a shared evaluation covering
all five systems under identical models and prompts.

| System | Primary unit of work | Context and tool model | What makes progress valid | Best fit |
| --- | --- | --- | --- | --- |
| [Codex](https://openai.com/codex/) | A general software or computer-use task | Repository context, Skills, shell and typed tools inside a sandbox; first-class parallel tasks and worktrees | Tests, diffs, approvals, and whatever completion criteria the task supplies | Open-ended engineering and software work where a human or project-specific test suite owns acceptance |
| Earlier Pi-CAD on Pi | A state-machine-governed CAD run | CAD knowledge in Skills plus a large catalog of structured tool calls; changing state and tool guidance shared the conversational context | Harness phases, hash-bound evidence, and acceptance gates | The historical proof that visual evidence and workflow enforcement improve generic CAD agents |
| [text-to-CAD](https://github.com/earthtojake/text-to-cad) | A CAD, robotics, or fabrication operation performed by an existing coding agent | Portable Skills and local scripts for Codex, Claude Code, and other agents; broad format-specific tooling and CAD Viewer handoffs | Skill-directed procedure, generated files, snapshots, and user/agent review | Adding a capable, low-friction CAD toolbox to the generic agent you already use |
| [CADAM](https://github.com/Adam-CAD/CADAM) | A prompt or image turned into an editable parametric model | Browser UI; the model generates OpenSCAD executed with WebAssembly, with live preview and extracted parameter sliders | Successful generation, visual iteration, and interactive parameter edits | Fast, accessible concept parts and 3D-printing models without installing a desktop CAD stack |
| **Pi-CAD on Prime** | A long-running mechanical design or analysis lifecycle | Persistent IPython values, programmable managed operations, discoverable workflows, and event-driven subagents | Canonical state, current artifact-bound evidence, independent review, and an enforced release gate | Autonomous engineering work where provenance, revision invalidation, and “actually done” matter |

### Compared with ordinary Codex

Codex is the stronger generalist. It is designed to work across repositories,
run commands in a sandbox, apply Skills, use worktrees, and coordinate parallel
agents. If the job is “write this CadQuery script and let me inspect the diff,”
adding Pi-CAD may be unnecessary.

Pi-CAD adds a domain runtime when the job is larger than a code change. It makes
the design phase, artifact identity, visual and geometric evidence, reviewer
authority, and release condition machine-readable. The distinction is not that
Codex cannot write CAD; it is that ordinary Codex leaves the definition of a
valid mechanical release to the prompt, the repository, and the user.

### Compared with the earlier Pi version

The Pi version established several ideas Pi-CAD keeps: deterministic backends,
forced visual feedback, hash-bound evidence, and a state machine that prevents
review from being skipped. Its limitation was architectural. Domain knowledge,
workflow guidance, current state, and many JSON tool schemas still competed in
the same conversational channel, while complex composition fell back to a
sequence of tool calls and temporary scripts.

Prime keeps those enforcement gains but changes the agent's workbench. Typed
objects survive in IPython; a small Python API replaces much of the schema
surface; the current Phase Card is ephemeral; workflow packages are data; and
canonical authority lives outside the author process. This is less a model
upgrade than a context and effect-system upgrade.

### Compared with text-to-CAD

text-to-CAD is closest to a high-quality portable toolbox. Its Skills cover CAD,
robot descriptions, simulation formats, fabrication, and viewing, and can be
installed into several generic agents. That breadth and low adoption cost are
real advantages. Its CAD Skill also tells the agent to snapshot and visually
review changed geometry.

Pi-CAD takes a narrower but stronger position: instructions that say “always
review” are not the same as a runtime that refuses to release without current
evidence. Pi-CAD trades some portability and simplicity for persistent typed
working memory, executable obligations, revision invalidation, scoped reviewer
authority, and a canonical completion gate. Use text-to-CAD when you want better
CAD capabilities in your agent; use Pi-CAD when the agent itself must carry an
engineering process to closure.

### Compared with CADAM

CADAM offers the shortest path from text or an image to a visible parametric
model. It runs OpenSCAD in the browser, exposes generated parameters as sliders,
and exports STL, SCAD, or DXF. For quick ideation and printable parts, that
interaction can be much better than operating a long autonomous agent.

Pi-CAD is aimed at a different scale of problem: STEP-first B-Rep parts and
assemblies, explicit specifications and interfaces, programmable measurement,
engineering recipes, cross-revision evidence, and independent release review.
It asks for more setup because it preserves more of the design's lifecycle.
CADAM optimizes prompt-to-model latency; Pi-CAD optimizes the path from intent to
an accountable engineering result.

## 3. Killer demos

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

## 4. Get started

Pi-CAD currently supports Windows with WSL2, plus the Ubuntu command line.

### Desktop app

Install `Pi-CAD-0.1.0-x64.exe`, open Pi-CAD, and choose a project folder in
Settings. The app includes the matching Prime Agent and Pi-CAD runtime. On first
run it checks WSL, then installs missing Node.js, Python, `uv`, and Bubblewrap
inside the selected distro. WSL itself remains a Windows prerequisite.

Sign in with ChatGPT from the Provider card. The OAuth result is stored in the
Prime agent directory inside WSL; the desktop app never asks for an API key.
Choose the author model, thinking level, reviewer model, and workflow, then
return to the Workbench. The left pane is resizable and the viewer follows the
available screen size.

The desktop app provides:

- a Prime conversation and persistent engineering workbench;
- a live workflow rail and workflow package editor;
- a large STEP viewer with fit, standard views, section, and explode controls;
- visible build, probe, simulation, image, transition, and review activity;
- processed trajectory inspection, rating, and distillation progress.

### Command line

The command line supports Ubuntu and WSL2. You need Node.js 22.19+, Python
3.11/3.12 managed by `uv`, Bubblewrap, and a configured Prime provider.

#### Install

Keep the Prime Agent and Pi-CAD repositories beside each other:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap libglu1-mesa ripgrep

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

#### Run your first design

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

### Choose the reviewer model

The independent reviewer inherits the author's current provider, model, and
thinking level by default, including model changes made inside an interactive
Prime session. To pin a different reviewer for one run:

```bash
prime-cad --reviewer-provider openai-codex \
  --reviewer-model gpt-5.6-luna --reviewer-thinking high
```

For a persistent choice, add this to `~/.prime/agent/prime-cad.json`:

```json
{
  "reviewer": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "thinking": "high"
  }
}
```

Use `"reviewer": "inherit"`, or pass `--reviewer-inherit-author`, to restore
live author inheritance. Environment equivalents are
`PI_CAD_REVIEWER_PROVIDER`, `PI_CAD_REVIEWER_MODEL`, and
`PI_CAD_REVIEWER_THINKING`.

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
