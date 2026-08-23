# Observation and Evidence

- An Observation is controlled context returned by a probe or observer. Evidence is a durable, version-bound workflow record.
- `cad_probe` is read-only. Its selectors and facts are bound to the exact artifact hash and expire when the candidate changes.
- Simulation is always Recipe-native: `cad_simulate` creates a frozen run and initial Observation; `cad_sim_observe` changes only the declared observation program; `cad_commit_simulation` creates Evidence.
- A successful solve does not create Evidence automatically. Evidence existence also does not mean engineering PASS.
- Evidence must match the current authoritative artifact or a verified derivation, exact case obligation, inputs, runtime identity, and observation hashes.
- When the artifact, requirements, inputs, or case is superseded, treat earlier conclusions as stale even if historical records remain auditable.
