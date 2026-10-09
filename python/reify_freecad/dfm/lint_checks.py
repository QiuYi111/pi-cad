"""First-layer (document lint) check functions, keyed by ``Rule.check`` (pure Python).

Each function takes the lint facts (``extract.extract_facts``), its ``Rule`` and the ``Rulepack``
and returns a list of issues. Every threshold comes from ``rule.params`` or the rulepack tables.
A function that cannot decide some targets calls ``_skip`` with a reason; ``lint.py`` reports it
in coverage. A rule that returns nothing has passed.
"""

from __future__ import annotations

import math
import re
from typing import Any, Callable

from .issues import make_issue
from .rulepack import Rule, Rulepack

_EPS = 1e-6
_THICKNESS_EPS = 1e-3

LintCheck = Callable[[dict[str, Any], Rule, Rulepack], list[dict[str, Any]]]


def _issue(rule: Rule, pack: Rulepack, target: Any, **kwargs: Any) -> dict[str, Any]:
    return make_issue(rule, layer="lint", target=target, rulepack=pack, **kwargs)


def _skip(facts: dict[str, Any], reason: str) -> None:
    facts.setdefault("_skipped", []).append(reason)


def _profile_material(facts: dict[str, Any]) -> str | None:
    return (facts.get("profile") or {}).get("material")


def _is_standard(thickness: float, standard: list[float]) -> bool:
    return any(abs(thickness - value) <= _THICKNESS_EPS for value in standard)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _nominal_mm(size: str | None) -> float | None:
    match = re.match(r"^M(\d+(?:\.\d+)?)$", size or "")
    return float(match.group(1)) if match else None


def _outer_sides(features: list[dict[str, Any]], side: str) -> dict[str, list[float]]:
    """body path -> sizes (radius or size) of outline edges on the given side ("top" or "bottom")."""
    out: dict[str, list[float]] = {}
    for feature in features:
        value = feature.get("radius", feature.get("size"))
        for edge_side, outer in zip(feature["sides"], feature["outer"]):
            if edge_side == side and outer:
                out.setdefault(feature["body"], []).append(value)
    return out


def _double_sided(facts: dict[str, Any]) -> bool:
    return any("top" in f["sides"] and "bottom" in f["sides"] for f in facts["fillets"] + facts["chamfers"])


# ---------------------------------------------------------------- 5.1 stock, size, material

def stock_size_range(facts, rule, pack):
    bbox = facts["bbox"]
    if bbox is None:
        return []
    dims = sorted(bbox)
    low = sorted(rule.params["min_mm"])
    high = sorted(rule.params["max_mm"])
    if all(low[i] - _EPS <= dims[i] <= high[i] + _EPS for i in range(3)):
        return []
    return [_issue(rule, pack, facts["part"], measured=[round(d, 3) for d in dims], limit=high,
                   message=f"bounding box {[round(d, 3) for d in dims]} mm (sorted) is outside {low}..{high} mm")]


def stock_size_limited_material(facts, rule, pack):
    material = _profile_material(facts)
    if not material or not pack.materials.get(material, {}).get("size_limited"):
        return []
    return [_issue(rule, pack, facts["part"], message=f"{material}: the size range is the platform's; confirm stock before ordering")]


def stock_thickness_range(facts, rule, pack):
    bbox = facts["bbox"]
    if bbox is None:
        return []
    thickness = bbox[2]
    low, high = rule.params["min_mm"], rule.params["max_mm"]
    if low - _EPS <= thickness <= high + _EPS:
        return []
    return [_issue(rule, pack, facts["part"], measured=round(thickness, 3), limit=low if thickness < low else high)]


def stock_standard_thickness(facts, rule, pack):
    bbox = facts["bbox"]
    if bbox is None or _is_standard(bbox[2], rule.params["standard_mm"]):
        return []
    message = f"Z thickness {round(bbox[2], 3)} mm is not a common standard plate thickness"
    if _double_sided(facts):
        message += "; the double-sided features on this part add machining risk"
    return [_issue(rule, pack, facts["part"], measured=round(bbox[2], 3), message=message)]


