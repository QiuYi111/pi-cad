---
name: reify-cad-worker
description: Delegate bounded mechanical/CAD engineering work to the persistent Reify/Pi-CAD worker over local MCP, supervise it at the engineering level, and consume compact evidence without importing the full CAD transcript.
---

# Reify CAD worker

Use the Reify CAD worker MCP tools when the deliverable is CAD geometry, a mechanical mechanism or fixture, a STEP/source package, geometric probing, or a Pi-CAD workflow. Do not recreate Pi-CAD operations manually. Do not use it for software bugs, docs, general research, or a one-line geometry question already answerable from visible context.

## Start and continue

1. Pick or create one stable Linux/WSL project directory. Windows callers may pass a Windows path; the MCP bridge converts it.
2. Call the worker `start` tool with `cwd`, the engineering objective, and optionally a workflow such as `mechanical.design`, `mechanical.modify`, `mechanical.analysis`, or the project's closer custom workflow.
3. Poll the `status` tool. Use the `events` tool with a cursor for new compact actions; do not request or paste the full Prime transcript.
4. Send follow-ups with the `send` tool using the same `session_id`. Keep design state and cwd in the worker session.
5. Call the `artifacts` tool when complete. Open STEP/source/evidence paths directly; verify hashes when the task requires delivery.

## Supervise, don't babysit

Inspect status/events at meaningful intervals or after a long no-progress interval. Step in for material signals: repeated identical tool failures, repeated builds against the same failed hypothesis, weaker validation used to force PASS, image/evidence contradiction, proxy evidence replacing authoritative geometry, large activity without artifact progress, or stale assumptions.

Use the `steer` tool for a targeted correction while the turn is running. Do not start a new session just to redirect it. Use the `interrupt` tool to stop the current action but keep the engineering state; then steer or send. Use `request_checkpoint` when you need a short state/evidence summary before deciding. Use `cancel` only to terminate the task; use `close` only when done.

## Blockers

If status reports `USER_DECISION_REQUIRED`, report the exact question and alternatives to the user. Do not guess a material requirement, safety decision, manufacturing process, load rating, or authoritative input. After the user answers, send the answer with the `send` tool to the same `session_id`. Treat `BLOCKED` as an honest failure requiring missing runtime, access, or user-owned input.

## Context boundary

The worker returns session state, compact event summaries, workflow/phase, progress metrics, blocker text, and artifact handles. Prime/Pi-CAD owns detailed CAD trajectory, externalized artifact state, build observation, probes/simulation, and workflow transitions. Keep only summaries and paths in Codex context; read the raw log handle/path only when debugging requires it.

## Host modes

The same MCP API is used by WSL Codex directly and Windows Codex through the Windows→WSL stdio bridge. Only `cwd`/path display changes. Return the caller-appropriate `paths.displayPath`; `windowsPath` is available when WSL interoperability is enabled.
