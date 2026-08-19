"""Analysis-model derivation records (0.8 review P0-6).

The 0.8 analysisModel guard proved the SOURCE was canonical, but not that
the derived geometry actually came from it: any unrelated STEP could claim
provenance and re-bind its evidence to the real design. This module makes
derivations harness-owned records instead of agent claims:

    fused | bonded   the harness performs the boolean union itself and
                     writes the output STEP — the derivation is mechanical
                     and fully verified;
    simplified |
    defeatured |
    sectioned        the Agent authors the model; the harness hashes both
                     ends at record time (authored: true). This proves the
                     chain was created through a harness tool against the
                     canonical source at a specific time — weaker than a
                     mechanical derivation, and labeled as such.

Simulations accept only { derivationRef } pointing at a stored record; the
guard re-verifies record.sourceHash is canonical and record.outputHash
matches the geometry actually being solved.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from .common import sha256_file

OPERATIONS_MECHANICAL = {"fused", "bonded"}
OPERATIONS_AUTHORED = {"simplified", "defeatured", "sectioned"}
ALL_OPERATIONS = OPERATIONS_MECHANICAL | OPERATIONS_AUTHORED

RECORD_SCHEMA_VERSION = 1


def validate_derive_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(spec, dict):
        return False, ["spec must be an object"]
    unknown = sorted(set(spec) - {"source", "operations", "output"})
    if unknown:
        errors.append(f"spec has unknown keys {unknown}; allowed keys are ['operations', 'output', 'source']")

    source = spec.get("source")
    if not isinstance(source, str) or not source.strip():
        errors.append("source is required (the authoritative design)")
    elif Path(source).suffix.lower() not in (".step", ".stp"):
        errors.append("source must be .step or .stp")
    elif not Path(source).is_file():
        errors.append(f"source does not exist: {source}")

    operations = spec.get("operations")
    if not isinstance(operations, list) or not operations:
        errors.append("operations must be a non-empty list")
    else:
        for op in operations:
            if op not in ALL_OPERATIONS:
                errors.append(f"operations entries must be one of {sorted(ALL_OPERATIONS)}; got {op!r}")
        mechanical = [op for op in operations if op in OPERATIONS_MECHANICAL]
        authored = [op for op in operations if op in OPERATIONS_AUTHORED]
        if mechanical and authored:
            errors.append("mechanical operations (fused/bonded) cannot be combined with authored ones (simplified/defeatured/sectioned)")

    output = spec.get("output")
    if output is not None and not isinstance(output, str):
        errors.append("output must be a path string")

    return not errors, errors


def run_derivation(spec_path: str | Path, output_dir: str | Path) -> dict[str, Any]:
    started = time.monotonic()
    spec_path = Path(spec_path)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    ok, errors = validate_derive_spec(spec)
    if not ok:
        raise ValueError("; ".join(errors))

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    source = Path(spec["source"]).resolve()
    operations = list(spec["operations"])
    mechanical = any(op in OPERATIONS_MECHANICAL for op in operations)
    source_hash = sha256_file(source)

    if mechanical:
        # The harness performs the union itself: the derivation is exactly
        # reproducible and cannot be an unrelated model in disguise.
        output = Path(spec.get("output") or output_dir / "analysis-model.step").resolve()
        with _union_part(source) as union:
            import build123d as bd

            bd.export_step(union, output)
        executed = True
    else:
        # Authored derivation: the Agent's model is hashed at record time.
        if not spec.get("output"):
            raise ValueError("authored operations require output (the model you authored)")
        output = Path(spec["output"]).resolve()
        if not output.is_file():
            raise ValueError(f"authored output does not exist: {output}")
        if output.resolve() == source.resolve():
            raise ValueError("authored output must differ from the source (use the canonical artifact directly instead)")
        executed = False

    output_hash = sha256_file(output)
    record: dict[str, Any] = {
        "schemaVersion": RECORD_SCHEMA_VERSION,
        "source": str(source),
        "sourceHash": source_hash,
        "operations": operations,
        "output": str(output),
        "outputHash": output_hash,
        "executed": executed,
        "notes": (
            "harness-executed boolean union: derivation is mechanically verified"
            if executed
            else "agent-authored model: the harness records the hash chain at creation time; the simplification itself is the Agent's modeling judgment"
        ),
        "durationMs": int((time.monotonic() - started) * 1000),
    }
    record_path = output_dir / "derivation.json"
    record_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    record["recordPath"] = str(record_path)
    return record


class _union_part:
    """Context manager producing the boolean union of a STEP's solids."""

    def __init__(self, source: Path):
        self.source = source

    def __enter__(self):
        import build123d as bd
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
        from OCP.TopTools import TopTools_ListOfShape

        shape = bd.import_step(self.source)
        solids = list(shape.solids())
        if not solids:
            raise ValueError("source contains no solids to fuse")
        result = solids[0].wrapped
        for solid in solids[1:]:
            args = TopTools_ListOfShape()
            args.Append(result)
            tools = TopTools_ListOfShape()
            tools.Append(solid.wrapped)
            fuse = BRepAlgoAPI_Fuse()
            fuse.SetArguments(args)
            fuse.SetTools(tools)
            fuse.SetRunParallel(False)
            fuse.Build()
            if not fuse.IsDone():
                raise RuntimeError("boolean fuse failed: derivation unresolved")
            result = fuse.Shape()
        return bd.Part(result)

    def __exit__(self, *exc):
        return False
