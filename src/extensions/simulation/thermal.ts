import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import { AnalysisModelSchema, verifyAnalysisModel } from "./analysis-model.ts";
import { runSimulationLifecycle, simulateAdapter } from "../../modules/simulate/index.ts";

const SurfaceRef = Type.Array(Type.String({
  description: "Surface ID from cad_inspect_surfaces for this artifact version",
}), { minItems: 1 });

function shortThermalText(envelope: any): string {
  const p = envelope.payload ?? {};
  if (!envelope.ok) return `cad_simulate_thermal failed: ${p.error ?? p.reason ?? "unknown error"}`;
  if (p.status === "unavailable") {
    return `cad_simulate_thermal unavailable: ${p.reason ?? "SU2 backend unavailable"}`;
  }
  if (p.status === "failed") {
    return `cad_simulate_thermal failed: ${p.reason ?? "solver error"}`;
  }
  if (p.status === "not_converged") {
    return [
      `cad_simulate_thermal DID NOT CONVERGE (case ${p.caseId}): ${p.reason ?? "residual target not met"}`,
      `iterations=${p.convergence?.iterations} worstResidualLog10=${p.convergence?.worstResidualLog10} target=${p.convergence?.residualTargetLog10}`,
      "Raw fields are returned for inspection only; this run creates NO simulation evidence and cannot close a required case.",
      `resultArtifact=${p.artifact ?? ""}`,
    ].join("\n");
  }
  const lines = [
    `cad_simulate_thermal solved with ${p.backend} ${p.backendVersion} (case ${p.caseId})`,
    `mesh=${p.mesh?.nodeCount ?? "?"} nodes / ${p.mesh?.elementCount ?? "?"} tets (${p.mesh?.geometryUnits ?? "?"} geometry)`,
    `converged=${p.convergence?.reached} iterations=${p.convergence?.iterations} worstResidualLog10=${p.convergence?.worstResidualLog10}`,
    `temperature: ${p.temperature?.minK}..${p.temperature?.maxK} K (mean ${p.temperature?.meanK})`,
  ];
  for (const [marker, stats] of Object.entries(p.boundaries ?? {})) {
    const s = stats as Record<string, number>;
    lines.push(`  ${marker}: reconstructedHeatRate=${s.reconstructedHeatRateW} W over ${s.areaM2} m^2`);
  }
  lines.push(`energyBalance(reconstructed): net=${p.energyBalance?.netReconstructedHeatRateW} W largest=${p.energyBalance?.largestReconstructedHeatRateW} W imbalance=${p.energyBalance?.relativeReconstructedImbalance}`);
  lines.push(`resultArtifact=${p.artifact ?? ""}`);
  lines.push(`views=${(p.visualization?.views ?? []).length}`);
  lines.push("Solver output is evidence, not judgment; thermal safety and acceptance are your decisions.");
  return lines.join("\n");
}

export default function cadThermalExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_simulate_thermal",
    label: "CAD Simulate Thermal",
    description:
      "Run deterministic steady solid heat-conduction analysis with SU2 on a STEP solid. Thermal boundaries reference surface IDs from cad_inspect_surfaces. Returns temperature/heat-flux fields, balances, views, and provenance; it never infers material properties, thermal boundary conditions, safety, or acceptance.",
    promptSnippet: "Run deterministic SU2 steady solid heat conduction",
    promptGuidelines: [
      "CAD geometry is interpreted per geometryUnits (mm default); thermal quantities are SI (K, W/m^2, W/(m*K)).",
      "Supply material conductivity explicitly; the tool never assumes a material.",
      "At least one fixed-temperature boundary is required; unclassified surfaces are adiabatic.",
      "Declare convergence.residualTarget: a run that does not declare and meet its residual standard returns raw fields but creates NO evidence (status=not_converged).",
      "Check convergence and energy balance before interpreting temperatures or heat rates.",
    ],
    parameters: Type.Object(
      {
        caseId: Type.String({ description: "Case identity that binds this run to the declared evidence obligation" }),
        artifact: Type.String({ description: "STEP solid to analyze" }),
        analysisModel: Type.Optional(
          Type.Unsafe({ ...(AnalysisModelSchema as object), description: "Declare when the analyzed solid is a derived model: evidence binds to the authoritative source, never to a fused copy" }),
        ),
        geometryUnits: Type.Optional(Type.Enum({ mm: "mm", m: "m" }, { description: "How STEP coordinates should be interpreted (default mm)" })),
        material: Type.Object(
          { conductivityWPerMK: Type.Number({ exclusiveMinimum: 0 }) },
          { additionalProperties: false },
        ),
        boundaries: Type.Array(
          Type.Union(
            [
              Type.Object(
                {
                  type: Type.Literal("temperature"),
                  surfaces: SurfaceRef,
                  temperatureK: Type.Number({ exclusiveMinimum: 0 }),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  type: Type.Literal("heat_flux"),
                  surfaces: SurfaceRef,
                  heatFluxWPerM2: Type.Number(),
                },
                { additionalProperties: false },
              ),
            ],
            { description: "At least one temperature boundary; surfaces left unclassified are adiabatic" },
          ),
          { minItems: 1 },
        ),
        mesh: Type.Object(
          {
            maxSizeMm: Type.Number({ exclusiveMinimum: 0 }),
            minSizeMm: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          },
          { additionalProperties: false },
        ),
        convergence: Type.Optional(
          Type.Object(
            {
              maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
              residualTarget: Type.Optional(Type.Number()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      // Unknown keys fail closed at the tool boundary.
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!existsSync(resolve(ctx.cwd, params.artifact))) {
        throw new Error(`artifact does not exist: ${params.artifact}`);
      }
      if (params.analysisModel && !existsSync(resolve(ctx.cwd, params.analysisModel.derivationRef))) {
        throw new Error(`analysisModel.derivationRef does not exist: ${params.analysisModel.derivationRef}`);
      }
      // Fail closed when the analyzed solid is a derived model with no
      // declared provenance; the evidence then binds to the source design.
      const analysisCheck = await verifyAnalysisModel(ctx.cwd, {
        subject: params.artifact,
        analysisModel: params.analysisModel,
      });
      if (analysisCheck.error) throw new Error(analysisCheck.error);
      const spec = { ...params, geometryUnits: params.geometryUnits ?? "mm" };
      // Phase 6: shared lifecycle (freeze → execute → observe).
      const lifecycle = await runSimulationLifecycle({
        cwd: ctx.cwd,
        adapter: simulateAdapter("thermal"),
        spec: spec as Record<string, unknown>,
        subject: {
          artifactPath: params.artifact,
          subjectOverrideHash: analysisCheck.subjectOverrideHash ?? null,
        },
        caseId: params.caseId,
      });
      const envelope = lifecycle.envelope;
      return {
        content: [{ type: "text", text: shortThermalText(envelope) }, ...lifecycle.images],
        details: {
          envelope,
          artifactHash: lifecycle.artifactHash,
          specHash: lifecycle.specHash,
          caseId: params.caseId,
          kind: "simulation" as const,
        },
      };
    },
  });
}
