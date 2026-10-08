# Assembly verification

An assembly tree proves structure, not correctness. Compare it with the committed module list, interface contracts, and installation sequence.

Interpret probe facts in context:

- penetration may be a defect or an intentional press fit;
- contact may be a stop, seal, or accidental clash;
- positive clearance may still be inadequate under tolerance or motion.

Probe critical interfaces at worst-case positions and include tool/service envelopes when relevant. Candidate changes stale version-bound evidence; re-probe before acceptance.

## Moving and print-in-place assemblies

Before review, check the manufactured configuration, not only the displayed working pose. For every moving body pair, measure both common volume and minimum distance; zero common volume does not prove a printable release gap. Sample the required motion positions and exclude only named intentional contacts.

For support-free print-in-place designs, verify in the exact exported print orientation that every disjoint body reaches the build plane or has a self-supporting path from it. Inspect unsupported spans and first layers. Also verify functional face ownership and direction: load-bearing contacts, indexing features, user contact faces, and access openings must remain on their intended sides throughout assembly and motion.

## Buildability checklist (answer for every part before review)

A model with zero interference can still be a toy that cannot be built or assembled. Reviewing a real rollout showed a car that passed all geometry checks and the user said it could not really be made or assembled (the motor held only by a strap, bearings without axial stops, wheels that slide off the axle, no battery contacts or switch, no nut on the roller). Before you close the verify phase, answer these in writing, one line per part:

1. **Six degrees of freedom.** Which features or fasteners remove each of the six degrees of freedom of this part? Name the faces or joints. "Held by friction" is not an answer unless a spring or clamp force is modeled.
2. **Axial stops.** For every shaft, bearing, wheel or pin: what stops it in each axial direction (shoulder, clip, nut, collar, press fit)? A part that slides off in one direction has one missing stop.
3. **Fasteners.** Is every screw, nut and washer a modeled part with a matching hole, thread size and length? Is there room for a tool?
4. **Electrical path.** For a powered product: battery, contacts, switch and motor are connected by a modeled conductor or contact face, and the path is closed.
5. **Installation order.** Can each part be installed in the sequence you wrote, without moving a part that is already fixed?
6. **Motion and service.** Moving pairs have a clearance (common volume 0 and a positive minimum distance) over the full travel, and the user can reach what must be replaced.
