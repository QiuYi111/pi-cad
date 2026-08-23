# Control tools

| Tool | Use |
|---|---|
| `cad_route` | Compile a new task route from objective, lineage, structure, and maturity. |
| `cad_reroute` | Apply a justified route change; downgrades may require explicit authority. |
| `cad_commit_requirements` | Commit the first complete task contract and evidence obligations. |
| `cad_revise_requirements` | Replace committed requirements after authoritative change and invalidate dependent conclusions. |
| `cad_commit_frame_context` | Record interpretation of an imported/baseline coordinate frame. |
| `cad_commit_plan` | Commit the current implementation or investigation plan. |
| `cad_commit_assembly_design` | Commit assembly architecture and ownership decisions. |
| `cad_commit_interface_contracts` | Commit explicit component/interface contracts. |
| `cad_commit_candidate` | Build and propose source-authored CAD with automatic observations. |
| `cad_submit_for_review` | Request independent final review after deterministic preflight. |
| `cad_transition` | Apply a phase decision defined by the compiled route. |
| `cad_wait_for_user` | Pause interactive work for a genuinely user-owned decision. |
| `cad_defer_clarification` | Record a bounded assumption and its impact when policy permits deferral. |
| `cad_declare_blocker` | Stop on missing external input, authority, or unavailable required capability. |
| `cad_finish` | Close a ready workflow; never use it to bypass unmet obligations. |
| `cad_commit_simulation` | Promote an exact run/Observation to case-scoped Evidence after inspection. |

Control tools mutate workflow state, not engineering geometry. A tool succeeding means the state transition was valid, not that the design is physically correct.
