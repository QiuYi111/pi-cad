import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import { flowCommand, readImageContents } from "../../shared/capability.ts";
import { writeRunSpec } from "../../shared/run-spec.ts";
import { sha256File } from "../../shared/store.ts";

const SurfaceRef = Type.Array(Type.String({
  description: "Surface ID from cad_inspect_surfaces for this artifact version",
}), { minItems: 1 });

const FlowDirection = Type.Tuple([Type.Number(), Type.Number(), Type.Number()], {
  description: "Inlet flow direction (non-zero 3-vector; normalized internally)",
});

const ViscositySchema = Type.Union(
  [
    Type.Object(
      {
        model: Type.Literal("constant"),
        muPas: Type.Number({ exclusiveMinimum: 0, description: "Dynamic viscosity (Pa*s)" }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        model: Type.Literal("sutherland"),
        muRefPas: Type.Number({ exclusiveMinimum: 0 }),
        temperatureRefK: Type.Number({ exclusiveMinimum: 0 }),
        sutherlandConstantK: Type.Number({ exclusiveMinimum: 0 }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Explicit viscosity model. Nothing is defaulted to air: Sutherland runs must declare their own constants.",
  },
);

function shortFlowText(envelope: any): string {
  const p = envelope.payload ?? {};
  if (!envelope.ok) return `cad_simulate_flow failed: ${p.error ?? p.reason ?? "unknown error"}`;
  if (p.status === "unavailable") {
    return `cad_simulate_flow unavailable: ${p.reason ?? "SU2 backend unavailable"}`;
  }
  if (p.status === "failed") {
    return `cad_simulate_flow failed: ${p.reason ?? "solver error"}`;
  }
  if (p.status === "not_converged") {
    return [
      `cad_simulate_flow DID NOT CONVERGE (case ${p.caseId}): ${p.reason ?? "residual target not met"}`,
      `iterations=${p.convergence?.iterations} worstResidualLog10=${p.convergence?.worstResidualLog10} target=${p.convergence?.residualTargetLog10}`,
      "Raw fields are returned for inspection only; this run creates NO simulation evidence and cannot close a required case.",
      `resultArtifact=${p.artifact ?? ""}`,
    ].join("\n");
  }
  const lines = [
    `cad_simulate_flow solved with ${p.backend} ${p.backendVersion} (case ${p.caseId})`,
    `mesh=${p.mesh?.nodeCount ?? "?"} nodes / ${p.mesh?.elementCount ?? "?"} tets (${p.mesh?.geometryUnits ?? "?"} geometry)`,
    `converged=${p.convergence?.reached} iterations=${p.convergence?.iterations} worstResidualLog10=${p.convergence?.worstResidualLog10}`,
    `massBalance: in=${p.massBalance?.inletKgPerS} kg/s out=${p.massBalance?.outletKgPerS} kg/s imbalance=${p.massBalance?.relativeImbalance}`,
  ];
  for (const [marker, stats] of Object.entries(p.boundaries ?? {})) {
    const s = stats as Record<string, number>;
    if (s.areaWeightedMean_Mach !== undefined) {
      lines.push(
        `  ${marker}: Mach_aw=${s.areaWeightedMean_Mach} P_aw=${s.areaWeightedMean_Pressure} T_aw=${s.areaWeightedMean_Temperature} mdot=${s.massFlowKgPerS ?? "?"}`,
      );
    }
  }
  lines.push(`resultArtifact=${p.artifact ?? ""}`);
  lines.push(`views=${(p.visualization?.views ?? []).length}`);
  lines.push("Solver output is evidence, not judgment; interpret Mach/pressure/temperature yourself.");
  return lines.join("\n");
}

export default function cadFlowExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_simulate_flow",
    label: "CAD Simulate Flow",
    description:
      "Run deterministic steady single-zone CFD with SU2 on an explicit watertight fluid-domain STEP. Boundary conditions reference surface IDs from cad_inspect_surfaces. V1 supports compressible Euler/RANS and incompressible Navier-Stokes/RANS. Returns convergence, conservation balances, raw flow fields, derived quantities, views, and provenance; it never decides whether the design passes or infers missing operating conditions.",
    promptSnippet: "Run deterministic SU2 steady CFD on an explicit fluid domain",
    promptGuidelines: [
      "CAD geometry is interpreted per geometryUnits (mm default); every physical quantity is SI with the unit in its name.",
      "Build an explicit fluid-domain STEP and classify every boundary surface exactly once (inlet, outlet, walls).",
      "Declare fluid.viscosity explicitly for RANS/NS runs; the interpreter never assumes air properties. Omit it for Euler.",
      "Do not invent operating conditions; missing inlet/outlet states stay explicit unknowns or blocked_external.",
      "Declare convergence.residualTarget: a run that does not declare and meet its residual standard returns raw fields but creates NO evidence (status=not_converged).",
      "Check convergence and mass balance before interpreting any Mach or pressure value.",
      "Treat results as evidence, not judgment: overclaiming nozzle results to full-engine behavior is your error, not the tool's.",
    ],
    parameters: Type.Object(
      {
        caseId: Type.String({ description: "Case identity that binds this run to the declared evidence obligation" }),
        fluidDomain: Type.String({ description: "Watertight fluid-volume STEP to mesh and solve" }),
        artifact: Type.Optional(Type.String({ description: "Solid/part STEP for provenance context (pre-hashed and re-verified)" })),
        geometryUnits: Type.Optional(Type.Enum({ mm: "mm", m: "m" }, { description: "How STEP coordinates should be interpreted (default mm)" })),
        physics: Type.Object(
          {
            type: Type.Enum({
              compressible_euler: "compressible_euler",
              compressible_rans: "compressible_rans",
              incompressible_ns: "incompressible_ns",
              incompressible_rans: "incompressible_rans",
            }),
            turbulence: Type.Optional(Type.Enum({ sa: "sa", sst: "sst" })),
          },
          { additionalProperties: false },
        ),
        fluid: Type.Union(
          [
            Type.Object(
              {
                model: Type.Literal("ideal_gas"),
                gamma: Type.Number({ exclusiveMinimum: 1, maximum: 2 }),
                gasConstantJPerKgK: Type.Number({ exclusiveMinimum: 0 }),
                // Optional at the schema level: Euler omits it, RANS/NS must
                // declare it. The cross-field rule is enforced fail-closed by
                // the backend rather than a giant union here.
                viscosity: Type.Optional(ViscositySchema),
              },
              { additionalProperties: false },
            ),
            Type.Object(
              {
                model: Type.Literal("constant_density"),
                densityKgPerM3: Type.Number({ exclusiveMinimum: 0 }),
                viscosity: Type.Optional(ViscositySchema),
              },
              { additionalProperties: false },
            ),
          ],
          {
            description:
              "Compressible runs need ideal_gas; incompressible runs need constant_density. " +
              "Viscous solvers (RANS/NS) require an explicit viscosity contract; Euler must omit it.",
          },
        ),
        boundaries: Type.Array(
          Type.Union(
            [
              Type.Object(
                {
                  type: Type.Literal("total_conditions_inlet"),
                  surfaces: SurfaceRef,
                  totalPressurePa: Type.Number({ exclusiveMinimum: 0 }),
                  totalTemperatureK: Type.Number({ exclusiveMinimum: 0 }),
                  flowDirection: FlowDirection,
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  type: Type.Literal("velocity_inlet"),
                  surfaces: SurfaceRef,
                  velocityMPerS: Type.Number({ exclusiveMinimum: 0 }),
                  temperatureK: Type.Number({ exclusiveMinimum: 0 }),
                  flowDirection: FlowDirection,
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  type: Type.Literal("pressure_outlet"),
                  surfaces: SurfaceRef,
                  staticPressurePa: Type.Number({ description: "Static back pressure (Pa; gauge for incompressible)" }),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  type: Type.Literal("wall"),
                  surfaces: SurfaceRef,
                  thermal: Type.Optional(
                    Type.Union([
                      Type.Literal("adiabatic"),
                      Type.Object({ heatFluxWPerM2: Type.Number() }, { additionalProperties: false }),
                    ]),
                  ),
                },
                { additionalProperties: false },
              ),
            ],
            { description: "Every fluid-domain boundary surface must be classified exactly once" },
          ),
          { minItems: 1 },
        ),
        initial: Type.Object(
          {
            mach: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
            temperatureK: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
            pressurePa: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
            velocityMPerS: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          },
          {
            additionalProperties: false,
            description: "Freestream state used to start the steady solve (compressible needs mach+temperatureK+pressurePa; incompressible needs velocityMPerS)",
          },
        ),
        turbulenceInlet: Type.Optional(
          Type.Object(
            {
              intensity: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
              viscosityRatio: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
            },
            {
              additionalProperties: false,
              description: "RANS inlet turbulence state; defaults intensity=0.05, viscosityRatio=10 and the used values are reported in the result",
            },
          ),
        ),
        mesh: Type.Object(
          {
            maxSizeMm: Type.Number({ exclusiveMinimum: 0 }),
            minSizeMm: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          },
          { additionalProperties: false },
        ),
        convergence: Type.Object(
          {
            maxIterations: Type.Integer({ minimum: 1 }),
            residualTarget: Type.Optional(Type.Number({ description: "Log10 RMS residual target, e.g. -6" })),
          },
          { additionalProperties: false },
        ),
      },
      // Unknown keys fail closed at the tool boundary.
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!existsSync(resolve(ctx.cwd, params.fluidDomain))) {
        throw new Error(`fluidDomain does not exist: ${params.fluidDomain}`);
      }
      if (params.artifact && !existsSync(resolve(ctx.cwd, params.artifact))) {
        throw new Error(`artifact does not exist: ${params.artifact}`);
      }
      const spec = { ...params, geometryUnits: params.geometryUnits ?? "mm" };
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "flow", spec);
      const envelope = await flowCommand(ctx.cwd, "run", specPath, outputDir, 3_600_000);
      // Evidence identity follows the PART artifact when one is declared
      // (that is what the harness tracks as the current candidate); the
      // fluid-domain hash stays bound in the envelope's inputHashes either
      // way. Both are re-hashed by the backend after the solve.
      let artifactHash = envelope.inputHashes.spec;
      if (envelope.inputHashes.artifact) {
        artifactHash = envelope.inputHashes.artifact;
      } else if (envelope.inputHashes.fluidDomain) {
        artifactHash = envelope.inputHashes.fluidDomain;
      } else if (params.artifact) {
        try {
          artifactHash = await sha256File(resolve(ctx.cwd, params.artifact));
        } catch {
          // Keep spec hash as provenance fallback.
        }
      }
      const images =
        envelope.ok && (envelope.payload as any)?.status === "solved"
          ? await readImageContents(
              ((envelope.payload as any)?.visualization?.views ?? []).map((view: { path: string }) => view.path),
            )
          : [];
      return {
        content: [{ type: "text", text: shortFlowText(envelope) }, ...images],
        details: {
          envelope,
          artifactHash,
          specHash: envelope.inputHashes.spec,
          caseId: params.caseId,
          kind: "simulation" as const,
        },
      };
    },
  });
}