def stock_thin_plate_large(facts, rule, pack):
    bbox = facts["bbox"]
    if bbox is None:
        return []
    thickness, longest = bbox[2], max(bbox[0], bbox[1])
    params = rule.params
    if thickness < params["thin_mm"] and longest > params["large_longest_mm"] and not _is_standard(thickness, pack.tables["standard_thickness_mm"]):
        return [_issue(rule, pack, facts["part"], measured=round(thickness, 3), limit=params["thin_mm"],
                       message=f"large thin plate ({round(thickness, 3)} mm thick, longest side {round(longest, 3)} mm) must use a standard thickness")]
    return []


def stock_removal_ratio(facts, rule, pack):
    bbox = facts["bbox"]
    if bbox is None or bbox[0] * bbox[1] * bbox[2] <= 0:
        return []
    ratio = 1 - facts["volume_mm3"] / (bbox[0] * bbox[1] * bbox[2])
    limit = rule.params["max_ratio"]
    if ratio <= limit + _EPS:
        return []
    return [_issue(rule, pack, facts["part"], measured=round(ratio, 3), limit=limit, unit="ratio")]


def stock_surface_treatment(facts, rule, pack):
    material = _profile_material(facts)
    if material not in rule.params["materials"]:
        return []
    return [_issue(rule, pack, facts["part"], message=f"{material}: a surface treatment is recommended")]


_GB_RANGE = re.compile(r"^(>)?(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$")


def _gb1804_tolerance(table: dict[str, Any], nominal: float) -> float | None:
    """Class m tolerance (±mm) for a nominal size, from keys "a-b" (a <= n <= b) or ">a-b" (a < n <= b)."""
    for key, tolerance in table.items():
        match = _GB_RANGE.match(str(key))
        if match is None:
            continue
        low, high = float(match.group(2)), float(match.group(3))
        above_low = nominal > low + _EPS if match.group(1) else nominal >= low - _EPS
        if above_low and nominal <= high + _EPS:
            return float(tolerance)
    return None


def tol_general(facts, rule, pack):
    table = pack.tables.get("gb1804_m")
    if table is None:
        _skip(facts, f"{rule.params['standard']} table is not in the rulepack")
        return []
    issues = []
    for req in facts["requirements"]:
        if req["kind"] != "dimension" or not req["tolerance"] > 0 or not _is_number(req["limit"]):
            continue
        nominal = abs(float(req["limit"]))
        standard = _gb1804_tolerance(table, nominal)
        if standard is None:
            _skip(facts, f"{rule.params['standard']} has no row for a {nominal:g} mm dimension")
            continue
        if req["tolerance"] < standard - _EPS:
            issues.append(_issue(
                rule, pack, req["path"], measured=req["tolerance"], limit=standard,
                message=f"{req['path']}: tolerance ±{req['tolerance']:g} mm is tighter than {rule.params['standard']} "
                        f"±{standard:g} mm for a {nominal:g} mm dimension; agree a fine-hole compensation or confirm with the vendor",
            ))
    return issues


def tol_precision_hole(facts, rule, pack):
    params = rule.params
    hole_paths = {hole["path"] for hole in facts["holes"]}
    issues = []
    for req in facts["requirements"]:
        target = req["target"]
        if req["kind"] != "dimension" or not isinstance(target, dict):
            continue
        if target.get("prop") != "Diameter" or target.get("target") not in hole_paths:
            continue
        if not 0 < req["tolerance"] < params["trigger_below_mm"]:
            continue
        issues.append(_issue(rule, pack, target["target"], measured=req["tolerance"], limit=params["trigger_below_mm"],
                             message=f"{target['target']}: tolerance {req['tolerance']:g} mm is tighter than {params['trigger_below_mm']:g} mm; "
                                     f"model the mating hole {params['compensation_min_mm']:g}-{params['compensation_max_mm']:g} mm larger"))
    return issues


# ---------------------------------------------------------------- 5.2 holes

def hole_min_diameter(facts, rule, pack):
    limit = rule.params["min_mm"]
    return [_issue(rule, pack, hole["path"], measured=hole["diameter"], limit=limit)
            for hole in facts["holes"] if hole["diameter"] < limit - _EPS]


def hole_depth_ratio(facts, rule, pack):
    params = rule.params
    issues = []
    for hole in facts["holes"]:
        length = hole["length"]
        if length is None or hole["diameter"] <= 0:
            continue
        ratio = length / hole["diameter"]
        for level, threshold in (("error", params["error_ratio"]), ("warn", params["warn_ratio"]), ("info", params["info_ratio"])):
            if ratio > threshold + _EPS:
                issues.append(_issue(rule, pack, hole["path"], measured=round(ratio, 3), limit=threshold, unit="ratio",
                                     severity=level, message=f"{hole['path']}: depth/diameter {ratio:.2f} is over {threshold:g}"))
                break
    return issues


