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
