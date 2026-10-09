# WP0 spike results: E0-a and E0-b

Date: 2026-10-09. Machine: 4 cores, 15 GB RAM, Ubuntu 24.04 container.
Scope: `native/reify-asi/`, `scripts/bootstrap-asi.sh`, this file.

## Summary

| Experiment | Result | Notes |
|---|---|---|
| E0-a | **Passed** | Builds with no Qt, VTK or Tcl. The 40 x 30 x 5 plate with four φ3 through holes gives four holes, diameter 3, `through: true`. |
| E0-b | **Passed** | 13 of 13 test parts match FreeCAD's `Shape.Faces[n-1]` in order, centroid and area. FreeCAD 1.1.0 (OCCT 7.9.3) `exportBrep` output loads in OCCT 7.6.3. |
| E0-c | Not in this task | Not run here. |

Two contract items were changed or extended; see "Deviations" below.

## E0-a: reify-asi on Analysis Situs v2024.2

### What was built

- Source: `AnalysisSitus-v2024.2.tar.gz` from gitlab.com/ssv/AnalysisSitus. SHA-256
  `ea655706d40631e01867649f33520fff463c536cd322bda66c1f911315511c25`. The bootstrap
  downloads it, checks the hash, and extracts only `src/` and `LICENSE`.
- asiAlgo and asiActiveData sources: the include closure of the six algorithm
  entry points (drill holes, cavities, blends, AAG, dihedral angle, thickness)
  gives 82 `.cpp` files. The list is in `native/reify-asi/cmake/asi_sources.cmake`.
  `USE_MOBIUS` is off. Mobius code is guarded by `#if defined USE_MOBIUS`.
- One patch, `native/reify-asi/patches/asiAlgo-utils-no-x11.patch`. It removes the
  X11/OpenGL screenshot path in `asiAlgo_Utils.cpp`, which is not used here.
- The closure has no VTK, Qt, Tcl or TBB includes. Mobius, X11 and Windows
  headers appear only under `USE_MOBIUS`, `__unix`/`_WIN32` branches that are not
  built here, or in the patched screenshot code. The Linux build needs OCCT and
  Eigen headers only.
- Own code, `native/reify-asi/src/`: CLI and JSON (no JSON library), holes,
  cavities, blends, dihedral (AAG), thickness (OCCT ray cast), `--dump-faces`.

### Dependencies

| Component | Version | Source |
|---|---|---|
| OCCT | 7.6.3 (`novtk` build) | conda-forge `occt` |
| Eigen | 5.0.1 (headers only) | conda-forge `eigen` |
| rapidjson | 1.1.0 | conda-forge; installed but **not used** (see Deviations) |
| C++ compiler | GCC 15.3.0 | conda-forge `cxx-compiler` |
| CMake / make | 4.4.4 / 4.4.1 | conda-forge |

Runtime shared libraries (`ldd`): 17 OCCT toolkits (TKernel, TKMath, TKG2d, TKG3d,
TKGeomBase, TKBRep, TKGeomAlgo, TKTopAlgo, TKPrim, TKBO, TKShHealing, TKBool,
TKFillet, TKOffset, TKIGES, TKSTL, TKXSBase), plus libstdc++ and libgcc_s from the
environment, and the system libc.
TKIGES and TKSTL are linked only because `asiAlgo_Utils.cpp` references their
import/export helpers. The algorithms do not use them.

### Build time, size, cold start

| Measure | Value |
|---|---|
| Compile + link of `reify-asi` (`cmake --build -j4`) | 58 s (runtime.json `buildSeconds`) |
| `bootstrap-asi.sh --force` total, archive already downloaded (final run) | 1 min 29 s |
| `bootstrap-asi.sh` total from empty install root (includes 545 MB download and environment creation) | 1 min 56 s |
| `bin/reify-asi-bin` size (not stripped, final build) | 1.9 MB (1 905 760 bytes) |
| Environment size (`env/`) | 1.4 GB |
| Cold start: `reify-asi --version` | 28 ms wall |
| Cold start: one check (`dihedral`) on a box | 30 ms wall |

### Time on a 206-face part

`native/reify-asi/tools/make_test_parts.py` builds `grid_blind_200`: a 100 x 100 x 10
block with 100 blind holes (d4, depth 3, flat bottoms). It has 206 faces.

| Stage | ms (400 samples/face) | ms (100 samples/face) |
|---|---|---|
| load (read BRep, face map) | 2.4 | 4.3 |
| holes | 84 | 84 |
| cavities | 11 | 8 |
| blends | 6 | 4 |
| thickness | **6 430** | 1 630 |
| dihedral | 4 | 4 |
| Wall time, all five checks | 6 565 | 1 739 |

Thickness dominates. Each sample ray is tested against every face (OCCT
`IntCurvesFace_ShapeIntersector`), so the cost is about rays x faces. The default
of 400 samples per face is kept, since the plan's example uses it. Callers that
need interactive latency should pass `--thickness-samples 100`.

### Acceptance cases

