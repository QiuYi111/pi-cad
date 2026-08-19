import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import { readImageContents, thermalCommand } from "../../shared/capability.ts";
import { writeRunSpec } from "../../shared/run-spec.ts";
import { sha256File } from "../../shared/store.ts";

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
  const lines = [
    `cad_simulate_thermal solved with ${p.backend} ${p.backendVersion} (case ${p.caseId})`,
    `mesh=${p.mesh?.nodeCount ?? "?"} nodes / ${p.mesh?.elementCount ?? "?"} tets (${p.mesh?.geometryUnits ?? "?"} geometry)`,
    `converged=${p.convergence?.reached} iterations=${p.convergence?.iterations} worstResidualLog10=${p.convergence?.worstResidualLog10}`,
    `temperature: ${p.temperature?.minK}..${p.temperature?.maxK} K (mean ${p.temperature?.meanK})`,
  ];
  for (const [marker, stats] of Object.entries(p.boundaries ?? {})) {
    const s = stats as Record<string, number>;
    lines.push(`  ${marker}: heatRate=${s.heatRateW} W over ${s.areaM2} m^2`);
  }
  lines.push(`energyBalance: net=${p.energyBalance?.netHeatRateW} W largest=${p.energyBalance?.largestBoundaryHeatRateW} W imbalance=${p.energyBalance?.relativeImbalance}`);
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
      "Check convergence and energy balance before interpreting temperatures or heat rates.",
    ],
    parameters: Type.Object(
      {
        caseId: Type.String({ description: "Case identity that binds this run to the declared evidence obligation" }),
        artifact: Type.String({ description: "STEP solid to analyze" }),
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
      const spec = { ...params, geometryUnits: params.geometryUnits ?? "mm" };
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "thermal", spec);
      const envelope = await thermalCommand(ctx.cwd, "run", specPath, outputDir, 3_600_000);
      let artifactHash = envelope.inputHashes.spec;
      if (envelope.inputHashes.artifact) {
        artifactHash = envelope.inputHashes.artifact;
      } else {
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
        content: [{ type: "text", text: shortThermalText(envelope) }, ...images],
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
