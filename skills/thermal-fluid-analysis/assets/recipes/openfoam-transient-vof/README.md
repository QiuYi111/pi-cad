# OpenFOAM 14 transient VOF Recipe

Start from the official v14 `incompressibleVoF` dam-break family, then replace domain, gravity, phases, initial field and every patch condition. The bundled plot only proves the generic visual/quantitative protocol; a real case must add interface imagery/animation, phase mass balance, Courant history, ventilation/trapped-gas metrics and mesh/time-step refinement appropriate to the claim.