def hole_thread_tap_drill(facts, rule, pack):
    table = pack.tables["tap_drill_mm"]
    tolerance = rule.params["tolerance_mm"]
    issues = []
    for hole in facts["holes"]:
        if not (hole["threaded"] and not hole["model_thread"]) or hole["thread_size"] not in table:
            continue
        expected = table[hole["thread_size"]]
        if abs(hole["diameter"] - expected) > tolerance + _EPS:
            issues.append(_issue(rule, pack, hole["path"], measured=hole["diameter"], limit=expected,
                                 message=f"{hole['thread_size']} tapped hole should be φ{expected:g} (tap drill table), is φ{hole['diameter']:g}",
                                 hints=[f"set diameter {expected:g}"]))
    return issues


def hole_thread_modeled(facts, rule, pack):
    return [_issue(rule, pack, hole["path"], message=f"{hole['path']}: a modelled thread breaks the platform's tap-drill recognition; use the tap drill diameter")
            for hole in facts["holes"] if hole["threaded"] and hole["model_thread"]]


def hole_thread_length(facts, rule, pack):
    issues = []
    for hole in facts["holes"]:
        nominal = _nominal_mm(hole["thread_size"]) if hole["threaded"] else None
        if nominal is None or hole["thread_depth"] is None:
            continue
        limit = rule.params["max_ratio"] * nominal
        if hole["thread_depth"] > limit + _EPS:
            issues.append(_issue(rule, pack, hole["path"], measured=round(hole["thread_depth"], 3), limit=round(limit, 3),
                                 message=f"thread length {hole['thread_depth']:g} mm is over {rule.params['max_ratio']:g} x nominal {nominal:g} mm",
                                 hints=[f"shorten the thread to at most {limit:g} mm"]))
    return issues


def hole_thread_min_depth(facts, rule, pack):
    params = rule.params
    issues = []
    for hole in facts["holes"]:
        nominal = _nominal_mm(hole["thread_size"]) if hole["threaded"] else None
        if nominal is None or hole["thread_depth"] is None:
            continue
        ratio = params["min_ratio_from_m3"] if nominal >= params["m3_mm"] else params["min_ratio_below_m3"]
        required = ratio * nominal
        if hole["thread_depth"] < required - _EPS:
            issues.append(_issue(rule, pack, hole["path"], measured=round(hole["thread_depth"], 3), limit=round(required, 3),
                                 message=f"thread depth {hole['thread_depth']:g} mm is under {required:g} mm ({ratio:g} x nominal {nominal:g} mm)",
                                 hints=[f"deepen the thread to at least {required:g} mm (lock length 1-2 x {nominal:g} mm)"]))
    return issues


def hole_thread_blind_extra(facts, rule, pack):
    issues = []
    for hole in facts["holes"]:
        if not hole["threaded"] or hole["through"] or hole["depth"] is None or hole["thread_depth"] is None:
            continue
        required = hole["thread_depth"] + rule.params["extra_ratio"] * hole["diameter"]
        if hole["depth"] < required - _EPS:
            issues.append(_issue(rule, pack, hole["path"], measured=round(hole["depth"], 3), limit=round(required, 3),
                                 message=f"blind tap drill {hole['depth']:g} mm is under thread depth {hole['thread_depth']:g} mm + 1 x diameter",
                                 hints=[f"deepen the drill to at least {required:g} mm"]))
    return issues


def hole_bottom_shape(facts, rule, pack):
    severity = rule.params.get("cone_severity", "info")
    return [_issue(rule, pack, hole["path"], severity=severity,
                   message=f"{hole['path']}: blind hole with a drill-point cone bottom; a flat bottom is recommended")
            for hole in facts["holes"] if not hole["through"] and hole["drill_point"] == "angled"]


def hole_countersink(facts, rule, pack):
    return [_issue(rule, pack, hole["path"], message=f"{hole['path']}: countersink may fail or be incomplete; use a counterbore")
            for hole in facts["holes"] if hole["cut_type"] == "Countersink"]


