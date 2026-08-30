---
name: cad
description: Use Pi-CAD's Python API in Prime's persistent IPython workspace for workflow state, generic commits, templates, controlled programmable probes, model builds, simulations, and review handoffs.
---

# Pi-CAD Python API

Use ordinary Python variables as working state and `import cad` as the small
engineering capability surface.

The complete public signatures needed by the author workflow are below. Call
them directly; importing `inspect`, reading docstrings, source files, or package
internals to rediscover these signatures is a workflow violation and is never a
valid adaptation step:

```text
cad.workflow.list() -> list[dict]
cad.workflow.start(workflow_id: str, *, interaction_mode: str = "interactive") -> dict
cad.workflow.current() -> dict | None
cad.workflow.advance(event: str) -> dict
cad.commit(
    name: str,
    *,
    parent: str | Commit | None = None,
    variables: dict | None = None,
    artifacts: list[str | Path | ArtifactRef] | None = None,
) -> Commit
cad.model.build(
    source: str | Path,
    output: str | Path | None = None,
    *,
    force: bool = False,
) -> ArtifactRef
cad.probe.run(
    *,
    subject: str | ArtifactRef = "current",
    purpose: str,
    code: str,
) -> ProbeResult
cad.review.submit(final_commit: Commit) -> dict
cad.review.current(handle: dict) -> dict | None
```

The three engineering calls are therefore canonical exactly as
`await cad.model.build("part.py", "part.step")`,
`await cad.probe.run(subject=artifact, purpose="...", code="result = {...}")`,
and `await cad.commit("name", variables={...}, artifacts=[...])`. There is no
reason to call `inspect.signature()` before using them.

- Read `await cad.workflow.current()` before acting. If it is `None`, inspect
  `await cad.workflow.list()` and start exactly one installed package, normally
  `await cad.workflow.start("mechanical.one-shot")` for greenfield design,
  `mechanical.modify` for an existing design change, `mechanical.analysis`
  for a bounded investigation, or a benchmark package only when the task or
  benchmark harness explicitly selects it. `mechanical.benchmark` uses one
  pre-build requirements reviewer. `mechanical.benchmark-author-only` is an
  explicit reviewer-free experiment: the author must choose `interpreted` only
  for a unique observable contract, or commit the competing readings and take
  `clarification_required` without building. Either package enters
  `wait_for_user` for a material ambiguity; in a headless benchmark, that is an
  accepted unscored exit for the current sample. Otherwise
  build the candidate, inspect it, commit `release` with the latest ArtifactRef
  and source, then take `delivered`. `start()` pins the current compiled package;
  never invent phase names or use a separate route protocol.
- When an experience library is available, you can look at prior trajectories
  to learn how others approached similar work; comparing high- and low-scoring
  examples may be useful.
- `current()` is the structured form of the same authoritative Phase Card. Read
  its `sop`, `must`, `can`, and `next` fields directly. Each item in
  `current()["obligations"]` includes `ref`, `type`, `closeWith`, and the exact
  `canonicalCall`; execute that closer instead of guessing an operation from
  the obligation's name. Only `type == "workspace_commit"` is closed by
  `cad.commit(ref, ...)`; visual and geometry evidence commonly share one
  managed `cad.model.build(...)` closer. After every obligation is closed, use
  one of the returned `transitions` events with
  `await cad.workflow.advance(event)`; do not invent a friendlier commit name,
  guess legacy semantic APIs, or inspect Pi-CAD source to discover events.
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
- Before construction, make the acceptance contract independent of the source:
  name authoritative dimensions, datums, axes, alignment, attachment planes,
  and intended Boolean effects, plus one plausible wrong interpretation that
  the checks must reject. After each Boolean or rebuild, verify the latest
  ArtifactRef for connected-solid count, bounds, retained datums, feature loci,
  and material added or removed at the intended location. Final checks retain
  every acceptance-critical invariant and every invariant that failed earlier;
  they must not merely recompute the same constants and transforms used to
  construct the model. In programmable probes, filter entities by geometric
  type before reading type-specific properties such as radius or axis.
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
  and artifact identity while a review is running or has a PASS/FAIL result.
  Runtime failures do not invalidate the candidate and may be resubmitted as a
  new reviewer attempt. Do not poll: the sidecar notifies Prime and triggers a
  new parent turn when the ordinary Fresh Reviewer template completes. The
  reviewer chooses the PASS/FAIL disposition and the sidecar atomically applies
  the corresponding workflow transition; the author must not guess or repeat
  it. On the new turn inspect `await cad.review.current(handle)` and continue
  from the newly injected Phase Card. Never treat admission as completion or
  import transcripts.
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

  This `final_commit` must be created while still in the build-capable PARTS or
  ASSEMBLY phase, after its required phase-obligation commit and before calling
  the transition into FINAL_REVIEW. The order is strictly phase obligation ->
  build -> probe -> review-candidate commit -> transition -> review.submit.
  FINAL_REVIEW intentionally cannot create or repair workspace commits.
  In PARTS, `cad.commit` closes only the `parts` workspace obligation.
  `parts-geometry` and `parts-visual` are evidence obligations closed by
  `cad.model.build`; never call `cad.commit` with those names. If the returned
  visual or a probe reveals a defect, edit the deterministic source and call
  `cad.model.build` again. A successful rebuild atomically revises those
  evidence obligations and invalidates every older `ArtifactRef`; overwrite the
  same `artifact` variable and never probe or submit an older handle. Never
  advance with an event that is absent from the current Phase Card `NEXT`.
  The first artifact must be the latest returned `ArtifactRef`, not its string
  path. `review.submit()` accepts the returned `Commit`, never an `ArtifactRef`,
  record ID, guessed ID, or earlier phase-obligation commit. Retain these Python
  objects directly; do not rediscover or guess commit identifiers.
  After the host review-complete event reports PASS, the workflow is already in
  RELEASE. Create the `release` obligation with
  `parent=final_commit` and `artifacts=list(final_commit.artifacts)`. This exact
  parent and artifact identity is required by the completion gate; do not
  reconstruct the list from paths or omit the deterministic source.
- Write task-specific engineering checks in Python. There is no `cad.verify`.
- Keep large payloads in variables/files and print only selected summaries.

Prime owns sessions, compaction, memory, and subagents. Pi-CAD commits and
artifacts are the preferred handoff objects.
