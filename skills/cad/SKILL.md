---
name: cad
description: Use Pi-CAD's Python API in Prime's persistent IPython workspace for workflow state, generic commits, templates, controlled programmable probes, model builds, simulations, and review handoffs.
---

# Pi-CAD Python API

Use ordinary Python variables as working state and `import cad` as the small
engineering capability surface.

When acceptance needs structural, flow, or thermal evidence, load the `pi-cad`
skill and the matching `structural-analysis` or `thermal-fluid-analysis` skill
before checking Python. Managed choices already include OpenFOAM 14, SU2 8.5.0,
and torch-fem 0.9 CPU/CUDA; discover readiness through
`await cad.workflow.current()` and run them through Pi-CAD Recipes. Python packages are not the solver catalog.

The complete public signatures needed by the author workflow are below. Call
them directly; importing `inspect`, reading docstrings, source files, or package
internals to rediscover these signatures is a workflow violation and is never a
valid adaptation step:

```text
cad.workflow.list() -> list[dict]
cad.workflow.start(workflow_id: str, *, interaction_mode: str = "interactive") -> dict
cad.workflow.current() -> dict | None
cad.workflow.advance(event: str) -> dict
cad.save_and_check(record: str, source: str | Path, output: str | Path | None = None, *, variables=None, artifacts=None, force=False, validation="auto", parameters=None) -> SaveAndCheckResult
cad.commit(
    name: str,
    *,
    parent: str | Commit | None = None,
    variables: dict | None = None,
    artifacts: list[str | Path | ArtifactRef] | None = None,
) -> Commit
cad.plan.current() -> Commit | None
cad.plan.update(*, variables: dict | None = None, artifacts: list | None = None) -> Commit
cad.part.open(path: str | Path, *, output: str | Path | None = None, create: bool = False, body: str | None = None, validation: str = "auto") -> PartDocument
PartDocument.apply(ops: list[dict], *, message: str | None = None, validation: str = "auto", budget_s: float | None = None) -> PartResult
PartDocument.try_(ops: list[dict], *, budget_s: float | None = None) -> PartResult
PartDocument.undo() -> PartResult
PartDocument.tree() -> dict
PartDocument.query(target: str, what: list[str] | None = None) -> dict
PartDocument.check(kind: str, *, budget_s: float | None = None, **args) -> dict
PartDocument.sweep(param: str, range: tuple[float, float], *, step: float, check: tuple[str, dict], refine: bool = False, budget_s: float | None = None) -> dict
cad.transfer.status() -> TransferStatus
cad.transfer.features(doc: str | Path | PartDocument) -> TransferFeatures
cad.transfer.export(doc: str | Path | PartDocument, *, target: str, output: str | Path | None = None, check: bool = True) -> TransferJob
TransferJob.result() -> TransferResult
cad.model.build(   # build123d compatibility path
    source: str | Path,
    output: str | Path | None = None,
    *,
    force: bool = False,
    validation: str = "auto",
    parameters: dict[str, dict] | None = None,
) -> ArtifactRef
cad.model.import_step(source: str | Path, output: str | Path | None = None) -> ArtifactRef
cad.model.solidify_step(source: str | Path, output: str | Path | None = None) -> ArtifactRef
cad.probe.run(
    *,
    subject: str | ArtifactRef = "current",
    purpose: str,
    code: str | None = None,
    script: str | Path | None = None,
    args: dict | None = None,
) -> ProbeResult
cad.review.submit(final_commit: Commit) -> dict
cad.review.current(handle: dict) -> dict | None
cad.review.prepare(candidate: Commit) -> dict
```

Model new parts and assemblies with `cad.part` (next section). The build123d calls
below are the compatibility path, canonical exactly as
`await cad.model.build("part.py", "part.step")` for an existing build123d source,
`await cad.model.import_step("imports/reference.step")` for existing STEP files in the project,
including face-only supplier models. This returns a reference artifact with seven
views. A reference is not an authoritative CAD candidate; a solid candidate
still needs `cad.model.build(...)`. Do not turn supplier surfaces into fake
solids just to pass candidate validation.
For a surface-only STEP that is actually closed, use
`await cad.model.solidify_step("imports/supplier.step")`. Pi-CAD sews its
existing faces only and returns a validated solid candidate. Open surfaces
fail clearly; do not write ad hoc OCP code or add arbitrary thickness.
`await cad.probe.run(subject=artifact, purpose="...", code="result = {...}")`,
and `await cad.commit("name", variables={...}, artifacts=[...])`. There is no
reason to call `inspect.signature()` before using them.

## Parts and assemblies: `cad.part` is the default

`cad.part` creates and edits a parametric FreeCAD model with small JSON ops
instead of rewriting a script. Use it first for every new part and every
assembly: dimensions that change, features added one at a time, poses swept for
collisions, parts linked into an assembly. `cad.model.build` with build123d is
only a compatibility path (below).

