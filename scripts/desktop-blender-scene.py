#!/usr/bin/env python3
"""Inspect or render the open .blend file. Run only through Blender's Python."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("inspect", "render"))
    parser.add_argument("--camera")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    scene = bpy.context.scene
    cameras = [obj.name for obj in bpy.data.objects if obj.type == "CAMERA"]
    if args.operation == "inspect":
        print("REIFY_JSON:" + json.dumps({
            "scene": Path(bpy.data.filepath).name,
            "cameras": cameras,
            "activeCamera": scene.camera.name if scene.camera else None,
            "objectCount": len(bpy.data.objects),
            "frame": scene.frame_current,
            "frameStart": scene.frame_start,
            "frameEnd": scene.frame_end,
        }))
        return
    if not args.output:
        raise ValueError("Render output is required.")
    if args.camera:
        camera = bpy.data.objects.get(args.camera)
        if camera is None or camera.type != "CAMERA":
            raise ValueError(f"Camera not found: {args.camera}")
        scene.camera = camera
    if scene.camera is None:
        raise ValueError("The scene has no render camera.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(args.output)
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    print("REIFY_JSON:" + json.dumps({"path": str(args.output), "camera": scene.camera.name}))


if __name__ == "__main__":
    main()
