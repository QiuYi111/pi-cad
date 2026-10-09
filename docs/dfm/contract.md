# DFM kernel: module contract

The full design is in `implementation-plan.zh-CN.md` (this folder). This file fixes the
module names and interfaces so that work packages can be built in parallel. Do not
rename anything here without updating this file.

Standard plate thickness: the vendor has no table. `stock.standard_thickness` uses an
inferred list and its severity is **info** in all cases (never warn).

## Python package `python/reify_freecad/dfm/`

| Module | Owner | Public interface |
|---|---|---|
| `__init__.py` | WP1 | empty docstring only |
| `rulepack.py` | WP1 | `load_rulepack(rulepack_id: str) -> Rulepack`, `available_rulepacks() -> list[str]`. Dataclasses `Rulepack(id, title, vendor, source: dict, process: dict, materials: dict[str, dict], defaults: dict, tables: dict, rules: list[Rule])` and `Rule(id, check, layers: tuple[str, ...], severity, params: dict, source: dict, hint: str)`. Pure Python (only `yaml` + stdlib, no FreeCAD import). Validation is hand-written in this module (no jsonschema dependency). Errors: `ReifyOpError("DFM_RULEPACK_UNKNOWN", ..., hints=[available ids])`, `ReifyOpError("DFM_RULEPACK_INVALID", ..., detail={"path": ..., "reason": ...})`. Cached per process. |
| `rulepacks/quanzhou.cnc_mill.yaml` | WP1 | every rule ID of plan §5.1–§5.4, exactly those IDs |
| `rulepacks/quanzhou.cnc_turn.yaml` | WP1 | valid pack with `rules: []` and a comment pointing at plan §5.5 |
| `render_reference.py` | WP1 | `render(rulepack_id) -> str` (Markdown) and `python -m reify_freecad.dfm.render_reference <id>` prints it |
| `issues.py` | WP1 | `make_issue(rule, *, layer, target, measured=None, limit=None, unit="mm", severity=None, message=None, hints=None, extra=None) -> dict` and `summarize(issues, passes, *, max_items=8) -> dict` (see "Issue" and "Summary block" below) |
| `profile.py` | WP2 | op handler `dfm_profile(ctx, op)`; `get_profile(session) -> dict | None` returning `{"rulepack", "material", "overrides"}` |
| `sketch_metrics.py` | WP2 | `loop_metrics(loop: dict) -> dict` pure function on one closed loop as produced by `transfer._geometry`: `{"min_width", "corners": [{"at", "concave", "radius"}], "is_slot", "slot_width", "slot_length"}` |
| `extract.py` | WP2 | `extract_facts(ctx) -> dict` ("lint facts", see below). Reuse helpers from `transfer.py` by import; do not move code out of `transfer.py`. |
| `lint_checks.py` | WP2 | `LINT_CHECKS: dict[str, Callable[[dict, Rule, Rulepack], list[dict]]]` keyed by `Rule.check` |
| `lint.py` | WP2 | `evaluate(ctx) -> dict | None` (summary block, `None` when no profile) and `evaluate_full(ctx) -> {"issues", "coverage"}` |
| `asi.py` | WP4 | `find_reify_asi() -> Path | None`, `run_asi(brep: Path, checks: list[str], timeout_s: float) -> dict` |
| `geometry_checks.py` | WP4 | `GEOMETRY_CHECKS: dict[str, Callable[[dict, Rule, Rulepack], list[dict]]]` |
| `geometry.py` | WP4 | `evaluate_geometry(ctx, budget) -> {"issues", "coverage", "analyzer": "analysis_situs" | "builtin"}` |

A check function returns a list of issues. An empty list means the rule passed for
that input. A rule whose `check` has no function in the layer's table is reported in
`coverage` as `{"rule": id, "layer": ..., "status": "skipped", "reason": "not_implemented"}`.

## Issue

```json
{"rule": "hole.min_diameter", "severity": "error", "layer": "lint",
 "target": "bracket/mount_hole", "measured": 1.0, "limit": 1.2, "unit": "mm",
 "message": "...", "hints": ["..."], "source": "铨洲 v8.14 p.1"}
```

`target` is a semantic path string, or `{"body": str, "face": int, "centre": [x, y, z]}`
when no path is known. `source` is built from the rulepack (`vendor`, `source.version`,
rule `source.page`); add `" (inferred)"` when the rule has `source.inferred: true`.
Inferred rules never produce `error`: `make_issue` caps them at `warn`.

## Summary block (`dfm` field of every apply/try result)

```json
{"rulepack": "quanzhou.cnc_mill", "material": "al6061", "layer": "lint",
 "counts": {"error": 1, "warn": 2, "info": 3, "pass": 14},
 "issues": [ ...only error and warn, at most 8, errors first... ],
 "truncated": false,
 "geometry": {"state": "none" | "fresh" | "stale", "last_rev": null}}
```

