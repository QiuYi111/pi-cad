"""Recipe-owned SU2 solid-thermal compiler and result collector.

V1 scope: constant thermal conductivity, fixed-temperature and fixed
heat-flux boundaries, adiabatic remainder, steady state.

Unit contract: geometry per ``geometryUnits`` (mm default); thermal
quantities SI (K, W/m^2, W/(m*K)). The result reports fields, integrated
heat rates, and energy balance only — never safety or acceptance.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from ..common import read_json, resolve_spec_path
from .su2_backend import Su2UnavailableError, pre_hash_artifacts, run_su2, verify_unchanged
from .su2_config import compile_thermal_cfg, write_cfg
from .su2_mesh import mesh_step_su2
from .su2_parse import (
    boundary_heat_rates,
    calibrate_temperature_scale,
    converged,
    fields_summary,
    node_gradients,
    parse_history,
    read_su2_elements,
    read_volume_fields,
)

_SPEC_KEYS = {"caseId", "artifact", "analysisModel", "geometryUnits", "material", "boundaries", "mesh", "convergence"}


_ANALYSIS_MODEL_KEYS = {"derivationRef"}
_MATERIAL_KEYS = {"conductivityWPerMK"}
_MESH_KEYS = {"maxSizeMm", "minSizeMm"}
_BOUNDARY_KEYS = {"type", "surfaces", "temperatureK", "heatFluxWPerM2"}
_CONVERGENCE_KEYS = {"maxIterations", "residualTarget"}


def _validate_analysis_model(spec: dict[str, Any], errors: list[str]) -> None:
    """Fail-closed validation of the analysisModel declaration (0.8 review P0-6).

    The declaration points at a harness-owned derivation record created by
    cad_derive_analysis_model — not a free-form {source, operations} claim.
    """
    model = spec.get("analysisModel")
    if model is None:
        return
    if not isinstance(model, dict):
        errors.append("analysisModel must be an object {derivationRef}")
        return
    _reject_unknown(model, _ANALYSIS_MODEL_KEYS, "analysisModel", errors)
    ref = model.get("derivationRef")
    if not isinstance(ref, str) or not ref.strip():
        errors.append("analysisModel.derivationRef is required (a cad_derive_analysis_model record path)")
    elif not Path(ref).is_file():
        errors.append(f"analysisModel.derivationRef does not exist: {ref}")


def _reject_unknown(obj: Any, allowed: set[str], where: str, errors: list[str]) -> None:
    if isinstance(obj, dict):
        unknown = sorted(set(obj) - allowed)
        if unknown:
            errors.append(f"{where} has unknown keys {unknown}; allowed keys are {sorted(allowed)}")


def validate_thermal_spec(spec: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(spec, dict):
        return False, ["spec must be an object"]
    _reject_unknown(spec, _SPEC_KEYS, "spec", errors)

    case_id = spec.get("caseId")
    if not isinstance(case_id, str) or not case_id.strip():
        errors.append("caseId is required (it binds the evidence obligation to this run)")

    artifact = spec.get("artifact")
    if not isinstance(artifact, str) or not artifact.strip():
        errors.append("artifact is required: thermal analysis needs a STEP solid")
    elif Path(artifact).suffix.lower() not in (".step", ".stp"):
        errors.append("artifact must be .step or .stp in V1")
    elif not Path(artifact).is_file():
        errors.append(f"artifact does not exist: {artifact}")

    _validate_analysis_model(spec, errors)

    if spec.get("geometryUnits", "mm") not in ("mm", "m"):
        errors.append("geometryUnits must be mm or m in V1")

    material = spec.get("material")
    if not isinstance(material, dict):
        errors.append("material is required")
    else:
        _reject_unknown(material, _MATERIAL_KEYS, "material", errors)
        conductivity = material.get("conductivityWPerMK")
        if not isinstance(conductivity, (int, float)) or isinstance(conductivity, bool) or conductivity <= 0:
            errors.append("material.conductivityWPerMK must be a number > 0")

    mesh = spec.get("mesh")
    if not isinstance(mesh, dict):
        errors.append("mesh is required")
    else:
        _reject_unknown(mesh, _MESH_KEYS, "mesh", errors)
        max_size = mesh.get("maxSizeMm")
        if not isinstance(max_size, (int, float)) or isinstance(max_size, bool) or max_size <= 0:
            errors.append("mesh.maxSizeMm must be a number > 0")
        if "minSizeMm" in mesh:
            min_size = mesh.get("minSizeMm")
            if not isinstance(min_size, (int, float)) or isinstance(min_size, bool) or min_size <= 0:
                errors.append("mesh.minSizeMm must be a number > 0")

    convergence = spec.get("convergence")
    if isinstance(convergence, dict):
        _reject_unknown(convergence, _CONVERGENCE_KEYS, "convergence", errors)

    boundaries = spec.get("boundaries")
    if not isinstance(boundaries, list) or not boundaries:
        errors.append("boundaries is required")
    else:
        saw_temperature = False
        for index, boundary in enumerate(boundaries):
            where = f"boundaries[{index}]"
            if not isinstance(boundary, dict):
                errors.append(f"{where} must be an object")
                continue
            _reject_unknown(boundary, _BOUNDARY_KEYS, where, errors)
            kind = boundary.get("type")
            surfaces = boundary.get("surfaces")
            if not isinstance(surfaces, list) or not surfaces or any(not isinstance(s, str) for s in surfaces):
                errors.append(f"{where}.surfaces must be a non-empty list of surface IDs")
            if kind == "temperature":
                temperature = boundary.get("temperatureK")
                if not isinstance(temperature, (int, float)) or isinstance(temperature, bool) or temperature <= 0:
                    errors.append(f"{where}.temperatureK must be a number > 0")
                else:
                    saw_temperature = True
            elif kind == "heat_flux":
                flux = boundary.get("heatFluxWPerM2")
                if not isinstance(flux, (int, float)) or isinstance(flux, bool):
                    errors.append(f"{where}.heatFluxWPerM2 must be a number")
            else:
                errors.append(f"{where}.type must be temperature or heat_flux")
        if boundaries and isinstance(boundaries[0], dict) and not saw_temperature:
            errors.append("at least one temperature boundary is required; an all-Neumann steady problem has no unique solution")
    return not errors, errors


def run_thermal(spec_path: str | Path, output_dir: str | Path, stage: str = "run") -> dict[str, Any]:
    from .surface_selector import resolve_surface_ids

    spec_path = Path(spec_path)
    spec = read_json(spec_path, normalize_paths=True)
    if spec.get("artifact"):
        spec["artifact"] = str(resolve_spec_path(spec_path, spec["artifact"]))
    ok, errors = validate_thermal_spec(spec)
    if not ok:
        raise ValueError("; ".join(errors))
    if stage == "validate":
        return {"status": "validated", "spec": str(spec_path), "errors": []}

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    artifact = Path(spec["artifact"]).resolve()
    geometry_units = spec.get("geometryUnits", "mm")
    mesh_spec = spec.get("mesh") or {}
    scale = {"mm": 1e-3, "m": 1.0}[geometry_units]
    max_size_model = float(mesh_spec["maxSizeMm"]) * 1e-3 / scale
    min_size_model = float(mesh_spec.get("minSizeMm", mesh_spec["maxSizeMm"] * 0.35)) * 1e-3 / scale

    pre_hashes = pre_hash_artifacts([artifact])

    try:
        mesh = mesh_step_su2(
            artifact,
            output_dir / "solid.su2",
            geometry_units=geometry_units,
            max_size=max_size_model,
            min_size=min_size_model,
        )
    except Exception as exc:
        return {
            "status": "failed",
            "reason": f"solid meshing failed: {exc}",
            "caseId": spec.get("caseId"),
        }

    all_markers = sorted(mesh["markers"])
    try:
        requested = sorted({s for b in spec.get("boundaries") or [] for s in b.get("surfaces") or []})
        resolve_surface_ids(artifact, requested)
    except ValueError as exc:
        return {"status": "failed", "reason": str(exc), "caseId": spec.get("caseId")}

    try:
        cfg_text = compile_thermal_cfg(spec, "solid.su2", all_markers)
    except ValueError as exc:
        return {"status": "failed", "reason": str(exc), "caseId": spec.get("caseId")}
    write_cfg(cfg_text, output_dir / "case.cfg")

    try:
        run = run_su2(output_dir / "case.cfg", output_dir)
    except Su2UnavailableError as exc:
        return {
            "status": "unavailable",
            "reason": str(exc),
            "capability": {"backend": "su2"},
            "caseId": spec.get("caseId"),
        }
    if run["exitCode"] != 0:
        return {
            "status": "failed",
            "reason": f"SU2_CFD exited with code {run['exitCode']}",
            "stderr": run["stderr"][-2000:],
            "caseId": spec.get("caseId"),
        }

    try:
        verify_unchanged(pre_hashes)
    except Exception as exc:
        # Provenance violation: the result is discarded and must surface as an
        # error envelope so no evidence can be recorded from it.
        return {"status": "discarded", "reason": str(exc), "caseId": spec.get("caseId")}

    try:
        history = parse_history(output_dir / "history.csv")
        points, fields = read_volume_fields(output_dir / "vol_solution.vtu")
    except Exception as exc:
        return {
            "status": "failed",
            "reason": f"could not parse SU2 output: {exc}",
            "caseId": spec.get("caseId"),
        }
    if "Temperature" not in fields:
        return {"status": "failed", "reason": "SU2 heat output has no Temperature field", "caseId": spec.get("caseId")}

    nodes = np.asarray(mesh["nodes"], dtype=np.float64)
    elements = read_su2_elements(mesh["meshPath"])
    marker_nodes = {
        marker: {v for tri in stats["triangles"] for v in tri}
        for marker, stats in mesh["markers"].items()
    }

    # Self-calibrate the heat solver's temperature reference from the
    # Dirichlet anchors this spec prescribed, then report Kelvin.
    anchors: list[tuple[str, float]] = []
    for boundary in spec.get("boundaries") or []:
        if boundary.get("type") == "temperature":
            for surface in boundary.get("surfaces") or []:
                anchors.append((surface, float(boundary["temperatureK"])))
    temperature_star = fields["Temperature"]
    temperature_scale = calibrate_temperature_scale(anchors, marker_nodes, temperature_star)
    temperature_k = temperature_star * temperature_scale
    fields["Temperature"] = temperature_k

    residual_target = (spec.get("convergence") or {}).get("residualTarget")
    # Execution validity is the interpreter's call, not the Agent's: a run
    # that did not meet its own declared residual standard (or declared no
    # standard at all) is "not_converged". Its raw fields are still returned
    # for inspection, but the harness records no simulation evidence from a
    # not_converged run, so it can never close a required case.
    is_converged = converged(history, residual_target)
    if not is_converged:
        status = "not_converged"
        if residual_target is None:
            not_converged_reason = (
                "no convergence.residualTarget was declared; a run only qualifies as "
                "evidence when it declares and meets a residual standard"
            )
        else:
            not_converged_reason = (
                f"worst RMS residual log10 {history.get('worstResidualLog10')} did not reach "
                f"the declared target {residual_target} within the iteration budget"
            )
    else:
        status = "solved"
        not_converged_reason = None

    conductivity = float(spec["material"]["conductivityWPerMK"])
    marker_triangles = {marker: stats["triangles"] for marker, stats in mesh["markers"].items()}
    heat_rates = boundary_heat_rates(
        nodes, elements, marker_triangles, temperature_star, conductivity, temperature_scale
    )
    net_rate = sum(entry["reconstructedHeatRateW"] for entry in heat_rates.values())
    largest = max((abs(entry["reconstructedHeatRateW"]) for entry in heat_rates.values()), default=0.0)

    # Heat-flux magnitude field on nodes (W/m^2), from node gradients.
    gradients = node_gradients(nodes, elements, temperature_star)
    heat_flux_magnitude = (
        conductivity * temperature_scale * np.linalg.norm(gradients, axis=1)
    )
    fields["HeatFluxMagnitude"] = heat_flux_magnitude

    visualization: dict[str, Any] = {"status": "unavailable", "views": []}
    try:
        from .su2_visualization import render_su2_views

        visualization = render_su2_views(
            nodes,
            elements,
            [tri for tris in marker_triangles.values() for tri in tris],
            fields,
            output_dir / "visualization",
            field_name="Temperature",
        )
        visualization["status"] = "ready"
    except Exception as exc:
        visualization["reason"] = str(exc)

    fields_path = output_dir / "thermal-fields.npz"
    np.savez_compressed(
        fields_path,
        nodes=nodes,
        temperatureK=temperature_k,
        heatFluxMagnitudeWPerM2=heat_flux_magnitude,
    )

    result = {
        "status": status,
        **({"reason": not_converged_reason} if not_converged_reason else {}),
        "caseId": spec.get("caseId"),
        "backend": "su2",
        "backendVersion": run["version"],
        "su2Binary": run["binary"],
        "units": "SI",
        "mesh": {
            "nodeCount": mesh["nodeCount"],
            "elementCount": mesh["elementCount"],
            "elementType": mesh["elementType"],
            "meshSizeMax": mesh_spec.get("maxSizeMm"),
            "geometryUnits": geometry_units,
            "generator": mesh["generator"],
        },
        "convergence": {
            "reached": bool(is_converged),
            "residualTargetLog10": residual_target,
            "iterations": history["iterations"],
            "finalResidualsLog10": history["finalResidualsLog10"],
            "worstResidualLog10": history["worstResidualLog10"],
        },
        "temperature": {
            "minK": round(float(temperature_k.min()), 6),
            "maxK": round(float(temperature_k.max()), 6),
            "meanK": round(float(temperature_k.mean()), 6),
        },
        "boundaries": heat_rates,
        "energyBalance": {
            # Reconstruction-based balance over boundary faces, not SU2's own
            # conservative fluxes; names say so honestly.
            "netReconstructedHeatRateW": round(net_rate, 9),
            "largestReconstructedHeatRateW": round(largest, 9),
            "relativeReconstructedImbalance": round(abs(net_rate) / largest, 9) if largest > 1e-12 else None,
        },
        "fields": fields_summary(fields),
        "visualization": visualization,
        "interpretationPolicy": "raw deterministic fields and balances only; safety and acceptance are Agent decisions",
    }
    result_path = output_dir / "thermal-result.json"
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    result["artifact"] = str(result_path)
    result["fieldArtifacts"] = [str(fields_path)]
    return result