```python
doc = await cad.part.open("parts/bracket.FCStd", create=True, body="bracket")
r = await doc.apply([
    {"op": "param", "name": "width", "value": 40, "unit": "mm"},
    {"op": "sketch", "name": "bracket/base_profile", "plane": "XY",
     "shapes": [{"rect": {"center": [0, 0], "size": ["=width", 20]}}]},
    {"op": "pad", "name": "bracket/base", "sketch": "bracket/base_profile", "length": 5},
])
r.artifact   # an ArtifactRef; pass it to cad.probe.run like a built artifact
```

- Every `open`, `apply`, `undo` and `try_` attaches the seven standard views and
  names what changed. All seven views are always attached; do not skip or reduce
  them. Faces on a surface the previous build did not have are orange; features
  are labelled by name. The first image's text starts with
  `Changes since previous build:`. Read it, then look at the views, before the
  next edit.
- `apply` is one transaction. If an op or the recompute fails, nothing changed:
  the `CadApiError` carries `code`, `target`, `detail`, `hints` and
  `rolled_back`. Fix the named op and send the batch again.
- Faces and edges are named by role (`bracket/mount_hole/wall`, `top_outer`),
  never `Face12`. The names survive dimension edits and added features.
- `try_` shows an edit and discards it. `check` and `sweep` read the in-memory
  model (clearance, interference, wall thickness, mass, pose sweeps) without
  exporting a STEP.
- One part, one document. One assembly, one document. A part is
  `parts/<name>.FCStd` with one owner; the assembly is
  `assembly/<name>.FCStd` and links the parts with `link`, adds bought-in STEP
  files with `import_step`, and seats parts with `joint` (revolute, prismatic,
  fixed). A joint name can be swept like a parameter. A new revision of a part
  reaches the assembly on its next call.
