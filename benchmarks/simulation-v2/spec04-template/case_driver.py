from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from build123d import Compound, export_stl, import_step


MESH_CELLS = {"coarse": 18, "nominal": 26, "fine": 36}
ROBUSTNESS_SCALE = {"low": 0.9, "nominal": 1.0, "high": 1.1}
PATCHES = ("inlet", "vent", "walls", "plugSurface")


def finite(value: object, where: str, *, positive: bool = False) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        raise ValueError(f"{where} must be finite")
    result = float(value)
    if positive and result <= 0:
        raise ValueError(f"{where} must be positive")
    return result


def vector(value: object, where: str) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{where} must contain three numbers")
    return tuple(finite(item, f"{where}[{index}]") for index, item in enumerate(value))  # type: ignore[return-value]


def foam_vector(value: tuple[float, float, float]) -> str:
    return f"({value[0]:.12g} {value[1]:.12g} {value[2]:.12g})"


def run(case: Path, *command: str) -> None:
    log = case / f"log.{command[0]}.{len(list(case.glob('log.*'))):03d}"
    with log.open("wb") as output:
        subprocess.run(command, cwd=case, check=True, stdout=output, stderr=subprocess.STDOUT)


def scalar_field(path: Path) -> np.ndarray:
    text = path.read_text(encoding="utf-8", errors="replace")
    uniform = re.search(r"internalField\s+uniform\s+([0-9.eE+-]+)\s*;", text)
    if uniform:
        return np.asarray([float(uniform.group(1))])
    match = re.search(r"internalField\s+nonuniform\s+List<scalar>\s+\d+\s*\((.*?)\)\s*;", text, re.S)
    if not match:
        raise RuntimeError(f"cannot parse scalar field {path}")
    return np.fromstring(match.group(1), sep=" ")


