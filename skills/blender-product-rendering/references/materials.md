# Materials

Assign materials by manufacturing meaning: machined or bead-blasted metal, anodized metal, powder coat, molded polymer, elastomer, glass, wood, labels, and reference-only geometry.

Use Principled BSDF. Metals use metallic 1.0 unless a coating covers them. Dielectrics use metallic 0.0. Use roughness, anisotropy, clear coat, normals, and small-scale variation to distinguish finishes; avoid using color alone.

Keep variation subtle and tied to process:

- bead-blasted aluminum: broad soft highlights, fine normal variation;
- brushed metal: directional anisotropy aligned to the manufacturing direction;
- powder coat: dielectric surface, high roughness, very fine bump;
- molded polymer: dielectric, moderate roughness, restrained edge response;
- elastomer: dark dielectric, broad muted highlights;
- wood: directional grain in base color and roughness, real scale.

Check materials under neutral broad light. If a gray metal becomes white, correct exposure and highlight energy before darkening its base color. Keep labels and accent colors secondary to form.
