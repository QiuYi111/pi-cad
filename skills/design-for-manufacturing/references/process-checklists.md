# Process checklists

These are questions, not automatic acceptance limits. Use the named supplier, machine, material, and standard for actual values.

## FDM printing

- Choose build orientation from strength direction, support, surface quality, time, and dimensional behavior together.
- Check minimum walls against nozzle and line-width strategy; distinguish a modeled wall from slicer-generated shells.
- Make holes, pins, snap fits, and print-in-place gaps tunable. Calibrate them on the target printer/material before claiming a fit.
- Avoid unsupported internal roofs and trapped support. Add lead-ins and elephant-foot relief where mating starts at the build plate.
- Check layer-direction weakness at hinges, hooks, clips, and screw bosses.
- Ensure each separate part lies in a printable pose or provide an explicit assembly/print plan.

## CNC machining

- Establish stock, setups, primary datums, and workholding before detailing inaccessible faces.
- Internal corners inherit cutter radius. Deep narrow pockets and long small tools increase deflection and time.
- Provide tool approach and over-travel for holes, undercuts, grooves, and side features.
- Avoid unnecessary full-depth slots and thin unsupported walls.
- Separate geometric tolerances from surface-finish requirements and name how each will be inspected.

## Sheet metal

- Use one material thickness and a declared bend model unless the part is intentionally mixed.
- Check inside bend radius, bend relief, minimum flange, hole-to-bend distance, and tooling access against the chosen shop.
- Verify the flat pattern and bend sequence. A folded shape can be geometrically valid yet impossible to form in sequence.
- Place critical dimensions from stable formed datums; account for bend variation.

## Injection molding

- Keep nominal walls consistent where function permits; transition gradually around thick regions.
- Provide draft in the actual pull direction. Identify parting line, shutoffs, side actions, and ejection surfaces.
- Check ribs and bosses for sink, short-shot, and ejection risk rather than merely adding thickness.
- Consider gate path, weld lines, trapped gas, texture, and post-mold assembly.

## Casting

- Define parting, draw, machining stock, cores, and accessible cleanup surfaces.
- Use gradual section changes and fillets to reduce hot spots and stress concentration.
- Put precision interfaces in a machining plan rather than assuming as-cast accuracy.

## Weldments and fabrication

- Show joint preparation, weld access, sequence, fixturing, and distortion allowance.
- Do not dimension every member independently when a fixture or common datum controls the assembly.
- Check torch access, inspection access, drainage, and closed-volume venting.

## Inspection and release

Every critical characteristic needs a datum, instrument, access path, and plausible repeatability. A dimension that cannot be made or measured under the selected process is not finished engineering.
