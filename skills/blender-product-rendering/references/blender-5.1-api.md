# Blender 5.1 API

Target the Pi-CAD manifest version, currently Blender 5.1.3. Probe the managed binary's version before relying on optional API.

- EEVEE engine: `BLENDER_EEVEE_NEXT` in 5.1. Do not copy Blender 5-only engine assumptions.
- Prefer PNG sequences plus external encoding when the managed build does not expose FFmpeg output.
- Configure Cycles devices through the `cycles` addon preferences and verify the effective device list.
- Use AgX through `scene.view_settings.view_transform` and choose only looks present in the running build.
- Guard optional node sockets and properties with inspection. Principled BSDF socket names differ across Blender generations.
- For animation curve edits, inspect the action representation exposed by 5.1 instead of assuming Blender 5 slot APIs.

Run a one-frame API smoke test before a long render. A version mismatch is a runtime failure, not a reason to fall back to PATH Blender.
