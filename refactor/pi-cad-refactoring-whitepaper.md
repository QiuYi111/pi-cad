# Pi-CAD 0.9 Architecture Refactoring White Paper

## From CAD Agent Tool Collection to CAD Engineering Runtime

## 1. Motivation

Pi-CAD has already shown that practical CAD agents require more than
geometry generation. The core challenge is maintaining engineering
process state, design intent, evidence, and context over long workflows.

The refactoring goal is not to add more tools. It is to establish stable
engineering abstractions:

-   Control decides what must happen.
-   Modules decide how engineering work is executed.
-   Observation decides what the agent sees.
-   Context decides what the agent remembers.

## 2. Current Architecture Assessment

The current repository already contains strong foundations:

-   route-based workflow compilation;
-   phase-based mutation control;
-   obligation and evidence systems;
-   candidate generation and automatic review;
-   context memory and compaction.

The main limitations are:

1.  Tool surface grows with every capability.
2.  Workflow logic is coupled to backend implementations.
3.  Raw tool outputs are not separated from agent observations.
4.  Visual engineering context is not treated as a first-class runtime
    object.

## 3. Target Architecture

Pi-CAD evolves into four layers.

### Control Plane

Responsible for:

-   route;
-   workflow compilation;
-   phase contracts;
-   obligations;
-   acceptance;
-   state transitions.

This is the CAD-specific intelligence of Pi-CAD.

### Context Runtime

Responsible for:

-   canonical state;
-   working context;
-   archive;
-   compaction;
-   observation memory.

### Capability Modules

The agent-facing engineering capabilities become:

-   MODEL
-   PROBE
-   SIMULATE

### Observation Layer

All backend outputs are normalized into:

-   primary visuals;
-   key facts;
-   diagnostics;
-   provenance.

## 4. MODEL Module

MODEL creates engineering artifacts.

The current build123d flow becomes a backend adapter.

Future backends:

-   CadQuery;
-   OpenCascade;
-   FreeCAD.

All produce a common artifact contract.

MODEL creates candidates but does not decide acceptance.

## 5. PROBE Module

PROBE replaces many inspection tools with one programmable observation
interface.

Agent-facing API:

cad_probe

Internal presets:

-   visual;
-   geometry;
-   measurement;
-   section;
-   comparison;
-   assembly;
-   interference.

Advanced cases use programmable Python composition.

The principle:

Small interface, large implementation.

## 6. SIMULATE Module

Simulation becomes a unified engineering experiment layer.

Presets include:

-   structural FEA;
-   CFD;
-   thermal;
-   optimization.

The lifecycle:

specification -\> frozen inputs -\> solver -\> results -\> observation.

Simulation output follows visual-first ordering:

1.  engineering images;
2.  convergence;
3.  statistics;
4.  artifacts.

## 7. Control Plane Refactoring

Introduce PhaseContract.

A phase defines:

-   allowed capabilities;
-   required records;
-   required evidence;
-   valid decisions;
-   automatic transitions.

The workflow compiler produces contracts. The state machine executes
them.

## 8. Migration Roadmap

### Phase 1: Observation Foundation

Introduce:

-   ObservationBundle;
-   ObservationRenderer;
-   ObservationProfile.

No behavior change.

### Phase 2: Probe Registry

Move existing inspection implementations behind a common registry.

Existing tools become compatibility wrappers.

### Phase 3: Unified cad_probe

Expose:

-   preset queries;
-   programmable probe execution.

Keep canonical design immutable.

### Phase 4: Candidate Finalizer

Separate MODEL execution from candidate review.

Preserve current commit workflow.

### Phase 5: Simulation Module

Unify solver lifecycle.

### Phase 6: Phase Contract Compiler

Replace phase-specific tool lists with capability grants.

### Phase 7: Context Runtime Enhancement

Add observation index and visual rehydration.

## 9. Final Vision

Pi-CAD should not become an LLM with many CAD tools.

It should become:

A CAD engineering runtime that provides a controlled engineering process
around programmable computational modules.

The final architecture:

Control Plane + Context Runtime + Observation Layer + MODEL / PROBE /
SIMULATE
