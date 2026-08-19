"""Blender-side presentation driver (0.8 M4b).

Executed by `blender -b --factory-startup -P presentation_driver.py -- <args.json>`.
Never imported by cadctl itself. Deterministic by construction:

  - factory scene, no user prefs
  - fixed camera math derived from the artifact bounding box
  - fixed light rig
  - CYCLES on CPU with a fixed seed and fixed sample count
  - fixed frame counts and resolutions from the args

The driver renders what the spec says and writes a render-report JSON; it
never judges aesthetic quality.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path


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


def main() -> int:
    import bpy

    args = json.loads(Path(sys.argv[-1]).read_text(encoding="utf-8"))
    report = {"status": "failed", "rendered": {}, "notes": []}

    bpy.ops.wm.read_factory_settings(use_empty=True)

    artifact = args["artifact"]
    suffix = Path(artifact).suffix.lower()
    if suffix in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=artifact)
    elif args.get("meshBundle"):
        # The interpreter already compiled the STEP into deterministic
        # per-solid STLs (Blender builds without the OCCT importer would
        # silently lose the geometry otherwise).
        bundle = Path(args["meshBundle"])
        stl_files = sorted(bundle.glob("part-*.stl"))
        if not stl_files:
            report["notes"].append("mesh bundle is empty")
            Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
            return 1
        bpy.ops.wm.stl_import(directory=str(bundle), files=[{"name": f.name} for f in stl_files])
    else:
        report["notes"].append(f"unsupported artifact suffix: {suffix}")
        Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 1

    solids = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not solids:
        report["notes"].append("artifact imported with no mesh objects")
        Path(args["reportPath"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 1

    # Center the assembly at the world origin on the ground plane.
    min_v, max_v = _scene_bbox(solids)
    center = [(min_v[a] + max_v[a]) / 2 for a in range(3)]
    for obj in solids:
        obj.location = obj.location - _vec3(center)
    bpy.context.view_layer.update()
    min_v, max_v = _scene_bbox(solids)
    size = [max_v[a] - min_v[a] for a in range(3)]
    diag = math.sqrt(sum(s * s for s in size)) or 1.0

    # Neutral, deterministic material: principled BSDF, mid-gray metal.
    material = bpy.data.materials.new("pi-cad-presentation")
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.72, 0.72, 0.74, 1.0)
        bsdf.inputs["Metallic"].default_value = 0.15
        bsdf.inputs["Roughness"].default_value = 0.45
    for obj in solids:
        if obj.data.materials:
            obj.data.materials[0] = material
        else:
            obj.data.materials.append(material)

    # Fixed light rig relative to the bounding sphere.
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

    add_sun("key", (math.radians(55), math.radians(15), math.radians(40)), 3.2)
    add_sun("fill", (math.radians(70), math.radians(160), math.radians(-30)), 1.1)
    add_sun("rim", (math.radians(15), math.radians(200), math.radians(120)), 1.6)

    camera_data = bpy.data.cameras.new("pi-cad-camera")
    camera = bpy.data.objects.new("pi-cad-camera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args["samples"]
    scene.cycles.seed = 0
    scene.render.resolution_x = args["width"]
    scene.render.resolution_y = args["height"]
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(Path(args["outputDir"]) / "unused.png")

    def place_camera(azimuth_deg, elevation_deg, distance):
        azimuth = math.radians(azimuth_deg)
        elevation = math.radians(elevation_deg)
        location = (
            distance * math.cos(elevation) * math.cos(azimuth),
            distance * math.cos(elevation) * math.sin(azimuth),
            distance * math.sin(elevation),
        )
        camera.location = _vec3(location)
        direction = _vec3([-c for c in location])
        camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    distance = diag * 1.9
    base_name = Path(artifact).stem

    def render_to(name):
        out = Path(args["outputDir"]) / name
        scene.render.filepath = str(out)
        bpy.ops.render.render(write_still=True)
        report["rendered"][name] = str(out)

    # Explode transform: declared per-module directions override radial.
    explode_directions = {k: v for k, v in (args.get("explodeDirections") or {}).items()}

    def explode_objects(scale):
        import mathutils

        for obj in solids:
            declared = None
            for key, direction in explode_directions.items():
                if key and key.lower() in obj.name.lower():
                    declared = mathutils.Vector(direction)
                    break
            if declared is None:
                world_center = obj.matrix_world.translation
                radial = world_center - mathutils.Vector((0.0, 0.0, center[2]))
                if radial.length < 1e-9:
                    radial = mathutils.Vector((0.0, 0.0, 1.0))
                declared = radial.normalized()
            obj.location = obj.location + declared * (scale * diag * 0.45)

    def restore_locations():
        for obj, location in originals.items():
            obj.location = location
        bpy.context.view_layer.update()

    originals = {obj: obj.location.copy() for obj in solids}

    if args.get("hero", True):
        place_camera(45, 25, distance)
        render_to(f"{base_name}-hero.png" if args.get("namedOutputs") else "hero.png")

    if args.get("exploded", True):
        explode_objects(1.0)
        place_camera(45, 30, distance * 1.25)
        render_to("exploded.png")
        restore_locations()

    if args.get("turntable", True):
        frames = args["turntableFrames"]
        frames_dir = Path(args["outputDir"]) / "turntable-frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        scene.render.fps = args["fps"]
        for frame in range(frames):
            angle = 360.0 * frame / frames
            place_camera(angle, 22, distance)
            scene.render.filepath = str(frames_dir / f"frame_{frame:04d}.png")
            bpy.ops.render.render(write_still=True)
        report["turntableFrames"] = str(frames_dir)
        report["turntableFrameCount"] = frames

    if args.get("assemblyAnimation", False):
        frames = args["assemblyFrames"]
        frames_dir = Path(args["outputDir"]) / "assembly-frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        scene.render.fps = args["fps"]
        for frame in range(frames):
            # Reverse explosion: 1.0 (fully exploded) -> 0.0 (assembled).
            progress = frame / max(frames - 1, 1)
            restore_locations()
            explode_objects(1.0 - progress)
            place_camera(45 + 20 * progress, 25, distance * (1.15 - 0.15 * progress))
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


def _vec3(values):
    from mathutils import Vector

    return Vector(values)


if __name__ == "__main__":
    sys.exit(main())
