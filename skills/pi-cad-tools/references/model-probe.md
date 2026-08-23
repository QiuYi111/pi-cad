# Model and probe tools

## Model

- `cad_build_step`: deterministically execute build123d source. Prefer `cad_commit_candidate` when proposing design work.
- `cad_derive_analysis_model`: create provenance for fused, bonded, simplified, defeatured, or sectioned solver subjects. Never pass an unbound convenience model to simulation.

## Probe

- `cad_probe`: the only inspection entrypoint. Prefer the narrowest preset: `visual`, `geometry`, `surfaces`, `measure`, `section`, `sections_scan`, `compare`, `assembly`, or `interference`; use `python` only for a read-only quantity no typed preset expresses.
- `cad_recall_observation`: reattach historical images and facts after context compaction. Re-probe when artifact identity changed.

`cad_probe` accepts explicit artifact arguments for ordinary presets or resolves current/baseline subjects from workflow state. Programmable probes cannot access arbitrary paths, imports, subprocesses, network, or filesystem mutation. Surface and topology selectors are artifact-hash scoped.

## Export

- `cad_export`: produce STEP/STL/GLB/BREP sidecars from source or an artifact. Export does not update Project Head.
