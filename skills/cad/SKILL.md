---
name: cad
description: Use Pi-CAD's Python API in Prime's persistent IPython workspace for workflow state, generic commits, templates, controlled programmable probes, model builds, simulations, and review handoffs.
---

# Pi-CAD Python API

Use ordinary Python variables as working state and `import cad` as the small
engineering capability surface.

- Read `await cad.workflow.current()` before acting.
- Freeze stable handoffs with `await cad.commit(name, variables=..., artifacts=...)`.
- Load handoffs by ID with `await cad.load(id)`; do not copy child transcripts.
- Use `cad.templates` only as optional conveniences. Workflow never requires
  their schema unless a project workflow says so explicitly.
- Author model source with build123d and expose a build123d `Shape` as
  `result`; `await cad.model.build(source, output)` exports the STEP artifact
  and fails if source execution or export fails. CadQuery source is not a
  supported model backend.
- Use `@cad.probe(subject=artifact_ref)` for Agent-authored, read-only B-Rep
  calculations on any project-local `ArtifactRef`. The legacy `"current"` and
  `"baseline"` subjects remain available for state-bound v7 runs. Pass all
  values explicitly; closures and unrestricted imports do not cross the effect
  fence.
- Submit an immutable final handoff with `await cad.review.submit(commit)`. This
  expands the Fresh Reviewer prompt and calls Prime's ordinary `rlm()` runtime;
  the returned value is Prime's admission handle. The child delivers its
  independent verdict by review commit ID and `agent_message`, not by transcript
  import or a special reviewer runtime.
- Write task-specific engineering checks in Python. There is no `cad.verify`.
- Keep large payloads in variables/files and print only selected summaries.

Prime owns sessions, compaction, memory, and subagents. Pi-CAD commits and
artifacts are the preferred handoff objects.
