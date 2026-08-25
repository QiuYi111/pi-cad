---
name: cad
description: Use Pi-CAD's Python API in Prime's persistent IPython workspace for workflow state, generic commits, templates, controlled programmable probes, model builds, simulations, and review handoffs.
---

# Pi-CAD Python API

Use ordinary Python variables as working state and `import cad` as the small
engineering capability surface.

- Read `await cad.workflow.current()` before acting. If it is `None`, inspect
  `await cad.workflow.list()` and start exactly one installed package, normally
  `await cad.workflow.start("mechanical.one-shot")` for greenfield design,
  `mechanical.modify` for an existing design change, or `mechanical.analysis`
  for a bounded investigation. `start()` pins the current compiled package;
  never invent phase names or use a separate route protocol.
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
  build. CadQuery source is not a supported model backend. When a benchmark or
  legacy task asks for CadQuery, preserve its requested geometry and dimensions
  but implement the managed candidate with build123d; do not probe for or try
  to install CadQuery.
- Prime's persistent IPython kernel is the Python runtime. Import packages and
  call the documented `cad` API directly in that kernel. Never launch a nested
  `python`/`python3`, `pip`, or `uv` subprocess to inspect the environment or
  perform CAD work, and never use a subprocess as an API-adaptation fallback.
- In live IPython, use `await cad.probe.run(subject=artifact_ref, purpose=...,
  code="result = {'solids': len(shape.solids())}")` for Agent-authored,
  read-only B-Rep calculations on any project-local `ArtifactRef`. The fenced
  program starts with `shape` (the imported build123d B-Rep) and
  `artifact_path` bound; it must assign a JSON-serializable value to `result`.
  `result` is an output name, not a pre-bound input—never read it before the
  assignment. Use `@cad.probe(...)` only for a synchronous
  function defined in a real source file, where Python can capture its source.
  The legacy `"current"` and `"baseline"` subjects remain available for
  state-bound v7 runs; unrestricted imports do not cross the effect fence.
- Submit an immutable final handoff with `handle = await cad.review.submit(commit)`.
  After the managed build and probes, create this handoff as a separate commit
  whose `artifacts` include the returned STEP `ArtifactRef` and its deterministic
  source (for example `final_commit = await cad.commit("review-candidate",
  artifacts=[artifact, "part.py"], variables=checks)`). Never submit an earlier
  phase-obligation commit or an empty commit; design review admission requires
  the exact canonical candidate path and hash.
  This returns immediately and is idempotent for the same workflow, contract,
  and artifact identity. Do not poll: the sidecar notifies Prime and triggers a
  new parent turn when the ordinary Fresh Reviewer template completes. On that
  turn inspect `await cad.review.current(handle)` and apply the matching legal
  review transition. Never treat admission as completion or import transcripts.
- Keep one current candidate variable. Every rebuild must overwrite both the
  same project output and that variable: `artifact = await cad.model.build(
  "part.py", "part.step")`. A successful rebuild invalidates every older
  `ArtifactRef`; never retain alternate `artifact_fixed`/`artifact_step`
  variables or submit a prior build. Use this exact final handoff shape:

  ```python
  checks = await cad.probe.run(subject=artifact, purpose="...", code="result = {...}")
  final_commit = await cad.commit(
      "review-candidate",
      artifacts=[artifact, "part.py"],
      variables={"checks": checks.value},
  )
  handle = await cad.review.submit(final_commit)
  ```

  The first artifact must be the latest returned `ArtifactRef`, not its string
  path. `review.submit()` accepts the returned `Commit`, never an `ArtifactRef`,
  record ID, guessed ID, or earlier phase-obligation commit. Retain these Python
  objects directly; do not rediscover or guess commit identifiers.
  After the host review-complete event reports PASS, take the legal PASS
  transition, then create the `release` obligation with
  `parent=final_commit` and `artifacts=list(final_commit.artifacts)`. This exact
  parent and artifact identity is required by the completion gate; do not
  reconstruct the list from paths or omit the deterministic source.
- Write task-specific engineering checks in Python. There is no `cad.verify`.
- Keep large payloads in variables/files and print only selected summaries.

Prime owns sessions, compaction, memory, and subagents. Pi-CAD commits and
artifacts are the preferred handoff objects.
