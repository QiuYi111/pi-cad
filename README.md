<p align="center">
  <img src="docs/assets/reify-lockup.svg" alt="Reify · 器成 — Make ideas real." width="520" />
</p>

<p align="center"><strong>From imagination to what exists.</strong></p>

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml/badge.svg)](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Reify is a desktop mechanical-design agent built on
[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent). Describe a part,
assembly, modification, or analysis. Reify can clarify the brief, explore a
concept, write deterministic CAD, build STEP geometry, inspect the result, and
keep the source, model, measurements, and review connected.

It uses your ChatGPT account through OpenAI Codex OAuth. No API key is required.

## Why Reify

Language models are good at searching a design space. Engineering work also
needs durable facts.

Reify gives the model a persistent Python workbench where requirements,
artifacts, calculations, and observations remain usable across a long task. A
small workflow card shows the current goal, available operations, required
deliverables, and legal next steps. The model stays free to reason and write
code; the runtime governs what counts as a valid build, measurement, review,
and release.

- **Programmable tools.** Prime composes CAD, probes, simulations, and image
  generation in a persistent IPython session.
- **Visual feedback by default.** A build returns useful model views to both the
  agent and the user.
- **Artifacts with identity.** Source, STEP files, images, and evidence retain
  their role and revision. Rebuilding invalidates stale evidence.
- **Workflows that enforce completion.** Missing obligations and invalid
  transitions are executable rules, not reminders.
- **Inspectable work.** The app shows model activity, STEP geometry, workflow
  state, processed trajectories, and distillation progress.

## See it work

### Design a new part

> Design a 100 × 80 × 5 mm mounting plate with four 5 mm corner holes. Keep at
> least 8 mm edge distance, add printable fillets, and export STEP.

Reify turns the brief into deterministic source and geometry, returns visual
feedback, measures the built result, and keeps the final files in your project.

### Build an assembly

> Design a compact foldable phone stand for portrait and landscape use. Make
> the hinge, stops, and clearances suitable for FDM printing.

The agent can explore a concept, define interfaces, build individual parts,
inspect the assembly, and revise the actual candidate.

### Modify or inspect an existing model

> Increase these mounting holes from 4.2 mm to 5.0 mm without changing the
> outer envelope. Verify the result.

> Inspect this STEP file and report its exact bounding box and solid count. Do
> not modify it.

Modification and analysis use separate workflows. Measurements remain bound to
the artifact that was actually inspected.

## Install on Windows

Download **`Reify-Setup-x64.exe`** from the latest release and open it.

The first-run setup uses the same interface as the main workbench. It:

1. checks WSL 2 and Ubuntu;
2. offers the standard Windows WSL installation when they are missing;
3. installs the bundled Prime and Reify runtime;
4. connects your ChatGPT account;
5. asks you to choose a project folder.

Administrator approval is only requested if Windows must enable WSL. Windows
may require one restart. Reify keeps its files and continues setup afterwards.

Requirements:

- Windows 10 version 2004 or newer, or Windows 11;
- virtualization enabled in firmware;
- permission to enable WSL when it is not already installed;
- internet access for ChatGPT sign-in and model calls.

The matching Prime Agent and Reify runtime ship inside the installer. Normal
setup does not clone repositories.

## Install on Linux

Download `Reify-Linux-x86_64.AppImage` or the matching `.deb`. Linux runs the
agent runtime directly; WSL is not involved. Install Bubblewrap with the system
package manager before first launch. The app supplies Prime, Reify, and Node,
then prepares its managed Python environment with `uv`.

## Install on macOS

Download `Reify-macOS-arm64.dmg`, drag Reify to Applications, and open it.
The Apple Silicon build runs Prime and Reify directly on macOS and uses the
system `sandbox-exec` boundary for author and reviewer processes. Public builds
must be Developer ID signed and notarized; unsigned CI artifacts are for
testing only.

## First design

Open Reify, choose a folder, sign in, and enter a request in the Workbench.
Provider, model, reasoning level, reviewer, and workspace permissions are
available in Settings.

The desktop app includes streaming agent state, a workflow rail and editor, an
interactive STEP viewer, semantic tool cards, project switching, and trajectory
distillation.

## Command line

Developers can also run Reify directly on Linux, macOS, or WSL 2. The repository
and compatibility-facing command names remain `pi-cad` during the rename:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap libglu1-mesa ripgrep

git clone https://github.com/QiuYi111/prime-agent.git
git clone https://github.com/QiuYi111/pi-cad.git

cd prime-agent && npm ci
cd ../pi-cad
npm install
npm run setup:python
PRIME_AGENT_REPO="$PWD/../prime-agent" npm run prime:setup
```

Main workflows:

| Workflow | Purpose |
| --- | --- |
| `mechanical.one-shot` | New part or assembly through release |
| `mechanical.modify` | Controlled revision of an existing design |
| `mechanical.analysis` | Read-only geometric investigation |

Workflow packages may also define trusted Git actions at workflow start and
phase entry or exit. Reify can initialize a repository and commit changed
source files; generated STEP files and images stay outside Git. Remote pull and
push remain disabled unless the workflow explicitly enables them. Each
workspace commit records the matching Git revision.

## Scope

Reify currently targets Windows with WSL 2 and Ubuntu. It provides STEP-first
build123d authoring, B-Rep probes, managed visual feedback, workflow packages,
review isolation, concept-image generation, and packaged engineering recipes.

It does not replace physical tests, manufacturing review, or professional
engineering sign-off.

## License

[MIT](LICENSE). The Codex image-generation compatibility package retains its
upstream attribution in
[`packages/prime-codex-image-gen`](packages/prime-codex-image-gen).