| Case | Expected | Result |
|---|---|---|
| Plate 40 x 30 x 5, four φ3 through holes | 4 holes, diameter 3, through | 4 holes, diameter 3, `through: true`, `bottom: "none"`. |
| Blind hole d4, depth 6, flat bottom (block 40 x 30 x 10) | diameter 4, depth 6, flat | diameter 4, depth 6, `bottom: "flat"`, `through: false`, axis `[0,0,-1]` (from the open top into the material). |
| Pocket 20 x 14 x 4 with R2 corners | one cavity, four R2 concave corners | 1 cavity (faces 7–15), 4 blends of radius 2, `kind: "concave"`. |
| Wall 0.6 mm (channel leaves two 0.6 mm walls) | min thickness 0.6 | Faces 1, 6, 8, 10 report `min: 0.6`. |

All other test parts were also run with all five checks. Hole counts, through/blind
flags, cavities and blends were all consistent with the geometry. The filleted box
gives one convex R1 chain.

## E0-b: face IDs and FreeCAD `.brep` files

- FreeCAD 1.1.0 (`Part.OCC_VERSION` 7.9.3) `shape.exportBrep()` writes the text
  format `DBRep_DrawableShape` / `CASCADE Topology V1`. OCCT 7.6.3 reads it with
  `BRepTools::Read` without any export option. No `BRepTools::Write` option was needed.
- `tools/check_face_ids.py` runs `reify-asi analyze --in part.brep --dump-faces`
  for each part and compares face by face with the in-memory FreeCAD values
  (`CenterOfMass`, `Area`). Tolerance: centroid within 1e-6 x diagonal, area within
  1e-6 relative.
- Result: **13 of 13 parts match** (plate_4holes, blind_d4_depth6, pocket_r2,
  thin_wall_0p6, box_plain, cylinder_shaft, cone_frustum, sphere_cut_block,
  l_bracket, filleted_box, countersunk_plate, tube, grid_blind_200 with 206 faces).
  Face order is `TopExp::MapShapes(TopAbs_FACE)` order, 1-based.
- The fallback match (centroid, normal, area) was not needed and is not implemented.

## Deviations from the contract

1. **`holes[].bottom` can be `"none"`** for through holes. The contract enum lists
   flat, cone, sphere, unknown. A through hole has no bottom. Please approve the
   new value or name a different one.
2. **`blends[].kind` can be `"unknown"`** when the recognizer records no vexity
   for the chain. The contract enum lists concave and convex. Observed: all test
   fillets gave a definite value.
3. **`dihedral[].angle_deg`** is the magnitude of the angle between the two face
   normals, as reported by the AAG. Analysis Situs returns a signed value. It is
   not the interior dihedral. For 90 degree edges the two are equal. Convexity comes
   from the AAG arc type, not from the sign.
4. **Only requested checks appear in the JSON.** The contract example shows all
   keys. Absence means "not run".
5. **Thickness** uses OCCT ray casting, not `asiAlgo_CheckThickness`. The contract
   allows this. The Analysis Situs routine needs Mobius and returns a mesh field,
   not a per-face minimum. Faces with no hit are omitted from the output. The `at`
   point is the sample on the face where the minimum was found. Results are
   sample-limited: the 206-face part gives 4.07 at 400 samples, against an exact
   value of 4.0.
6. **Through holes:** `axis` is the cylinder's native direction (sign is not
   meaningful). **Depth** is the cylinder length; the drill point is not included.
7. **Exit code 6** is new in `bootstrap-asi.sh` (extraction, patch or build
   failure). Codes 0, 2, 3, 4, 5 follow `bootstrap-freecad.sh`. Codes for
   `reify-asi` itself: 0 ok, 2 usage, 3 input, 4 analyzer, 5 output.
8. **rapidjson** is in the environment list in the contract but is not used,
   because JSON is written directly. It can be dropped from the spec. It is
   still installed by the bootstrap for now.
9. **Lock file:** `native/reify-asi/conda-linux-64.lock` (explicit lock) is used by
   the bootstrap when present, so the environment is reproducible.
10. **Not done:** the CNC milling classification (commercial, not used). Tests for
    more part families (E0-c).

## Reproduce

```sh
# install (Linux x86_64; ~2 min plus download; idempotent)
bash scripts/bootstrap-asi.sh            # add --force to rebuild from scratch

ASI=$HOME/.local/share/pi-cad/runtimes/asi
B=$ASI/bin/reify-asi

# E0-a acceptance parts (FreeCAD Part API; writes .brep files and face tables)
E=$HOME/.local/share/pi-cad/runtimes/freecad/env
PYTHONPATH=$E/lib $E/bin/python native/reify-asi/tools/make_test_parts.py /tmp/asi-parts
$B analyze --in /tmp/asi-parts/plate_4holes.brep --out /tmp/plate.json --checks holes
$B analyze --in /tmp/asi-parts/grid_blind_200.brep --out /tmp/g200.json --thickness-samples 100

# E0-b face IDs
python3 native/reify-asi/tools/check_face_ids.py --reify-asi $B --parts /tmp/asi-parts
```
