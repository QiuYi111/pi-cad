# Deliverable tools

- `cad_export`: deterministic geometry sidecars; retain STEP as the primary exchange artifact.
- `cad_generate_drawing`: generate a structured engineering drawing from the current design and declared views/dimensions. A drawing reports design intent; it does not invent tolerances or manufacturing requirements.
- `cad_render_scene`: create presentation renders or animation assets from explicit scene specifications. Rendering is communication evidence, not geometry or simulation evidence.

Package only artifacts whose source, authoritative CAD version, units, and provenance are clear. Missing engineering data should remain explicit rather than being filled by presentation defaults.
