# 0001. Remove the v6 kernel

Status: accepted
Date: 2026-10-09

## Context

Two engines live in the repo. The v6 kernel (`src/core`, `src/control`, selected by `PI_CAD_KERNEL=v6`) is the old
controller. The v7 Harness Kernel (`src/harness`) is the current one. v7 still depends on v6 code. The mechanical action
registrations are written in v6 `src/core/controller.ts`, the phase table comes from `core` and `control`, and shared
vocabulary sits next to v6 state types in `shared/protocol.ts`. About 100 tests cover only v6, mostly in workflow-core.

## Decision

The v7 Harness Kernel is the only engine. Before deleting v6, the parts v7 uses move out (action registration and
phase table into `src/domains/mechanical`, shared vocabulary out of v6 types). Then the v6 code and its tests are deleted.

An unfinished v6 run that is still on disk is refused with a clear message. There is no migration.

## Consequences

- About 4 to 5 thousand lines of v6 source go, and v6-only tests are deleted.
- Rules that only v6 tests guard need a v7 end-to-end test first, or an explicit product decision that drops them:
  release closure, assembly record gate, frame-context gate, stale record fallback, reroute approval and token scope,
  reviewer source visibility, FAIL/UNRESOLVED vote handling, tool availability across phases, context archive isolation.
- Projects from v3 to v5 must still open under v7. This is checked by `schema-migration` before the removal lands.
- Old unfinished v6 runs are not carried over. The refusal message is the only handling they get.
