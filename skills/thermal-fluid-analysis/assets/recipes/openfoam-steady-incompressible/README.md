# OpenFOAM 14 steady incompressible Recipe

Start from an official v14 `incompressibleFluid` tutorial case. Supply `0/`, `constant/`, and `system/`; set `solver incompressibleFluid` in `controlDict`; replace the declared input and every patch/field boundary. `Allrun` fails before solve unless `checkMesh` succeeds. The residual plot is a visual context floor, not a substitute for a physical field image—extend the observer with a case-specific contour and conservation/function-object exports before engineering commit.