def data_rows(root: Path, name: str) -> list[list[float]]:
    candidates = sorted(root.glob(f"postProcessing/{name}/**/*.dat"))
    if not candidates:
        raise RuntimeError(f"OpenFOAM function object {name} produced no data")
    rows: list[list[float]] = []
    for line in candidates[-1].read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        values = [float(item) for item in re.findall(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", line)]
        if values:
            rows.append(values)
    if not rows:
        raise RuntimeError(f"OpenFOAM function object {name} data is empty")
    return rows


def write_case_files(case: Path, *, bounds: tuple[tuple[float, float, float], tuple[float, float, float]], inside: tuple[float, float, float], cells: int, materials: dict, velocities: dict) -> None:
    (xmin, ymin, zmin), (xmax, ymax, zmax) = bounds
    span = max(xmax - xmin, ymax - ymin, zmax - zmin)
    pad = max(span * 0.08, 1e-5)
    lo = (xmin - pad, ymin - pad, zmin - pad)
    hi = (xmax + pad, ymax + pad, zmax + pad)
    vertices = [
        (lo[0], lo[1], lo[2]), (hi[0], lo[1], lo[2]), (hi[0], hi[1], lo[2]), (lo[0], hi[1], lo[2]),
        (lo[0], lo[1], hi[2]), (hi[0], lo[1], hi[2]), (hi[0], hi[1], hi[2]), (lo[0], hi[1], hi[2]),
    ]
    (case / "system" / "blockMeshDict").write_text(
        "FoamFile { format ascii; class dictionary; object blockMeshDict; }\nscale 1;\nvertices\n(\n"
        + "\n".join(f"  {foam_vector(item)}" for item in vertices)
        + f"\n);\nblocks (hex (0 1 2 3 4 5 6 7) ({cells} {cells} {cells}) simpleGrading (1 1 1));\nedges ();\nboundary (outer {{ type patch; faces ((0 3 2 1) (4 5 6 7) (0 1 5 4) (1 2 6 5) (2 3 7 6) (3 0 4 7)); }});\n",
        encoding="utf-8",
    )
    geometry = "\n".join(f"  {name} {{ type triSurfaceMesh; file \"{name}.stl\"; name {name}; }}" for name in PATCHES)
    surfaces = "\n".join(f"    {name} {{ level (2 3); patchInfo {{ type {'wall' if name in ('walls', 'plugSurface') else 'patch'}; }} }}" for name in PATCHES)
    (case / "system" / "snappyHexMeshDict").write_text(f"""FoamFile {{ format ascii; class dictionary; object snappyHexMeshDict; }}
castellatedMesh true; snap true; addLayers false;
geometry
{{
{geometry}
}}
castellatedMeshControls
{{
  maxLocalCells 4000000; maxGlobalCells 8000000; minRefinementCells 0; nCellsBetweenLevels 2;
  features ();
  refinementSurfaces
  {{
{surfaces}
  }}
  resolveFeatureAngle 30; refinementRegions {{}}; locationInMesh {foam_vector(inside)}; allowFreeStandingZoneFaces true;
}}
snapControls {{ nSmoothPatch 3; tolerance 2; nSolveIter 30; nRelaxIter 5; nFeatureSnapIter 10; implicitFeatureSnap true; explicitFeatureSnap false; multiRegionFeatureSnap false; }}
addLayersControls {{ relativeSizes true; layers {{}}; expansionRatio 1; finalLayerThickness 0.3; minThickness 0.1; nGrow 0; featureAngle 60; slipFeatureAngle 30; nRelaxIter 3; nSmoothSurfaceNormals 1; nSmoothNormals 3; nSmoothThickness 10; maxFaceThicknessRatio 0.5; maxThicknessToMedialRatio 0.3; minMedialAxisAngle 90; nBufferCellsNoExtrude 0; nLayerIter 50; }}
meshQualityControls {{ #include "meshQualityDict" }}
mergeTolerance 1e-6;
""", encoding="utf-8")
    liquid = materials["liquid"]
    gas = materials["gas"]
    (case / "constant" / "phaseProperties").write_text(f"FoamFile {{ format ascii; class dictionary; object phaseProperties; }}\nphases (liquid gas);\nsigma {finite(materials['surfaceTension'], 'surfaceTension', positive=True):.12g};\n", encoding="utf-8")
    for name, item in (("liquid", liquid), ("gas", gas)):
        (case / "constant" / f"physicalProperties.{name}").write_text(f"FoamFile {{ format ascii; class dictionary; object physicalProperties.{name}; }}\nviscosityModel constant;\nnu {finite(item['nu'], f'{name}.nu', positive=True):.12g};\nrho {finite(item['rho'], f'{name}.rho', positive=True):.12g};\n", encoding="utf-8")
    gravity = vector(materials.get("gravity", [0, 0, -9.81]), "gravity")
    (case / "constant" / "g").write_text(f"FoamFile {{ format ascii; class uniformDimensionedVectorField; object g; }}\ndimensions [acceleration];\nvalue {foam_vector(gravity)};\n", encoding="utf-8")
    write_fields(case, velocities["inlet"], velocities["plug"])


def write_fields(case: Path, inlet: tuple[float, float, float], plug: tuple[float, float, float]) -> None:
    zero = case / "0"
    zero.mkdir(exist_ok=True)
    (zero / "alpha.liquid").write_text("""FoamFile { format ascii; class volScalarField; object alpha.liquid; }
dimensions []; internalField uniform 0;
boundaryField { inlet { type fixedValue; value uniform 1; } vent { type inletOutlet; inletValue uniform 0; value uniform 0; } walls { type zeroGradient; } plugSurface { type zeroGradient; } }
""", encoding="utf-8")
    (zero / "p_rgh").write_text("""FoamFile { format ascii; class volScalarField; object p_rgh; }
dimensions [pressure]; internalField uniform 0;
boundaryField { inlet { type fixedFluxPressure; value uniform 0; } vent { type prghTotalPressure; p0 uniform 0; value uniform 0; } walls { type fixedFluxPressure; value uniform 0; } plugSurface { type fixedFluxPressure; value uniform 0; } }
""", encoding="utf-8")
    (zero / "U").write_text(f"""FoamFile {{ format ascii; class volVectorField; object U; }}
dimensions [velocity]; internalField uniform (0 0 0);
boundaryField {{ inlet {{ type fixedValue; value uniform {foam_vector(inlet)}; }} vent {{ type pressureInletOutletVelocity; value uniform (0 0 0); }} walls {{ type noSlip; }} plugSurface {{ type fixedValue; value uniform {foam_vector(plug)}; }} }}
""", encoding="utf-8")


def set_boundary_velocity(path: Path, inlet: tuple[float, float, float], plug: tuple[float, float, float]) -> None:
    text = path.read_text(encoding="utf-8", errors="strict")
    replacements = {
        "inlet": f"inlet {{ type fixedValue; value uniform {foam_vector(inlet)}; }}",
        "plugSurface": f"plugSurface {{ type fixedValue; value uniform {foam_vector(plug)}; }}",
    }
    for patch, replacement in replacements.items():
        text, count = re.subn(rf"\b{patch}\s*\{{[^{{}}]*\}}", replacement, text, count=1, flags=re.S)
        if count != 1:
            raise RuntimeError(f"cannot update {patch} boundary in {path}")
    path.write_text(text, encoding="utf-8")


def write_control(case: Path, end_time: float, start_from: str, rho: float, centre: tuple[float, float, float]) -> None:
    (case / "system" / "controlDict").write_text(f"""FoamFile {{ format ascii; class dictionary; object controlDict; }}
solver incompressibleVoF; startFrom {start_from}; startTime 0; stopAt endTime; endTime {end_time:.12g}; deltaT 1e-5;
writeControl adjustableRunTime; writeInterval {max(end_time / 20, 1e-5):.12g}; purgeWrite 0; writeFormat ascii; writePrecision 10; writeCompression off; timeFormat general; timePrecision 8; runTimeModifiable false; adjustTimeStep yes; maxCo 0.35; maxAlphaCo 0.35; maxDeltaT {max(end_time / 200, 1e-5):.12g};
functions
{{
  liquidVolume {{ type volFieldValue; libs ("libfieldFunctionObjects.so"); writeControl timeStep; writeInterval 1; log false; writeFields false; cellZone all; operation volIntegrate; fields (alpha.liquid); }}
  pressureMax {{ type volFieldValue; libs ("libfieldFunctionObjects.so"); writeControl timeStep; writeInterval 1; log false; writeFields false; cellZone all; operation max; fields (p_rgh); }}
  plugForces {{ type forces; libs ("libforces.so"); writeControl timeStep; writeInterval 1; patches (plugSurface); p p_rgh; U U; rho rhoInf; rhoInf {rho:.12g}; CofR {foam_vector(centre)}; }}
}}
""", encoding="utf-8")


def latest_time(case: Path) -> tuple[float, Path]:
    values: list[tuple[float, Path]] = []
    for path in case.iterdir():
        try:
            values.append((float(path.name), path))
        except ValueError:
            pass
    if not values:
        raise RuntimeError("OpenFOAM produced no time directory")
    return max(values)


def render_phase(case: Path, output: Path) -> None:
    _, time_dir = latest_time(case)
    values = scalar_field(time_dir / "alpha.liquid")
    plt.figure(figsize=(8, 4.5))
    plt.plot(np.linspace(0, 1, values.size), np.sort(values), color="#1769aa")
    plt.ylim(-0.02, 1.02)
    plt.xlabel("normalized cell rank")
    plt.ylabel("liquid volume fraction")
    plt.title("Post-relaxation phase distribution")
    plt.tight_layout()
    plt.savefig(output, dpi=160)
    plt.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mesh", choices=sorted(MESH_CELLS), required=True)
    parser.add_argument("--robustness", choices=sorted(ROBUSTNESS_SCALE), required=True)
    args = parser.parse_args()
    materials = json.loads((args.inputs / "materials.json").read_text(encoding="utf-8"))
    mapping = json.loads((args.inputs / "surface-mapping.json").read_text(encoding="utf-8"))
    if materials.get("schema") != 1 or mapping.get("schema") != 1:
        raise ValueError("materials and surface mapping must use schema 1")
    shape = import_step(args.inputs / "domain.step")
    faces = list(shape.faces())
    used: set[int] = set()
    args.output.mkdir(parents=True, exist_ok=True)
    case = args.output / "case"
    if case.exists():
        shutil.rmtree(case)
    shutil.copytree(Path(__file__).parent / "openfoam-case", case)
    tri = case / "constant" / "triSurface"
    tri.mkdir(parents=True, exist_ok=True)
    inlet_area = 0.0
    for patch in PATCHES:
        raw_indices = mapping["patches"][patch].get("faceIndices")
        if not isinstance(raw_indices, list) or not raw_indices:
            raise ValueError(f"patches.{patch}.faceIndices must be non-empty")
        indices = [int(index) for index in raw_indices]
        if any(index < 1 or index > len(faces) or index in used for index in indices):
            raise ValueError(f"patches.{patch}.faceIndices are out of range or overlap")
        used.update(indices)
        selected = [faces[index - 1] for index in indices]
        export_stl(Compound(children=selected), tri / f"{patch}.stl", tolerance=0.02, angular_tolerance=0.1)
        if patch == "inlet":
            inlet_area = sum(float(face.area) for face in selected)
    if used != set(range(1, len(faces) + 1)):
        raise ValueError("surface mapping must assign every flow-domain face exactly once")
    unit_scale = {"mm": 0.001, "m": 1.0}.get(mapping.get("lengthUnit"))
    if unit_scale is None:
        raise ValueError("surface-mapping.lengthUnit must be mm or m")
    for path in tri.glob("*.stl"):
        scaled = path.with_suffix(".scaled.stl")
        subprocess.run(["surfaceTransformPoints", f"scale={foam_vector((unit_scale,) * 3)}", str(path), str(scaled)], check=True)
        scaled.replace(path)
    bbox = shape.bounding_box()
    bounds = (
        tuple(float(value) * unit_scale for value in (bbox.min.X, bbox.min.Y, bbox.min.Z)),
        tuple(float(value) * unit_scale for value in (bbox.max.X, bbox.max.Y, bbox.max.Z)),
    )
    inside = tuple(value * unit_scale for value in vector(mapping["insidePoint"], "insidePoint"))
    factor = ROBUSTNESS_SCALE[args.robustness]
    plug = materials["plugEquivalent"]
    inlet_velocity = tuple(value * factor for value in vector(materials["injectionVelocity"], "injectionVelocity"))
    plug_velocity = tuple(value * factor for value in vector(plug["pulseVelocity"], "plugEquivalent.pulseVelocity"))
    durations = {
        "injection": finite(materials["injectionDuration"], "injectionDuration", positive=True),
        "pulse": finite(plug["pulseDuration"], "plugEquivalent.pulseDuration", positive=True),
        "relaxation": finite(plug["relaxationDuration"], "plugEquivalent.relaxationDuration", positive=True),
    }
    centre = tuple((a + b) / 2 for a, b in zip(*bounds))
    write_case_files(case, bounds=bounds, inside=inside, cells=MESH_CELLS[args.mesh], materials=materials, velocities={"inlet": inlet_velocity, "plug": (0.0, 0.0, 0.0)})
    write_control(case, durations["injection"], "startTime", finite(materials["liquid"]["rho"], "liquid.rho", positive=True), centre)
    run(case, "blockMesh")
    run(case, "snappyHexMesh", "-overwrite")
    run(case, "checkMesh", "-allGeometry", "-allTopology")
    elapsed = 0.0
    stage_records = []
    for stage, duration, inlet, plug_motion in (
        ("stage-i-injection", durations["injection"], inlet_velocity, (0.0, 0.0, 0.0)),
        ("stage-ii-plug-pulse", durations["pulse"], (0.0, 0.0, 0.0), plug_velocity),
        ("stage-ii-relaxation", durations["relaxation"], (0.0, 0.0, 0.0), (0.0, 0.0, 0.0)),
    ):
        elapsed += duration
        _, current = latest_time(case)
        set_boundary_velocity(current / "U", inlet, plug_motion)
        write_control(case, elapsed, "latestTime", finite(materials["liquid"]["rho"], "liquid.rho", positive=True), centre)
        run(case, "foamRun")
        stage_records.append({"id": stage, "endTime": elapsed})
    volume_rows = data_rows(case, "liquidVolume")
    pressure_rows = data_rows(case, "pressureMax")
    force_rows = data_rows(case, "plugForces")
    initial_volume = volume_rows[0][-1]
    final_volume = volume_rows[-1][-1]
    expected = inlet_area * unit_scale**2 * float(np.linalg.norm(inlet_velocity)) * durations["injection"]
    domain_volume = float(shape.volume) * unit_scale**3
    pulse_displacement = float(np.linalg.norm(plug_velocity)) * durations["pulse"]
    target_displacement = finite(plug["targetDisplacement"], "plugEquivalent.targetDisplacement")
    force_vectors = [row[1:4] for row in force_rows if len(row) >= 4]
    metrics = {
        "schema": 1,
        "mesh": args.mesh,
        "robustness": args.robustness,
        "postPlugTrappedGas": max(0.0, domain_volume - final_volume),
        "peakPressure": max(abs(row[-1]) for row in pressure_rows),
        "peakForce": max(float(np.linalg.norm(row)) for row in force_vectors),
        "poseError": abs(pulse_displacement - target_displacement),
        "massError": abs((final_volume - initial_volume) - expected) / max(abs(expected), 1e-18),
        "stages": stage_records,
    }
    (args.output / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    (args.output / "pressure-history.json").write_text(json.dumps({"x": [row[0] for row in pressure_rows], "y": [row[-1] for row in pressure_rows]}), encoding="utf-8")
    render_phase(case, args.output / "phase-distribution.png")


if __name__ == "__main__":
    main()
