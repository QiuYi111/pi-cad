# reify-asi

Command line feature analyzer for B-rep parts. It is the second DFM layer
(see `docs/dfm/implementation-plan.zh-CN.md`, section 7). It reads a `.brep`
file and writes JSON with holes, cavities, blends, per-face wall thickness and
dihedral angles. Face IDs are 1-based in `TopExp::MapShapes` order, the same
order as FreeCAD's `Shape.Faces`.

It links Analysis Situs `asiAlgo` (v2024.2, BSD-3-Clause) and OCCT 7.6 (LGPL-2.1
with the OCCT exception). The OCCT 7.6 toolkit is built from conda-forge
(`occt 7.6.3`, the `novtk` variant without VTK). No Qt, VTK or Tcl is used.

## Install

```sh
bash scripts/bootstrap-asi.sh            # installs to ${XDG_DATA_HOME:-~/.local/share}/pi-cad/runtimes/asi
bash scripts/bootstrap-asi.sh --force    # removes the env, sources and build, and rebuilds
```

Linux x86_64 only. Exit 2 on other platforms. The script downloads the
Analysis Situs archive, checks its SHA-256, applies
`patches/asiAlgo-utils-no-x11.patch`, and builds with the conda compiler.

Rebuild the program only (after editing `src/`), using the environment the
bootstrap created:

```sh
ASI=${PI_CAD_ASI_HOME:-$HOME/.local/share/pi-cad/runtimes/asi}
$ASI/env/bin/cmake --build $ASI/build -j4        # if the build tree still exists
# or a fresh tree:
$ASI/env/bin/cmake -S native/reify-asi -B /tmp/reify-asi-build \
  -DCMAKE_CXX_COMPILER=$ASI/env/bin/x86_64-conda-linux-gnu-g++ \
  -DCMAKE_PREFIX_PATH=$ASI/env \
  -DASI_SRC=$ASI/analysis-situs-2024.2/src \
  -DEIGEN_INCLUDE_DIR=$ASI/env/include/eigen3
$ASI/env/bin/cmake --build /tmp/reify-asi-build -j4
```

The `bin/reify-asi` wrapper sets `LD_LIBRARY_PATH` to the environment's
`lib/` and runs `bin/reify-asi-bin`.

## Command line

```sh
reify-asi analyze --in part.brep --out result.json \
  [--checks holes,cavities,blends,thickness,dihedral] [--thickness-samples 400]
reify-asi analyze --in part.brep --dump-faces     # face table to stdout, no analysis
reify-asi --version
```

- `--checks` defaults to all five. Only the requested checks appear in the JSON.
- `--thickness-samples N` is the number of sample points per face (default 400).
- `--dump-faces` prints `{"faces": [{"id", "centroid", "area"}, ...]}` (the
  values FreeCAD exposes as `Faces[id-1].CenterOfMass` and `.Area`) and exits.
  `--out` and `--checks` are ignored in this mode.

Exit codes: `0` ok; `2` bad command line; `3` input missing, unreadable or
empty; `4` an analyzer failed; `5` output could not be written. On failure one
line is printed to stderr.

Output (abridged; see `docs/dfm/contract.md`):

```json
{"version": 1, "asi": "2024.2", "faces": 10,
 "holes": [{"faces": [7], "diameter": 3, "depth": 5, "axis": [0, 0, 1], "through": true, "bottom": "none"}],
 "cavities": [{"faces": [7], "base_faces": [3, 5]}],
 "blends": [{"faces": [7], "radius": 2, "kind": "concave"}],
 "thickness": [{"face": 3, "min": 5, "at": [1, 0.75, 5]}],
 "dihedral": [{"edge_faces": [3, 4], "angle_deg": 90, "convex": true, "edge_dir": [1, 0, 0]}],
 "timing_ms": {"load": 0.6, "holes": 3.0}}
```

## How each check is computed

- `holes`: `asiAlgo_RecognizeDrillHoles` finds the hole faces. Connected groups
  of cylinder faces form holes. Through or blind is decided by probing the
  solid just past each end of the cylinder. A blind bottom is the face across
  the bottom circle (`flat`, `cone`, `sphere`, otherwise `unknown`). A through
  hole has `bottom: "none"`. `depth` is the cylinder length (the drill point is
  not included).
- `cavities`: `asiAlgo_RecognizeCavities`. `base_faces` are the faces the cavity
  opens into or sits on.
- `blends`: `asiAlgo_RecognizeBlends`. `kind` is the majority vexity recorded by
  the recognizer, or `unknown` when none was recorded.
- `thickness`: OCCT ray casting, not Analysis Situs' own routine (that routine
  needs the optional Mobius library and returns a mesh field). For each face,
  points are sampled over the trimmed face and a ray is cast along the inward
  normal. The face value is the smallest hit distance. Faces with no hit are
  omitted.
- `dihedral`: the AAG arcs from `asiAlgo_AAG`. `angle_deg` is the magnitude of
  the angle between the two face normals (the AAG reports it signed).
  `convex` comes from the AAG arc type. `edge_dir` is the unit tangent of the
  shared edge at its midpoint.

## Patch

`patches/asiAlgo-utils-no-x11.patch` removes the X11/OpenGL screenshot path from
`asiAlgo_Utils.cpp` (`GeneratePixmap` returns null). Nothing in this tool calls
it. The CMake project refuses to configure an unpatched source tree.

## License

- Analysis Situs (`asiAlgo`, `asiActiveData` parts used here): BSD-3-Clause.
  The LICENSE is in the source archive.
- OCCT 7.6: LGPL-2.1 with the OCCT exception. Distribution must follow the
  LGPL terms (dynamic linking, notice).
- The `reify-asi` sources in this directory: same terms as the repository.

## Files

- `CMakeLists.txt`, `cmake/asi_sources.cmake`: build; the list of Analysis Situs sources used.
- `src/`: CLI (`main.cpp`, `analyze.cpp`), checks (`holes.cpp`, `cavities.cpp`,
  `blends.cpp`, `thickness.cpp`, `dihedral.cpp`), face table (`faces.cpp`), JSON (`json.cpp`).
- `patches/`: source patch applied to Analysis Situs.
- `tools/make_test_parts.py`: builds test parts with FreeCAD's Part API (run with the FreeCAD env's Python).
- `tools/check_face_ids.py`: E0-b check; compares `--dump-faces` with FreeCAD's faces.
- `testdata/plate_4holes.brep`: fixture used by the bootstrap smoke test.
- `conda-linux-64.lock`: explicit conda lock for the environment.
