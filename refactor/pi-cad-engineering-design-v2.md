# Pi-CAD Refactoring Engineering Design Document v2

## Title

Deep Module Architecture Migration Plan

From CAD Tool Collection to CAD Engineering Runtime

------------------------------------------------------------------------

# 1. Purpose

This document defines the engineering implementation plan for the next
major Pi-CAD architecture evolution.

The objective is not to add more CAD APIs.

The objective is to separate:

-   engineering process control;
-   computational capability;
-   observation;
-   context management.

The target architecture is:

Control Plane + Context Runtime + Observation Layer + MODEL / PROBE /
SIMULATE modules

------------------------------------------------------------------------

# 2. Current Repository Architecture Assessment

## 2.1 Existing strengths

Pi-CAD already contains several mature architectural ideas.

### Workflow compiler

The workflow compiler maps engineering intent into a process graph.

It already understands:

-   greenfield design;
-   legacy modification;
-   hybrid workflows;
-   assembly design;
-   manufacturing and release maturity.

The route ontology should remain.

------------------------------------------------------------------------

### State machine

The state machine currently owns:

-   phase transitions;
-   mutation authority;
-   candidate acceptance;
-   evidence requirements;
-   project head updates.

This should remain the authority layer.

------------------------------------------------------------------------

### Evidence and provenance

Artifacts are already associated with:

-   hashes;
-   evidence records;
-   simulation specifications;
-   solver results.

This becomes the foundation of future module boundaries.

------------------------------------------------------------------------

### Context memory

The context runtime already separates:

-   canonical state;
-   working context;
-   archived trajectory;
-   compaction lifecycle.

Future work should extend observation memory rather than replace it.

------------------------------------------------------------------------

# 3. Main Architectural Problems

## 3.1 Capability explosion

Current Agent tools expose implementation details.

Examples:

-   geometry inspection;
-   measurement;
-   sections;
-   surface analysis;
-   visual inspection;
-   simulation variants.

This creates tool-selection burden.

The Agent should reason about engineering actions, not backend APIs.

------------------------------------------------------------------------

## 3.2 Backend coupling

Today the candidate workflow knows too much about build execution.

A future CAD backend should not require a new workflow.

The dependency should become:

Workflow

depends on

MODEL interface

which depends on

Backend adapter.

------------------------------------------------------------------------

## 3.3 Observation is not a first-class abstraction

Backend output is not the same as useful Agent context.

The system needs a dedicated layer that decides:

-   what image should be shown;
-   what facts matter;
-   what diagnostics are useful;
-   what should be remembered.

------------------------------------------------------------------------

# 4. Target Module Architecture

## 4.1 Control Plane

The control plane is Pi-CAD's unique value.

Responsibilities:

-   route selection;
-   workflow compilation;
-   phase contracts;
-   obligations;
-   acceptance;
-   state transitions.

The control plane should never depend on:

-   build123d;
-   CadQuery;
-   solver implementation.

------------------------------------------------------------------------

## 4.2 Context Runtime

Responsibilities:

-   maintain engineering memory;
-   rebuild working context;
-   preserve failed attempts;
-   manage observation history.

Future additions:

-   observation index;
-   visual hydration;
-   phase-specific memory policy.

------------------------------------------------------------------------

## 4.3 MODEL

Purpose:

Produce engineering artifacts.

Input:

-   source;
-   backend;
-   execution context.

Output:

CandidateProposal.

MODEL does not decide:

-   acceptance;
-   review;
-   evidence closure.

------------------------------------------------------------------------

## 4.4 PROBE

Purpose:

Answer deterministic questions about artifacts.

Agent-facing interface:

cad_probe

Internal implementation:

Preset Registry.

Existing tools become presets:

-   visual;
-   geometry;
-   measure;
-   section;
-   compare;
-   assembly;
-   interference.

Advanced usage:

programmable Python composition.

------------------------------------------------------------------------

## 4.5 SIMULATE

Purpose:

Run controlled engineering experiments.

Presets:

-   structural analysis;
-   CFD;
-   thermal;
-   optimization;
-   analysis-model derivation.

------------------------------------------------------------------------

## 4.6 Existing Tool to Module Mapping

This table is the authoritative migration baseline. Every agent-visible
tool in `src/shared/protocol.ts` must have exactly one destination.

| Current tool | Destination | Note |
| --- | --- | --- |
| cad_route, cad_reroute | Control Plane | unchanged |
| cad_commit_requirements / frame_context / plan / assembly_design / interface_contracts | Control Plane | unchanged |
| cad_commit_candidate | Control Plane (Candidate Finalizer) | split in Phase 4, behavior byte-compatible |
| cad_transition, cad_wait_for_user, cad_finish | Control Plane | unchanged |
| cad_build_step | MODEL | build123d backend, Phase 5 |
| cad_inspect_visual | PROBE preset `visual` | Phase 2 |
| cad_inspect_geometry, cad_inspect_surfaces | PROBE preset `geometry` | Phase 2 |
| cad_inspect_section, cad_scan_sections | PROBE preset `section` | Phase 2 |
| cad_measure | PROBE preset `measure` | Phase 2 |
| cad_compare_geometry | PROBE preset `compare` | Phase 2 |
| cad_assembly_tree | PROBE preset `assembly` | Phase 2 |
| cad_inspect_interference | PROBE preset `interference` | Phase 2 |
| cad_probe_python | PROBE programmable mode | absorbed by unified cad_probe, Phase 3 |
| cad_simulate / cad_simulate_flow / cad_simulate_thermal | SIMULATE presets structural / flow / thermal | Phase 6 |
| cad_optimize | SIMULATE preset `optimize` | folds in, Phase 6 |
| cad_derive_analysis_model | SIMULATE preset `derivation` | MODEL-to-SIMULATE bridge, Phase 6 |
| cad_export | MODEL deliverable preset `export` | Phase 5/6 |
| cad_generate_drawing | MODEL deliverable preset `drawing` | Phase 5/6 |
| cad_render_scene | MODEL deliverable preset `render` | Phase 5/6 |