def hole_countersink_to_bottom(facts, rule, pack):
    issues = []
    for hole in facts["holes"]:
        length = hole["length"]
        if hole["cut_type"] != "Countersink" or length is None:
            continue
        radial = (hole["cut_diameter"] - hole["diameter"]) / 2
        if radial <= 0:
            continue
        angle = math.radians(hole["countersink_angle"] or 90.0)
        cone_depth = radial / math.tan(angle / 2)
        if cone_depth >= length - _EPS:
            issues.append(_issue(rule, pack, hole["path"], measured=round(cone_depth, 3), limit=round(length, 3),
                                 message=f"countersink cone ({cone_depth:.2f} mm deep) reaches the bottom of a {length:.2f} mm hole; keep a cylindrical bottom hole"))
    return issues


def hole_waist_slot_depth(facts, rule, pack):
    params = rule.params
    issues = []
    for pocket in facts["pockets"]:
        for loop in pocket["loops"]:
            if not loop["is_slot"]:
                continue
            width, length = loop["slot_width"], loop["slot_length"]
            limit = params["max_depth_ratio"] * width
            if pocket["depth"] > limit + _EPS:
                relaxed = length / width > params["relaxed_aspect_ratio"] + _EPS
                issues.append(_issue(rule, pack, pocket["path"], measured=round(pocket["depth"], 3), limit=round(limit, 3),
                                     severity=params["relaxed_severity"] if relaxed else None,
                                     message=f"waist slot is {pocket['depth']:g} mm deep, over {params['max_depth_ratio']:g} x its {width:g} mm width"))
                break
    return issues


# ---------------------------------------------------------------- 5.3 cavities, slots, corners

def _cavity_loops(pocket: dict[str, Any]) -> list[dict[str, Any]]:
    """Loops whose region is removed (even nesting). Islands (odd nesting) keep their material."""
    return [loop for loop in pocket["loops"] if loop["nesting"] % 2 == 0]


def cavity_min_width(facts, rule, pack):
    limit = rule.params["min_mm"]
    issues = []
    for pocket in facts["pockets"]:
        for loop in _cavity_loops(pocket):
            if loop["min_width"] is not None and loop["min_width"] < limit - _EPS:
                issues.append(_issue(rule, pack, pocket["path"], measured=round(loop["min_width"], 3), limit=limit))
                break
    return issues


def cavity_depth_tool_ratio(facts, rule, pack):
    tools = pack.tables["tool_diameters_mm"]
    issues = []
    for pocket in facts["pockets"]:
        for loop in _cavity_loops(pocket):
            width = loop["min_width"]
            smaller = [t for t in tools if width is not None and t < width - _EPS]
            if not smaller:
                continue
            tool = max(smaller)
            limit = rule.params["max_ratio"] * tool
            if pocket["depth"] > limit + _EPS:
                issues.append(_issue(rule, pack, pocket["path"], measured=round(pocket["depth"], 3), limit=round(limit, 3),
                                     message=f"cavity {pocket['depth']:g} mm deep, over {rule.params['max_ratio']:g} x the {tool:g} mm tool (width {width:g} mm)"))
                break
    return issues


def corner_inner_auto_radius(facts, rule, pack):
    params = rule.params
    mated: set[str] = set()
    for req in facts["requirements"]:
        if req["kind"] == "min_clearance" and isinstance(req["target"], dict):
            mated.update(str(req["target"].get(key, "")) for key in ("a", "b"))
        elif req["kind"] == "dimension" and isinstance(req["target"], dict):
            mated.add(str(req["target"].get("target", "")))
    issues = []
    for pocket in facts["pockets"]:
        if pocket["depth"] <= 0:
            continue
        auto = pocket["depth"] / params["radius_ratio"]
        flagged = [c["radius"] for loop in _cavity_loops(pocket) for c in loop["corners"]
                   if not c["concave"] and c["radius"] < auto - _EPS]
        if not flagged:
            continue
        smallest = min(flagged)
        is_mated = any(m == pocket["path"] or m.startswith(pocket["path"] + "/") for m in mated if m)
        issues.append(_issue(
            rule, pack, pocket["path"], measured=round(smallest, 3), limit=round(auto, 3),
            severity=params["mated_severity"] if is_mated else params["info_severity"],
            message=f"{pocket['path']}: inner corner R{smallest:g} is under depth/{params['radius_ratio']:g} = {auto:g}; the platform machines R{auto:g}"
                    + (" (this corner has a fit requirement)" if is_mated else ""),
        ))
    return issues