- Delegating an assembly: give each subagent one part document (see "Delegated
  CAD work" for its folder). The parent builds none of the parts: it links their
  documents, joints them, and checks interference and clearance on occurrence
  paths.
- If a call raises `CadApiError` with `code == "FREECAD_NOT_INSTALLED"`, this is
  a normal first-run state. Tell the user the one command, `npm run setup:freecad`
  (about 4.2 GB, no sudo, once), and stop. Do not try to install FreeCAD
  yourself, and do not fall back to build123d on your own.
- Read `skills/parametric-cad-modeling/references/freecad-part-ops.md` before
  the first `cad.part` call in a task: the full op table, role names, assemblies,
  error codes, and worked examples. The copyable starting points are the
  `freecad-part` and `freecad-assembly` assets of the `parametric-cad-modeling`
  skill.

## Fusion and SolidWorks files: `cad.transfer`

Use `cad.transfer` only when the user asks for a Fusion (`.f3d`) or SolidWorks
(`.SLDPRT`) file with feature history. For a plain exchange file, export a STEP.
The CAD program runs on the user's computer and the Reify desktop app starts it.

```python
features = await cad.transfer.features("parts/bracket.FCStd")   # dry run first
job = await cad.transfer.export("parts/bracket.FCStd", target="fusion", output="exports/bracket.f3d")
result = await job.result()    # TransferResult(..., check='passed', ...)
```

- Run `features` first. It needs no CAD program. It raises
  `TRANSFER_UNSUPPORTED_OP` and names the feature (`target`) that the targets
  cannot build yet. Supported: `pad`, `pocket`, through-all `hole`,
  `polar_pattern`. Not supported: fillet, chamfer, `linear_pattern`, `mirror`,
  blind, counterbore, countersink and threaded holes, and sketches on a face.
  Tell the user which feature blocks the export. Do not change the model only
  to make an export pass.
- `status()` shows if a target is ready. `export` reads the committed document and
  never changes it. `check=True` compares the exported shape with the Reify
  STEP. Never give the user a file from a failed check.
- Error codes: `TRANSFER_TARGET_NOT_READY` (tell the user to open Settings, CAD
  exports), `TRANSFER_UNSUPPORTED_OP`, `TRANSFER_EXECUTOR_FAILED`,
  `TRANSFER_CHECK_FAILED` (`detail` names the first feature that differs),
  `TRANSFER_TIMEOUT`, `TRANSFER_UNAVAILABLE` (no desktop app: offer a STEP).
- The coordinate system stays Z up in the exported file. Use `check='skipped'`
  results (`check=False`) only to debug.

## build123d compatibility

Use `cad.model.build` only to edit an existing build123d source, to build
geometry the `cad.part` ops cannot express yet, or when the user asks for
build123d. For the second case, say in your reply which op is missing, so it can
be added. The mandatory seven views and every build rule below stay the same.

## Delegated CAD work

Prime subagents can use this same `cad` API to build and inspect their own
candidate. At the start of a delegated task, confirm that `import cad`,
`await cad.workflow.current()`, and `await cad.workflow.list()` work. If a
required host connection or API is missing, report which one failed and stop;
do not guess package names, install CAD libraries, or create a replacement
service.

The parent assigns each parallel task a unique project-relative folder such as
`subagents/<task-name>/`. Keep that task's source and generated files there,
including its STEP output, so two agents never write `module.py` or
`output.step` at the same path. Build and probe the latest artifact, then return
its exact `ArtifactRef` and selected evidence to the parent. A child uses its
own Prime conversation and kernel; it must not use or change the parent's run
binding or candidate. The parent inspects the returned artifact and explicitly
chooses whether to use it in the assembly.

For a `cad.part` assembly, the split is one part document per subagent, such as
`subagents/<task-name>/parts/<part>.FCStd`. The subagent applies ops to its own
document and returns the document path, the body path, and the roles the parent
needs for joints. The parent owns the assembly document: it uses `link` with
those paths, `joint` between roles, and `check`/`sweep` on occurrence paths. A
subagent never edits the assembly or another part's document.

- Read `await cad.workflow.current()` before acting. If it is `None`, always call
  `await cad.workflow.list()` and route the request to exactly one workflow from
  that live list. Workflows are user-maintained project data as well as built-in
  packages; never assume a fixed default or a fixed catalog. Compare the request
  with each workflow's description and tags. A matching project workflow takes
  precedence. Use `mechanical.default` for normal production work: plan the real
  task, execute freely, and finish when the real task is complete. Review is an
  optional capability in this workflow, not a gate. Use `mechanical.naked` only when the user requests a tools-only run or
  an explicit baseline experiment; it provides no Phase Contract, milestones,
  obligations, or prescribed process. The author model makes this routing choice
  after reading the live catalog. An adopted version selects the version after
  an ID has been routed; it does not select the workflow ID. `start()` pins the
  current compiled package; never invent phase names or use a separate route
  protocol.
- When an experience library is available, you can look at prior trajectories
  to learn how others approached similar work; comparing high- and low-scoring
  examples may be useful.
- `current()` is the structured form of the same authoritative Phase Card. Read
  its `sop`, `must`, `can`, and `next` fields directly. Each item in
  `current()["obligations"]` includes `ref`, `type`, `closeWith`, and the exact
  `canonicalCall`; execute that closer instead of guessing an operation from
  the obligation's name. Only `type == "workspace_commit"` is closed by
  `cad.commit(ref, ...)`; visual and geometry evidence commonly share one
  managed `cad.part` `apply(...)` or `cad.model.build(...)` closer. After every obligation is closed, use
  one of the returned `transitions` events with
  `await cad.workflow.advance(event)`; do not invent a friendlier commit name,
  guess legacy semantic APIs, or inspect Pi-CAD source to discover events.
- Freeze stable handoffs with `await cad.commit(name, variables=..., artifacts=...)`.
- The Plan is living state backed by immutable commits. Use
  `await cad.plan.current()` to load only the latest Plan. When new user input,
  evidence, or a material strategy change makes it stale, call
  `await cad.plan.update(variables=..., artifacts=["plan.md"])` from COOK. Keep
  current requirements and acceptance criteria separate from revisable execution
  strategy. Later user instructions override older Plan versions.
- Load handoffs by ID with `await cad.load(id)`; do not copy child transcripts.
- Use `cad.templates` only as optional conveniences. Workflow never requires
  their schema unless a project workflow says so explicitly.
- Author new parts and assemblies with `cad.part`. When the compatibility path
  applies, author project-local model source with build123d and expose a
  build123d `Shape` as `result`; `await cad.model.build(source, output)` exports the STEP artifact
  only after the v7 visual inspection chain has produced and attached all
  standard views to Prime. Missing visual output or attachment is a failed
  build. CadQuery source is not a supported model backend. When a benchmark or
  legacy task asks for CadQuery, preserve its requested geometry and dimensions
  but implement the managed candidate with `cad.part`, or with build123d only
  if the ops cannot express it; do not probe for or try to install CadQuery.
- Choose build validation deliberately: `validation="auto"` fully checks small
  parts and defers expensive per-solid self-intersection checks for large
  assemblies; `validation="fast"` is for iteration; `validation="full"` runs
  every check and is required before release when an earlier build deferred one.
- When the user should tune dimensions in the desktop Viewer, expose
  `build(parameters) -> Shape` instead of `result` and pass the small UI
  declaration once through `cad.model.build(..., parameters={"width":
  {"default": 40, "min": 20, "max": 80, "step": 1, "unit": "mm"}})`.
  Keep derived dimensions inside that function. This registers the panel;
  ordinary models need no parameter declaration.
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
  Blender presentation is the sole exception: follow the
  `blender-product-rendering` skill and invoke Blender through
  `sys.executable -m cadctl blender`; never call `blender` from `PATH` or
  `/usr/bin/blender`.
- In live IPython, use `await cad.probe.run(subject=artifact_ref, purpose=...,
  code="result = {'solids': len(shape.solids())}")` for Agent-authored,
  read-only B-Rep calculations on any project-local `ArtifactRef`. The fenced
  program starts with `shape` (the imported build123d B-Rep) and
  `artifact_path` bound; it must assign a JSON-serializable value to `result`.
  `result` is an output name, not a pre-bound input—never read it before the
  assignment. Use `@cad.probe(...)` only for a synchronous
  function defined in a real source file, where Python can capture its source.
  For reusable programs, pass `script="checks/probe.py"`; pass structured
  JSON values with `args={...}`. Inside either program form, decoded values are
  available as `params`; the decorator forwards named arguments through this
  channel. Done workflows allow observations only with an explicit,
  hash-bound project `ArtifactRef`.
  The probe preloads a resolver for the shared, hash-bound identity manifest.
  It returns identity metadata and B-Rep objects from the same imported STEP;
  `.object` requires one match and `.objects` exposes an explicitly requested
  collection. The preloaded measurement helper reuses the managed implementation
  on the loaded shape, including hash-bound semantic names and geometry refs.
  The legacy `"current"` and `"baseline"` subjects remain available for
  state-bound v7 runs; unrestricted imports do not cross the effect fence.
- For movable designs, treat the concept as a kinematic hypothesis and the
  programmable Probe as its geometric proof. Write task-specific equations in
  `cad.probe.run`; transform copies of the moving bodies and measure collision
  and clearance across the complete required range. Do not infer feasibility
  from appearance or test only the start and endpoint. Refine sampling around
  contact, low clearance, solver failure, and singularity. Return the range,
  sample coverage or tolerance, minimum-clearance pose, first failure,
  unreachable or singular states, endpoint reachability, and pass/fail result.
  Use `analysisLevel="fast"`, `"standard"`, or `"full"` in that result to state
  the strength of the proof; this is an evidence label, not a separate solver.
  For finite rigid-pose batches, Python probes preload single-pose and batch
  interference helpers; both use the same exact AABB/common implementation as
  the interference preset. Batch transforms use solid indexes from the
  current hash-bound STEP, translation in mm, and Euler rotation in degrees.
  Batch output reports each pose and failure and states that it sampled only
  those poses.
  Preloaded named-group helpers accept semantic path pairs and optional poses,
  resolving groups without importing the STEP again.
- Use `await cad.probe.run(subject=artifact_ref, preset="visual",
  args={"views": ["right", "top"]})` when another direction would resolve a
  visual question. Choose only the views needed from `iso`, `front`, `back`,
  `left`, `right`, `top`, `bottom`, and `iso_opposite`. For a crowded
  assembly, keep the same call and add `focus`, `hide`, `explode`, or
  `display="solid_with_edges"` inside `args`; use occurrence refs returned by
  `preset="assembly"` rather than guessing part order.
  The read-only render is hash-bound, recorded as an immutable observation,
  and attached directly to Prime. Do not ask the author or user for another
  screenshot when this operation can answer the question.
- In `mechanical.default`, spawn temporary specialist reviewers only when they are
  likely to add information. First freeze a candidate commit, then call
  `brief = await cad.review.prepare(candidate)` and give that brief to the spawned
  reviewer. The reviewer loads the exact candidate and latest Plan, visually
  inspects it, and runs targeted probes when useful. It returns `findings`,
  `uncertainties`, and `suggested_checks`, classifying material issues as
  `candidate_defect`, `plan_stale`, or `missing_evidence`. Its advice never changes
  workflow state; the author verifies it and decides what to do. Multiple focused
  reviewers may run concurrently when each has a distinct question. Do not spawn
  reviewers by default.
- `cad.review.submit()` is reserved for workflows whose active phase explicitly
  exposes an authoritative review action. Submit an immutable final handoff with
  `handle = await cad.review.submit(commit)` only in such a workflow. Follow that
  workflow's live Phase Card; these rules do not apply to `mechanical.default`.
- Keep one current candidate variable. Every rebuild must overwrite both the
  same project output and that variable: `artifact = await cad.model.build(
  "part.py", "part.step")`. A successful rebuild invalidates every older
  `ArtifactRef`; never retain alternate `artifact_fixed`/`artifact_step`
  variables or inspect a prior build as if it were current.
- Write task-specific engineering checks in Python. There is no `cad.verify`.
- Keep large payloads in variables/files and print only selected summaries.

Prime owns sessions, compaction, memory, and subagents. Pi-CAD commits and
artifacts are the preferred handoff objects.