`dfm` is `null` when the document has no profile. WP2 adds it in
`session._result()` right after `intent_module.evaluate_all(ctx)`.

## Lint facts (output of `extract_facts`)

```json
{"bbox": [dx, dy, dz], "volume_mm3": 0.0, "has_feature_tree": true,
 "bodies": [{"path": "bracket", "imported": false}],
 "holes": [{"path", "body", "diameter", "depth", "depth_type", "through",
            "threaded", "model_thread", "thread_size", "thread_depth",
            "cut_type", "cut_diameter", "cut_depth", "countersink_angle",
            "drill_point", "positions": [[x, y, z]], "axis": [x, y, z]}],
 "pockets": [{"path", "body", "depth", "through", "loops": [<loop_metrics>]}],
 "pads": [{"path", "body", "length", "loops": [<loop_metrics>]}],
 "fillets": [{"path", "body", "radius", "sides": ["top" | "bottom" | "vertical" | "unknown"]}],
 "chamfers": [{"path", "body", "size", "sides": [...]}],
 "requirements": [{"path", "kind", "target", "limit", "tolerance"}],
 "profile": {"rulepack", "material", "overrides"}}
```

## Op `dfm_profile` (WP2)

`{"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill" | null, "material": "al6061"}`.
Stored as one `App::VarSet` named `DfmProfile` with properties `Rulepack`, `Material`,
`Overrides` (JSON string). `rulepack: null` removes it. Errors `DFM_RULEPACK_UNKNOWN`,
`DFM_MATERIAL_UNKNOWN`. Register in `ops/schema.py` and `ops/__init__.py`.

## `reify-asi` (WP3)

- Source `native/reify-asi/` (C++17, CMake). Links Analysis Situs `asiAlgo` (tag
  `v2024.2`) and OCCT 7.6 only. No Qt, no VTK at run time if avoidable.
- Install script `scripts/bootstrap-asi.sh`, same style and exit codes as
  `scripts/bootstrap-freecad.sh`. Uses its own micromamba prefix with conda-forge
  `occt=7.6`, `eigen`, `rapidjson`, compilers and `cmake`. Install root
  `${PI_CAD_ASI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-cad/runtimes/asi}`;
  executable `<root>/bin/reify-asi` (a wrapper that sets the library path is fine);
  `<root>/runtime.json` with versions.
- CLI: `reify-asi analyze --in part.brep --out result.json --checks holes,cavities,blends,thickness,dihedral [--thickness-samples N]`.
  Exit 0 and write JSON on success; exit non-zero and print one error line on stderr otherwise.
- Output JSON (face IDs are 1-based in `TopExp::MapShapes` order):

```json
{"version": 1, "asi": "2024.2", "faces": 128,
 "holes": [{"faces": [12, 13], "diameter": 2.5, "depth": 7.5, "axis": [0, 0, -1], "through": false, "bottom": "flat" | "cone" | "sphere" | "unknown"}],
 "cavities": [{"faces": [20, 21], "base_faces": [5]}],
 "blends": [{"faces": [30], "radius": 1.0, "kind": "concave" | "convex"}],
 "thickness": [{"face": 7, "min": 0.8, "at": [1.0, 2.0, 3.0]}],
 "dihedral": [{"edge_faces": [3, 9], "angle_deg": 90.0, "convex": false, "edge_dir": [0, 0, 1]}],
 "timing_ms": {"load": 12}}
```

## Tests (WP6)

- E2E: `tests/freecad/test_dfm_e2e.py`, same harness style as `tests/freecad/test_part_backend.py`
  (real `Worker`, skipped without FreeCAD).
- Fixtures: `tests/fixtures/dfm/<case>/part.ops.json` (same op format as
  `skills/parametric-cad-modeling/assets/freecad-part/part.ops.json`, first op is
  `dfm_profile`) and `expect.json`:

```json
{"lint": {"must": [{"rule": "hole.min_diameter", "severity": "error"}], "must_not": ["..."]},
 "geometry": {"must": [...], "must_not": [...]},
 "geometry_builtin": {"must": [...], "must_not": [...]}}
```

- Unit tests: only the rulepack load/validation and `render_reference` output.

Run FreeCAD tests with:

```
E=~/.local/share/pi-cad/runtimes/freecad/env
PYTHONPATH=python:$E/lib PI_CAD_FREECAD_PYTHON=$E/bin/python $E/bin/python -m unittest discover -s tests/freecad
```

Known baseline failure before DFM work: `test_assembly.AssemblyTests.test_the_exported_assembly_names_every_occurrence`.