Deliverable generation (export / drawing / render / presentation) stays
inside MODEL as deliverable presets. It does not become a fourth module.

Simulation lifecycle:

1.  validate specification;
2.  freeze inputs;
3.  execute backend;
4.  collect results;
5.  produce observation;
6.  optionally create evidence.

------------------------------------------------------------------------

# 5. Core Interface Design

## 5.1 Artifact Contract

All modules communicate through ArtifactRef.

Required fields:

-   path;
-   hash;
-   representation;
-   role;
-   producer.

No module should exchange backend-native objects.

------------------------------------------------------------------------

## 5.2 Observation Bundle

All outputs should normalize into:

ObservationBundle

Contains:

-   visuals;
-   headline;
-   facts;
-   diagnostics;
-   provenance;
-   artifacts.

The Agent sees observations, not raw backend output.

------------------------------------------------------------------------

## 5.3 Phase Contract

Each workflow phase should compile into:

PhaseContract

Contains:

-   available capabilities;
-   required records;
-   required evidence;
-   valid decisions;
-   automatic observations;
-   context profile.

------------------------------------------------------------------------

# 6. Migration Strategy

## Phase 0: Freeze Behavior

Before refactoring:

-   add golden tests;
-   record current workflow behavior;
-   preserve state semantics.

No user-visible change.

------------------------------------------------------------------------

# Phase 1: Observation Layer

Implement:

-   ObservationBundle;
-   ObservationRenderer;
-   ObservationProfile.

Convert existing tool outputs.

Do not change tools yet.

------------------------------------------------------------------------

# Phase 2: Probe Registry

Create:

ProbeModule

Move existing implementations:

-   geometry;
-   measure;
-   section;
-   compare;
-   assembly;
-   interference.

Old tools become wrappers.

------------------------------------------------------------------------

# Phase 3: Unified cad_probe

Expose one Agent-facing observation tool.

Support:

-   preset mode;
-   programmable composition mode.

Keep design artifacts immutable.

------------------------------------------------------------------------

# Phase 4: Candidate Finalizer

Split:

MODEL execution

from

candidate review lifecycle.

Current cad_commit_candidate behavior remains.

------------------------------------------------------------------------

# Phase 5: Model Backend Adapter

Introduce:

ModelBackend interface.

First backend:

build123d.

Future:

-   CadQuery;
-   OpenCascade.

Adding a backend should not modify workflow code.

------------------------------------------------------------------------

# Phase 6: Simulation Module

Extract shared simulation lifecycle.

Convert:

-   structural;
-   CFD;
-   thermal;

into backend adapters.

------------------------------------------------------------------------

# Phase 7: Control Plane Refactor

Introduce PhaseContract compiler.

Replace:

phase -\> tool names

with:

phase -\> capability permissions.

------------------------------------------------------------------------

# Phase 8: Context Runtime v2

Add:

-   observation index;
-   visual retention;
-   context hydration.

Goal:

After compaction, the Agent can recover the important engineering visual
state.

------------------------------------------------------------------------

# 7. File Migration Plan

## Existing files to preserve

src/core/state-machine.ts

Role:

control authority.

------------------------------------------------------------------------

src/workflows/compiler.ts

Role:

route to process compilation.

------------------------------------------------------------------------

src/shared/protocol.ts

Role:

canonical schemas.

------------------------------------------------------------------------

src/shared/store.ts

Role:

artifact/state persistence.

------------------------------------------------------------------------

src/core/context-memory.ts

Role:

context lifecycle.

------------------------------------------------------------------------

## Files to introduce

src/control/

-   phase-contract.ts
-   control-engine.ts

src/modules/model/

-   registry.ts
-   backend.ts
-   finalizer.ts

src/modules/probe/

-   registry.ts
-   runtime.ts
-   presets/

src/modules/simulate/

-   registry.ts
-   lifecycle.ts

src/observations/

-   bundle.ts
-   renderer.ts
-   profiles.ts

------------------------------------------------------------------------

# 8. Testing Strategy

## Contract tests

Every backend must prove:

-   deterministic output;
-   correct provenance;
-   correct artifact binding.

------------------------------------------------------------------------

## Workflow equivalence tests

Verify:

-   phase graph;
-   obligations;
-   transitions;
-   acceptance behavior.

------------------------------------------------------------------------

## Observation tests

Verify:

-   visual priority;
-   stable summaries;
-   artifact references.

------------------------------------------------------------------------

## Regression benchmark

Maintain:

-   CADTestBench regression;
-   complexity-stratified internal benchmark.

Measure:

-   exact success;
-   requirement satisfaction;
-   observation usage;
-   token cost;
-   runtime.

------------------------------------------------------------------------

# 9. Final Design Philosophy

The final Pi-CAD should not be:

An LLM connected to many CAD tools.

It should be:

A CAD engineering runtime.

The core separation is:

Control decides what is allowed and required.

Modules decide how engineering computation is performed.

Observation decides what the Agent understands.

Context decides what the Agent remembers.

This architecture allows:

-   unlimited backend expansion;
-   strict engineering process control;
-   lower cognitive burden;
-   stronger long-horizon CAD reasoning.