def _floor_check(facts: dict[str, Any], rule: Rule, pack: Rulepack, features: list[dict[str, Any]], what: str):
    if facts["pockets"] and any("unknown" in feature["sides"] for feature in features):
        _skip(facts, f"{what} on pocket floors need the second layer's geometry")
    return []


def floor_chamfer(facts, rule, pack):
    return _floor_check(facts, rule, pack, facts["chamfers"], "chamfer")


def floor_fillet_radius(facts, rule, pack):
    return _floor_check(facts, rule, pack, facts["fillets"], "fillet")


# ---------------------------------------------------------------- 5.4 edges and two-sided features

def edge_default_chamfer(facts, rule, pack):
    minimum = rule.params["min_mm"]
    issues = []
    for entry in facts["sharp_edges"]:
        body = entry["body"]
        small = sum(1 for chamfer in facts["chamfers"] if chamfer["body"] == body and chamfer["size"] < minimum - _EPS)
        if entry["count"] + small == 0:
            continue
        issues.append(_issue(rule, pack, body, measured=entry["count"] + small, unit="edges", limit=minimum,
                             message=f"{body}: {entry['count']} sharp outer edge(s) and {small} chamfer(s) under C{minimum:g} get the platform's default C{rule.params['default_min_mm']:g}-{rule.params['default_max_mm']:g}"))
    return issues


def edge_double_side_chamfer(facts, rule, pack):
    params = rule.params
    top = _outer_sides(facts["chamfers"], "top")
    bottom = _outer_sides(facts["chamfers"], "bottom")
    standard = _is_standard(facts["bbox"][2], pack.tables["standard_thickness_mm"]) if facts["bbox"] else False
    issues = []
    for body in sorted(set(top) & set(bottom)):
        top_max, bottom_max = max(top[body]), max(bottom[body])
        if top_max > params["side_min_mm"] + _EPS and bottom_max > params["side_min_mm"] + _EPS:
            note = " (standard thickness: over C1 on both sides)" if standard and min(top_max, bottom_max) > params["standard_double_side_max_mm"] else ""
            issues.append(_issue(rule, pack, body, measured=round(min(top_max, bottom_max), 3), limit=params["side_min_mm"],
                                 message=f"{body}: outline chamfers on both faces (C{top_max:g} top, C{bottom_max:g} bottom) may fail{note}"))
    return issues


def edge_double_side_fillet(facts, rule, pack):
    top = _outer_sides(facts["fillets"], "top")
    bottom = _outer_sides(facts["fillets"], "bottom")
    return [_issue(rule, pack, body, measured=len(top[body]) + len(bottom[body]), unit="edges",
                   message=f"{body}: outline fillets on both faces; a rounded edge is only supported on one side")
            for body in sorted(set(top) & set(bottom))]


LINT_CHECKS: dict[str, LintCheck] = {
    "stock_size_range": stock_size_range,
    "stock_size_limited_material": stock_size_limited_material,
    "stock_thickness_range": stock_thickness_range,
    "stock_standard_thickness": stock_standard_thickness,
    "stock_thin_plate_large": stock_thin_plate_large,
    "stock_removal_ratio": stock_removal_ratio,
    "stock_surface_treatment": stock_surface_treatment,
    "tol_general": tol_general,
    "tol_precision_hole": tol_precision_hole,
    "hole_min_diameter": hole_min_diameter,
    "hole_depth_ratio": hole_depth_ratio,
    "hole_thread_tap_drill": hole_thread_tap_drill,
    "hole_thread_modeled": hole_thread_modeled,
    "hole_thread_length": hole_thread_length,
    "hole_thread_min_depth": hole_thread_min_depth,
    "hole_thread_blind_extra": hole_thread_blind_extra,
    "hole_bottom_shape": hole_bottom_shape,
    "hole_countersink": hole_countersink,
    "hole_countersink_to_bottom": hole_countersink_to_bottom,
    "hole_waist_slot_depth": hole_waist_slot_depth,
    "cavity_min_width": cavity_min_width,
    "cavity_depth_tool_ratio": cavity_depth_tool_ratio,
    "corner_inner_auto_radius": corner_inner_auto_radius,
    "floor_chamfer": floor_chamfer,
    "floor_fillet_radius": floor_fillet_radius,
    "edge_default_chamfer": edge_default_chamfer,
    "edge_double_side_chamfer": edge_double_side_chamfer,
    "edge_double_side_fillet": edge_double_side_fillet,
}
