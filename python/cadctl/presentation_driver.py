"""Blender-side presentation driver (0.8 review P0-7).

Executed by `blender -b --factory-startup -P presentation_driver.py -- <args.json>`.
Never imported by cadctl itself. Deterministic by construction:

  - factory scene, no user prefs
  - materials mapped from the spec's family/pattern vocabulary to
    Principled BSDF parameters (unknown vocabulary fails the render
    honestly, before pixels are made)
  - lighting: the fixed rig's energies scale with keywords parsed from
    the spec's lighting strings; key angle honors explicit degrees
  - camera: focal length parsed from the lens string ("85mm"), angle
    preset from composition keywords (hero / three-quarter / top-down / …)
  - module identity comes from the mesh-bundle manifest labels — never
    from generic mesh names — so explodeDirections and the assembly
    sequence address the right occurrences
  - the assembly ANIMATION follows the declared install sequence: step 1
    parts assemble first, unlisted leftovers last
  - CYCLES on CPU with a fixed seed and fixed sample count

The driver renders what the spec says, records how it interpreted the
spec's vocabulary in the render report, and never judges aesthetic
quality.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Spec-vocabulary interpretation (deterministic, recorded)
# ---------------------------------------------------------------------------

MATERIAL_FAMILIES = {
    # family -> (base_color, metallic, roughness)
    "metal": ((0.72, 0.72, 0.74), 0.9, 0.4),
    "plastic": ((0.55, 0.55, 0.58), 0.0, 0.5),
    "composite": ((0.35, 0.35, 0.38), 0.1, 0.55),
    "ceramic": ((0.88, 0.86, 0.82), 0.0, 0.25),
    "rubber": ((0.2, 0.2, 0.21), 0.0, 0.85),
    "glass": ((0.85, 0.9, 0.92), 0.0, 0.08),
}

MATERIAL_PATTERNS = {
    # pattern -> roughness delta within the family
    "brushed": -0.1,
    "polished": -0.25,
    "cast": 0.2,
    "anodized": -0.05,
    "machined": -0.15,
    "matte": 0.15,
    "gloss": -0.3,
    "textured": 0.25,
    "woven": 0.1,
    "glazed": -0.15,
    "clear": -0.02,
    "frosted": 0.12,
}

COMPOSITION_PRESETS = {
    # keyword -> (azimuth_deg, elevation_deg, distance_factor)
    "hero": (45, 25, 1.0),
    "three-quarter": (45, 30, 1.0),
    "top-down": (0, 85, 1.05),
    "side": (90, 15, 0.95),
    "front": (0, 10, 0.95),
    "rear": (180, 15, 0.95),
    "detail": (30, 12, 0.6),
}

LIGHTING_KEYWORDS = {
    # keyword -> energy multiplier
    "softbox": 1.0,
    "strip": 0.9,
    "bounce": 0.5,
    "card": 0.5,
    "sun": 1.3,
    "sky": 0.7,
    "ring": 1.1,
    "flood": 0.9,
}


def parse_focal_length(lens: str) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)\s*mm", lens or "")
    return float(match.group(1)) if match else None


def parse_composition(composition: str) -> tuple[float, float, float] | None:
    text = (composition or "").lower()
    for keyword, preset in COMPOSITION_PRESETS.items():
        if keyword in text:
            return preset
    return None


def parse_lighting(lighting: dict) -> dict:
    """Interpret the lighting strings; record what was understood."""
    interpretation = {}
    for role in ("key", "fill", "rim"):
        text = str(lighting.get(role, "")).lower()
        multiplier = 1.0
        keywords = []
        for keyword, factor in LIGHTING_KEYWORDS.items():
            if keyword in text:
                multiplier = factor
                keywords.append(keyword)
                break
        degrees = re.search(r"(\d+(?:\.\d+)?)\s*(?:°|deg)", text)
        interpretation[role] = {
            "keywords": keywords,
            "energyMultiplier": multiplier,
            "degrees": float(degrees.group(1)) if degrees else None,
        }
    return interpretation


def material_params(material: dict) -> tuple[tuple[float, float, float, float], float, float]:
    family = (material.get("family") or "").lower()
    pattern = (material.get("pattern") or "").lower()
    if family not in MATERIAL_FAMILIES:
        raise ValueError(f"unknown material family {family!r}; supported: {sorted(MATERIAL_FAMILIES)}")
    color, metallic, roughness = MATERIAL_FAMILIES[family]
    if pattern and pattern not in MATERIAL_PATTERNS:
        raise ValueError(f"unknown material pattern {pattern!r}; supported: {sorted(MATERIAL_PATTERNS)}")
    if pattern:
        roughness = min(max(roughness + MATERIAL_PATTERNS[pattern], 0.02), 1.0)
    return (*color, 1.0), metallic, roughness


def _scene_bbox(objects):
    from mathutils import Vector

    min_v = [math.inf] * 3
    max_v = [-math.inf] * 3
    for obj in objects:
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            for axis in range(3):
                min_v[axis] = min(min_v[axis], world[axis])
                max_v[axis] = max(max_v[axis], world[axis])
    return min_v, max_v


def _vec3(values):
    from mathutils import Vector

    return Vector(values)


def _normalize_key(name: str) -> str:
    return re.sub(r"[\s_]+", "", (name or "").lower())


def main() -> int:
    import bpy

    args = json.loads(Path(sys.argv[-1]).read_text(encoding="utf-8"))
    report = {"status": "failed", "rendered": {}, "notes": [], "interpretation": {}}

    bpy.ops.wm.read_factory_settings(use_empty=True)

    artifact = args["artifact"]
    suffix = Path(artifact).suffix.lower()
    if suffix in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=artifact)
    elif args.get("meshBundle"):
        bundle = Path(args["meshBundle"])
        stl_files = sorted(bundle.glob("part-*.stl"))
        if not stl_files:
            report["notes"].append("mesh bundle is empty")
            Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
            return 1
        bpy.ops.wm.stl_import(directory=str(bundle), files=[{"name": f.name} for f in stl_files])
        # Rename imported meshes to their occurrence labels from the
        # bundle manifest, so module identity survives: "part-0000"
        # becomes the assembly's own occurrence key.
        bundle_manifest_path = bundle / "manifest.json"
        label_by_stem: dict[str, str] = {}
        if bundle_manifest_path.exists():
            bundle_manifest = json.loads(bundle_manifest_path.read_text(encoding="utf-8"))
            for part in bundle_manifest.get("parts", []):
                stem = Path(part["meshPath"]).stem.lower()
                label_by_stem[stem] = part.get("occurrenceKey") or stem
        for obj in bpy.context.scene.objects:
            if obj.type != "MESH":
                continue
            data_stem = (obj.data.name or "").lower()
            name_stem = (obj.name or "").lower()
            label = label_by_stem.get(data_stem) or label_by_stem.get(name_stem)
            obj.name = f"pi-cad::{label or name_stem}"
    else:
        report["notes"].append(f"unsupported artifact suffix: {suffix}")
        Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 1

    solids = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not solids:
        report["notes"].append("artifact imported with no mesh objects")
        Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 1

    # --- Materials: the spec's family/pattern vocabulary drives the BSDF.
    materials_spec = args.get("materials") or []
    assignments = []
    for index, obj in enumerate(solids):
        entry = (
            materials_spec[index % len(materials_spec)]
            if materials_spec
            else {"family": "metal", "pattern": "machined"}
        )
        try:
            color, metallic, roughness = material_params(entry)
        except ValueError as exc:
            report["notes"].append(str(exc))
            Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
            return 1
        material = bpy.data.materials.new(f"pi-cad-mat-{index:02d}")
        material.use_nodes = True
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = color
            bsdf.inputs["Metallic"].default_value = metallic
            bsdf.inputs["Roughness"].default_value = roughness
        if obj.data.materials:
            obj.data.materials[0] = material
        else:
            obj.data.materials.append(material)
        assignments.append(
            {"object": obj.name, "family": entry.get("family"), "pattern": entry.get("pattern")}
        )
    report["interpretation"]["materialAssignments"] = assignments

    # Center the assembly at the world origin on the ground plane.
    min_v, max_v = _scene_bbox(solids)
    center = [(min_v[a] + max_v[a]) / 2 for a in range(3)]
    for obj in solids:
        obj.location = obj.location - _vec3(center)
    bpy.context.view_layer.update()
    min_v, max_v = _scene_bbox(solids)
    size = [max_v[a] - min_v[a] for a in range(3)]
    diag = math.sqrt(sum(s * s for s in size)) or 1.0

    # --- Lighting: keywords scale the fixed rig; key angle honors degrees.
    lighting_interpretation = parse_lighting(args.get("lighting") or {})
    report["interpretation"]["lighting"] = lighting_interpretation

    world = bpy.data.worlds.new("pi-cad-world")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background:
        background.inputs[0].default_value = (0.05, 0.05, 0.06, 1.0)
    bpy.context.scene.world = world

    def add_sun(name, direction, energy):
        sun = bpy.data.lights.new(name, type="SUN")
        sun.energy = energy
        sun_obj = bpy.data.objects.new(name, sun)
        bpy.context.collection.objects.link(sun_obj)
        sun_obj.rotation_euler = direction
        return sun_obj

    key_degrees = lighting_interpretation.get("key", {}).get("degrees")
    key_azimuth = math.radians(key_degrees) if key_degrees is not None else math.radians(55)
    add_sun(
        "key",
        (key_azimuth, math.radians(15), math.radians(40)),
        3.2 * lighting_interpretation["key"]["energyMultiplier"],
    )
    add_sun(
        "fill",
        (math.radians(70), math.radians(160), math.radians(-30)),
        1.1 * lighting_interpretation["fill"]["energyMultiplier"],
    )
    add_sun(
        "rim",
        (math.radians(15), math.radians(200), math.radians(120)),
        1.6 * lighting_interpretation["rim"]["energyMultiplier"],
    )

    # --- Camera: focal length from the lens string, angles from the
    # composition keyword; unknown vocabulary fails the render honestly.
    camera_data = bpy.data.cameras.new("pi-cad-camera")
    focal = parse_focal_length(args.get("lens") or "")
    if focal is None:
        report["notes"].append(
            f"could not parse a focal length from lens {args.get('lens')!r} (need e.g. '85mm')"
        )
        Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 1
    camera_data.lens = focal
    composition = parse_composition(args.get("composition") or "")
    if composition is None:
        supported = ", ".join(sorted(COMPOSITION_PRESETS))
        report["notes"].append(
            f"unknown composition {args.get('composition')!r}; supported keywords: {supported}"
        )
        Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 1
    cam_azimuth, cam_elevation, distance_factor = composition
    report["interpretation"]["camera"] = {
        "focalLengthMm": focal,
        "composition": args.get("composition"),
        "azimuthDeg": cam_azimuth,
        "elevationDeg": cam_elevation,
    }
    camera = bpy.data.objects.new("pi-cad-camera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args["samples"]
    # The manifest declares seed 0; set it explicitly (the refactor that
    # added denoising handling dropped this line, leaving the manifest
    # describing a setting the renderer never received).
    scene.cycles.seed = 0
    # Distros ship Blender without OpenImageDenoise; Cycles lazy-loads OIDN
    # at render time and then dies. We never ask for denoising — make that
    # explicit so builds without it render fine.
    try:
        scene.cycles.use_denoising = False
        for view_layer in bpy.context.scene.view_layers:
            view_layer.cycles.use_denoising = False
    except Exception:
        pass
    scene.render.resolution_x = args["width"]
    scene.render.resolution_y = args["height"]
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(Path(args["outputDir"]) / "unused.png")

    distance = diag * 1.9 * distance_factor

    def place_camera(azimuth_deg, elevation_deg, dist):
        azimuth = math.radians(azimuth_deg)
        elevation = math.radians(elevation_deg)
        location = (
            dist * math.cos(elevation) * math.cos(azimuth),
            dist * math.cos(elevation) * math.sin(azimuth),
            dist * math.sin(elevation),
        )
        camera.location = _vec3(location)
        direction = _vec3([-c for c in location])
        camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    # --- Module identity: explode directions address occurrence labels
    # from the mesh-bundle manifest (never generic mesh names).
    explode_directions = {
        _normalize_key(k): v for k, v in (args.get("explodeDirections") or {}).items()
    }
    sequence = args.get("sequence") or []

    def module_key(obj) -> str | None:
        name = obj.name.split("::", 1)[-1] if "::" in obj.name else obj.name
        normalized = _normalize_key(name)
        if normalized in explode_directions:
            return normalized
        for step in sequence:
            for installed in step.get("installs", []):
                if _normalize_key(installed) == normalized:
                    return normalized
        return None

    def explode_vector(obj):
        import mathutils

        key = module_key(obj)
        if key is not None and key in explode_directions:
            return mathutils.Vector(explode_directions[key]).normalized()
        # Unmatched parts explode radially from the assembly center.
        world_center = obj.matrix_world.translation
        radial = world_center.copy()
        radial.z = abs(radial.z) * 0.2
        if radial.length < 1e-9:
            radial = mathutils.Vector((0.0, 0.0, 1.0))
        return radial.normalized()

    def install_step_of(obj) -> int:
        """Sequence step that installs this object; unlisted parts go last."""
        name = obj.name.split("::", 1)[-1] if "::" in obj.name else obj.name
        normalized = _normalize_key(name)
        for index, step in enumerate(sequence):
            if any(_normalize_key(installed) == normalized for installed in step.get("installs", [])):
                return index
        return len(sequence)

    originals = {obj: obj.location.copy() for obj in solids}
    report["interpretation"]["moduleKeys"] = {obj.name: module_key(obj) for obj in solids}
    report["interpretation"]["sequence"] = sequence

    def explode_objects(scale):
        for obj in solids:
            obj.location = originals[obj] + explode_vector(obj) * (scale * diag * 0.45)
        bpy.context.view_layer.update()

    def restore_locations():
        for obj, location in originals.items():
            obj.location = location
        bpy.context.view_layer.update()

    def render_to(name):
        out = Path(args["outputDir"]) / name
        scene.render.filepath = str(out)
        bpy.ops.render.render(write_still=True)
        report["rendered"][name] = str(out)

    if args.get("hero", True):
        place_camera(cam_azimuth, cam_elevation, distance)
        render_to("hero.png")

    if args.get("exploded", True):
        explode_objects(1.0)
        place_camera(cam_azimuth, cam_elevation + 5, distance * 1.25)
        render_to("exploded.png")
        restore_locations()

    if args.get("turntable", True):
        frames = args["turntableFrames"]
        frames_dir = Path(args["outputDir"]) / "turntable-frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        scene.render.fps = args["fps"]
        for frame in range(frames):
            angle = 360.0 * frame / frames
            place_camera(angle, cam_elevation, distance)
            scene.render.filepath = str(frames_dir / f"frame_{frame:04d}.png")
            bpy.ops.render.render(write_still=True)
        report["turntableFrames"] = str(frames_dir)
        report["turntableFrameCount"] = frames

    if args.get("assemblyAnimation", False):
        frames = args["assemblyFrames"]
        frames_dir = Path(args["outputDir"]) / "assembly-frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        scene.render.fps = args["fps"]
        steps = max(len(sequence), 1)
        # The declared install sequence drives the animation: step-1 parts
        # assemble first, later steps follow, unlisted leftovers last —
        # instead of every part collapsing at once.
        for frame in range(frames):
            progress = frame / max(frames - 1, 1)
            for obj in solids:
                step_index = install_step_of(obj)
                step_start = step_index / max(steps, 1)
                step_span = 1.0 / max(steps, 1)
                local = (progress - step_start) / step_span if step_span > 0 else 1.0
                local = max(min(local, 1.0), 0.0)
                obj.location = originals[obj] + explode_vector(obj) * ((1.0 - local) * diag * 0.45)
            bpy.context.view_layer.update()
            place_camera(
                cam_azimuth + 20 * progress,
                cam_elevation,
                distance * (1.15 - 0.15 * progress),
            )
            scene.render.filepath = str(frames_dir / f"frame_{frame:04d}.png")
            bpy.ops.render.render(write_still=True)
        restore_locations()
        report["assemblyFrames"] = str(frames_dir)
        report["assemblyFrameCount"] = frames

    # Save the blend alongside the outputs for reproducibility.
    blend_path = Path(args["outputDir"]) / "presentation.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    report["blend"] = str(blend_path)

    report["status"] = "rendered"
    report["objectCount"] = len(solids)
    Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
