---
name: blender-product-rendering
description: Create polished Blender product renders or requested animations from CAD geometry using Pi-CAD's managed Blender runtime.
---

# Blender product rendering

Treat CAD as geometry authority. Use Blender for materials, staging, lighting, cameras, motion, rendering, and compositing. Preserve dimensions, interfaces, part placement, and joint meaning unless the user asks to change the design.

## Runtime

Run every Blender command through the managed `cadctl blender` entrypoint:

```python
import subprocess, sys
subprocess.run([sys.executable, "-m", "cadctl", "blender", "--", "--background", "--python", "scene.py"], check=True)
```

For a script that needs the executable path:

```python
subprocess.run([sys.executable, "-m", "cadctl", "blender", "--print-path"], check=True)
```

The command must report a managed runtime. Stop with its concrete error if unavailable. Direct PATH lookup, `blender`, and `/usr/bin/blender` bypass the pinned version and GPU policy.

## Work

1. Inspect the source assembly, units, part names, transforms, and joints. Decide whether the request needs a hero still, a small view set, an exploded view, or animation. Animation requires user intent.
2. Build a cheap blockout. Lock a bbox-aware camera and broad lights before detailed materials.
3. Make a low-resolution preview. Inspect the rendered image itself for assembly continuity, crop, scale, silhouette, reflections, overexposure, and material separation.
4. Develop physically meaningful materials and product lighting. Read [materials](references/materials.md) and [lighting and camera](references/lighting-camera.md).
5. Render another preview and diagnose the weakest layer: geometry, material, lighting, camera, or grade. Change one layer at a time until the preview passes.
6. Render the requested output with the pinned Blender 4.5 API. Read [rendering](references/rendering.md) and [Blender 4.5 API](references/blender-4.5-api.md).
7. Inspect representative final frames and report the managed Blender version, device, resolution, render time, and output paths.

The preview passes only when the assembly is connected, the subject is readable at first glance, material classes are distinct, highlights retain detail, and no important feature is cropped or hidden unintentionally.

Read [workflow](references/workflow.md) for multi-stage scenes, exploded views, or motion. Source acknowledgements are in [NOTICE](NOTICE.md).
