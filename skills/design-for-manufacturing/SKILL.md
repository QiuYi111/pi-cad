---
name: design-for-manufacturing
description: Adapt mechanical geometry for manufacturability, inspection, assembly, cost, and process capability. Use when selecting a manufacturing process, assigning tolerances and finishes, reviewing machining, sheet-metal, molding, additive, or fabricated-part constraints, or checking a cad.part model against a vendor rulepack such as 铨洲 CNC milling (quanzhou.cnc_mill).
---

# Design for manufacturing

Choose a realistic process before finalizing detailed geometry. Match tolerance, finish, material, quantity, and inspection requirements to actual process capability.

- Read [references/process-selection.md](references/process-selection.md) for process and material tradeoffs.
- Read [references/geometry-rules.md](references/geometry-rules.md) for tolerance discipline, tool access, draft, walls, bends, supports, and inspection.
- Read [references/process-checklists.md](references/process-checklists.md) only for the selected manufacturing process.
- Use supplier-specific guidance when a vendor or process is named; do not substitute generic limits for current vendor capability.

Avoid tighter tolerances and finer finishes than function or inspection requires.

## 铨洲 CNC milling in cad.part

Use this section when the part is for 铨洲智造 CNC 智能制造打样（铣削）, the `quanzhou.cnc_mill` rulepack. Its rules are in [references/quanzhou-cnc-mill.md](references/quanzhou-cnc-mill.md) (generated from the rulepack, with the guide page for each rule). Do not apply these limits to another vendor.

1. **Set the profile in the first ops batch** when a manufacturing target exists:
   `{"op": "dfm_profile", "rulepack": "quanzhou.cnc_mill", "material": "al6061"}`.
   Materials are `al6061`, `al7075` and `steel_45`. Without a manufacturing target, set no profile; `dfm` is then `null`.
2. **Read `dfm` after every apply or try.** It gives `counts`, `issues` (errors and warnings, errors first, each with its semantic `target`, `measured`, `limit`, `hints` and `source` page) and `geometry`.
   - `error`: fix it before anything else. The result will not be accepted.
   - `warn`: fix it, or keep it and give the reason in the delivery note.
   - `info`: the platform applies a default (for example a C0.1 to 0.5 chamfer on sharp edges, or a R2 in a sharp inner corner). Decide whether that is acceptable and say so when it matters.
   - A rule that the lint cannot judge is listed as skipped in coverage. Skipped is not passed.
3. **Before delivery, run the geometry check** `await doc.dfm()`. It returns `issues`, `counts`, `coverage`, `report_path` and an image with the problem faces highlighted; look at the image. The part is ready when `geometry.state` is `"fresh"` (the check ran on the current revision) and there are 0 errors. `doc.dfm()` is being added alongside this skill. If it is not available in the environment, say so; do not report the geometry check as passed.
4. **Never get around a rule.** Do not add thin slivers, small bosses, or parts ganged together by thin ribs to satisfy a dimension or to hide a problem. The vendor treats ganging (拼板) and such shapes as violations and may suspend the account (guide pages 3 and 11). If a rule seems wrong for the design, keep the design and report the rule and the reason.

### Modelling habits for this process

- **Threaded holes:** `hole` with `thread` (for example `"M3"`) and `diameter` set to the tap drill from the vendor table: M2 1.6, M2.5 2.05, M3 2.5, M4 3.3, M5 4.2, M6 5.0, M8 6.8, M10 8.5, M12 10.2 mm. Never write the nominal size, and never model the thread. Name the thread in the feature path, for example `bracket/m3_tap`. A M3 tapped hole cuts exactly 2.5 mm (measured).
- **Blind tapped holes:** set `thread_depth` to the thread length. The drill depth must be at least `thread_depth` + 1 × the drill diameter. Keep the thread length at most 5 × the nominal size, and the thread depth at least 0.6 × the nominal size (0.8 × below M3). A thread that runs the whole hole gets no drill allowance, so it warns.
- **Blind holes:** flat bottom, `"drill_point": "flat"`. Round or spherical bottoms are not supported. Depth to diameter up to 3 is fine, 3 to 5 is info (drilled, less precise), above 5 warns, above 8 is an error. Use a counterbore rather than a countersink, and never let a countersink cone reach the bottom of the hole.
- **Outer edges:** round or chamfer the outline on one face only. Do not put outer chamfers or fillets on both the top and bottom faces of the same outline.
- **Pockets:** give inner vertical corners a radius of at least depth / 5, for example a fillet between the two adjacent `wall` roles (`between`). A sharper corner gets the vendor's R = depth / 5 anyway, and a corner with a fit requirement warns. Floor fillets are larger than R2; no chamfers on pocket floors.
- **Walls and cavities:** walls at least 1 mm thick; cavity and slot width at least 1.25 mm; slot depth at most 5 × the tool diameter (the largest standard tool narrower than the slot).
- **Stock:** Z thickness 1 to 30 mm; sorted bounding box between 10 × 10 × 1 and 650 × 440 × 30 mm. A standard plate thickness is preferred (an info item otherwise).
- **Tolerances:** the default is GB/T 1804-m. A `dimension` requirement tighter than m for its size is info: say whether a fit needs the mating hole modelled 0.02 to 0.03 mm larger, or agree the tolerance with the vendor.

## Other processes

The sections above are the 铨洲 CNC path. For any other process, work from the checklists: confirm the process, material and tolerance first, then the geometry rules for that process, and name the inspection method for each critical feature.
