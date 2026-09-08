---
name: blender-product-rendering
description: Create polished Blender product renders or requested animations from authoritative CAD through the official Blender MCP.
---

# Blender product rendering

CAD is geometry authority. Blender only handles import, materials, staging, lighting, cameras, motion, rendering, and compositing. Never remodel or distort engineering geometry.

## Tools

Use Prime's generic MCP client. The `blender` server is the official Blender MCP connected to Pi-CAD's managed Blender 5.1 runtime.

```python
tools = await mcp.list_tools("blender")
result = await mcp.call_tool("blender", "execute_blender_code", {"code": "..."})
```

Do not run `blender`, `/usr/bin/blender`, subprocess Blender, or the legacy presentation tool. If MCP is unavailable, report its concrete connection or runtime error.

Before import, create a labeled mesh bundle with provenance:

```python
import subprocess, sys
subprocess.run([sys.executable, "-m", "cadctl", "blender-bridge", "--artifact", step_path, "--source", source_path, "--output-dir", bundle_dir], check=True)
```

Read `manifest.json`, import each STL through `execute_blender_code`, and use `occurrenceKey` as the Blender object name. Keep `provenance.json` beside the final `.blend` and renders.

## Work

1. Inspect the assembly, units, names, transforms, and joints. Animation requires user intent.
2. Import the bridge bundle. Do not change part geometry or placement unless animation uses verified transforms.
3. Make a cheap blockout. Lock a bounding-box-aware camera and broad lights before detailed materials.
4. Render a low-resolution preview with `render_thumbnail_to_path` or `render_viewport_to_path`. Attach and inspect the image itself.
5. Add physically meaningful materials, product lighting, deliberate focal length, and AgX color management. Use Cycles GPU, adaptive sampling, and denoise for final product work.
6. Preview again. Fix the weakest layer: material, lighting, camera, composition, or grade. Never start a long render before visual inspection.
7. Render only requested outputs. Do not make animation by default. For requested motion, inspect representative frames before the full sequence.
8. Save the `.blend`; report Blender version, device, resolution, render time, output paths, and provenance path.

Read [workflow](references/workflow.md), [materials](references/materials.md), [lighting and camera](references/lighting-camera.md), [rendering](references/rendering.md), and [Blender 5.1 API](references/blender-5.1-api.md). Source acknowledgements are in [NOTICE](NOTICE.md).
