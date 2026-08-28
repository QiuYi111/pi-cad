# Experience retrieval

Pi-CAD archives completed agent trajectories losslessly. Use retrieval when a prior run may reduce repeated work or expose a known failure mode.

- `cad_experience_search`: apply metadata filters and deterministic keyword ranking.
- `cad_experience_get`: inspect identity, metrics, human evaluation, and archive paths.
- `cad_experience_find`: locate relevant transcript passages before reading them.
- `cad_experience_read`: read bounded line ranges; do not load a large trajectory wholesale.

Human quality and difficulty ratings are authoritative. Archived transcripts and raw metrics are canonical; the versioned score is only a sorting aid. Keyword absence is not proof that no semantically similar experience exists.
