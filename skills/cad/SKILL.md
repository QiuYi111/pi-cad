---
name: cad
description: Use Pi-CAD's Python API in Prime's persistent IPython workspace for workflow state, generic commits, templates, controlled programmable probes, model builds, simulations, and review handoffs.
---

# Pi-CAD Python API

Use ordinary Python variables as working state and `import cad` as the small
engineering capability surface.

- Read `await cad.workflow.current()` before acting. If it is `None`, call
  `await cad.workflow.start(reason)`; when that returns `workflowId ==
  "mechanical/intake"`, immediately choose the complete route with
  `await cad.workflow.route("design", lineage="greenfield", structure="part",
  maturity="prototype", reason="greenfield single-part task")` before
  building. `reason` is optional, but an explicit task-specific reason is
  preferred. Never bypass an unstarted or unrouted workflow.
- Treat `current()["unmet"]` as exact process-level commit/evidence labels.
  For a workspace-commit obligation, use that exact label as the commit name:
  `await cad.commit((await cad.workflow.current())["unmet"][0], ...)`. Close
  every label in the current phase, then use one of the returned `transitions`
  events with `await cad.workflow.advance(event)`; do not invent a friendlier
  commit name, guess legacy semantic commit APIs, or inspect Pi-CAD source to
  discover events.
- Freeze stable handoffs with `await cad.commit(name, variables=..., artifacts=...)`.
- Load handoffs by ID with `await cad.load(id)`; do not copy child transcripts.
- Use `cad.templates` only as optional conveniences. Workflow never requires
  their schema unless a project workflow says so explicitly.
- Author project-local model source with build123d and expose a build123d `Shape` as
  `result`; `await cad.model.build(source, output)` exports the STEP artifact
  only after the v7 visual inspection chain has produced and attached all
  standard views to Prime. Missing visual output or attachment is a failed
  build. CadQuery source is not a supported model backend.
- Use `@cad.probe(subject=artifact_ref)` for Agent-authored, read-only B-Rep
  calculations on any project-local `ArtifactRef`. The legacy `"current"` and
  `"baseline"` subjects remain available for state-bound v7 runs. Pass all
  values explicitly; closures and unrestricted imports do not cross the effect
  fence.
- Submit an immutable final handoff with `await cad.review.submit(commit)`. This
  expands the Fresh Reviewer prompt and calls Prime's ordinary `rlm()` runtime;
  the returned value is only Prime's admission handle, not a completed review.
  Do not end the task after receiving the handle: remain active until the child
  delivers its independent verdict by review commit ID and `agent_message`,
  load that review commit, and apply the matching review transition. Never use
  transcript import or treat child admission as review completion.
- Write task-specific engineering checks in Python. There is no `cad.verify`.
- Keep large payloads in variables/files and print only selected summaries.

Prime owns sessions, compaction, memory, and subagents. Pi-CAD commits and
artifacts are the preferred handoff objects.
