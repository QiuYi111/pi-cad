import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import {
  optimizationCommand,
  readImageContents,
  simulationCommand,
} from "../../shared/capability.ts";
import { writeRunSpec } from "../../shared/run-spec.ts";
import { sha256File } from "../../shared/store.ts";
import { AnalysisModelSchema, DeriveAnalysisModelSchema, verifyAnalysisModel } from "./analysis-model.ts";
import { deriveAnalysisModel } from "../../shared/capability.ts";

import cadFlowExtension from "./flow.ts";
import cadThermalExtension from "./thermal.ts";

const RegionSchema = Type.Union(
  [
    Type.Object(
      {
        axis: Type.Enum({ x: "x", y: "y", z: "z" }),
        side: Type.Enum({ min: "min", max: "max" }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        indices: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "axis+side selects the axis-extreme node slab (all nodes within 0.75x mesh size of the "
      + "bounding-box extreme along that axis) — a simple V1 boundary selector, NOT arbitrary "
      + "CAD face selection; indices selects explicit mesh node indices",
  },
);

function shortSimulationText(envelope: any): string {
  const p = envelope.payload ?? {};
  if (!envelope.ok) return `cad_simulate failed: ${p.error ?? p.reason ?? "unknown error"}`;
  if (p.status === "unavailable") {
    return `cad_simulate unavailable: ${p.reason ?? "simulation backend unavailable"}`;
  }
  return [
    `cad_simulate solved with ${p.backend}`,
    `device=${p.actualDevice} dtype=${p.dtype} fallback=${p.fallbackReason ?? "none"}`,
    `mesh=${p.mesh?.nodeCount ?? "?"} nodes / ${p.mesh?.elementCount ?? "?"} elements`,
    `maxDisplacement=${p.displacement?.maxMagnitude}`,
    `maxVonMises(element)=${p.stress?.maxVonMisesElement}`,
    `resultArtifact=${p.artifact ?? ""}`,
    `views=${(p.visualization?.views ?? []).length}`,
  ].join("\n");
}

export default function cadSimulationExtension(pi: ExtensionAPI) {
  cadFlowExtension(pi);
  cadThermalExtension(pi);

  pi.registerTool({
    name: "cad_simulate",
    label: "CAD Simulate",
    description:
      "Run a linear elastic finite element simulation with torch-fem. Pass the simulation directly: artifact or mesh.box, one homogeneous material, loads, constraints, mesh size. Boundary regions are V1 simple axis-extreme node slabs or explicit node indices, not arbitrary CAD face selection. The tool canonicalizes the spec into run-scoped evidence storage itself; it returns deterministic fields and provenance only; it never says safe, good, or passes.",
    promptSnippet: "Run deterministic torch-fem linear elasticity on a STEP artifact",
    promptGuidelines: [
      "Supply material constants, loads, constraints, and mesh explicitly; unknown physics is rejected.",
      "Treat simulation evidence as version-bound; current candidate changes stale previous simulation.",
      "Never claim safety from a stress plot; interpret the raw fields yourself.",
    ],
    parameters: Type.Object(
      {
        artifact: Type.Optional(Type.String({ description: "STEP/STP artifact to simulate; required unless mesh.box is supplied (exactly one of the two)" })),
        analysisModel: Type.Optional(
          Type.Unsafe({ ...(AnalysisModelSchema as object), description: "Declare when the artifact is a derived model (e.g. a fused assembly for solid FEA): evidence binds to the authoritative source" }),
        ),
        units: Type.Optional(Type.Literal("mm_N_MPa")),
        backend: Type.Optional(Type.Literal("torch-fem")),
        device: Type.Optional(Type.Enum({ auto: "auto", cpu: "cpu", cuda: "cuda", mps: "mps" })),
        physics: Type.Object({ type: Type.Literal("linear_elasticity") }, { additionalProperties: false }),
        materials: Type.Array(
          Type.Object(
            {
              name: Type.Optional(Type.String()),
              E: Type.Number(),
              nu: Type.Number(),
              density: Type.Optional(Type.Number()),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 1 },
        ),
        mesh: Type.Object(
          {
            element: Type.Optional(Type.Literal("tet")),
            size: Type.Number({ exclusiveMinimum: 0 }),
            box: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number()])),
          },
          { additionalProperties: false },
        ),
        constraints: Type.Array(
          Type.Object(
            {
              type: Type.Literal("fixed"),
              region: RegionSchema,
              dofs: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 2 }), { minItems: 1 })),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
        loads: Type.Array(
          Type.Object(
            {
              type: Type.Literal("nodal_force"),
              region: RegionSchema,
              vector: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
              distribute: Type.Optional(Type.Enum({ total: "total", per_node: "per_node" })),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      },
      // Unknown keys (e.g. a "distribut" typo falling back to the
      // distribute default) must fail closed at the tool boundary, matching
      // the backend's fail-closed philosophy.
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.artifact && !params.mesh.box) {
        throw new Error("cad_simulate requires artifact or mesh.box");
      }
      if (params.artifact && params.mesh.box) {
        throw new Error("cad_simulate accepts artifact or mesh.box, not both; the ignored one would silently change the mesh source");
      }
      if (params.artifact && !existsSync(resolve(ctx.cwd, params.artifact))) {
        throw new Error(`simulation artifact does not exist: ${params.artifact}`);
      }
      // The canonical design is never fused for solver convenience: a
      // derived subject must carry a harness-owned derivation record, and
      // the evidence then binds to the authoritative source.
      const analysisCheck = params.artifact
        ? await verifyAnalysisModel(ctx.cwd, {
            subject: params.artifact,
            analysisModel: params.analysisModel,
          })
        : null;
      if (analysisCheck?.error) throw new Error(analysisCheck.error);
      const spec = {
        ...params,
        units: params.units ?? "mm_N_MPa",
        backend: params.backend ?? "torch-fem",
        device: params.device ?? "auto",
      };
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "simulation", spec);
      const envelope = await simulationCommand(ctx.cwd, "run", specPath, outputDir);
      // inputHashes.artifact is hashed by cadctl BEFORE the solve; binding
      // evidence to it makes the provenance immune to concurrent artifact
      // mutation. Re-hashing here would only be a weaker post-solve check.
      let artifactHash = analysisCheck?.subjectOverrideHash ?? null;
      if (!artifactHash && params.artifact) {
        if (envelope.inputHashes.artifact) {
          artifactHash = envelope.inputHashes.artifact;
        } else {
          try {
            artifactHash = await sha256File(resolve(ctx.cwd, params.artifact));
          } catch {
            // Keep spec hash as provenance fallback.
          }
        }
      }
      if (!artifactHash) artifactHash = envelope.inputHashes.spec;
      const images =
        envelope.ok && (envelope.payload as any)?.status === "solved"
          ? await readImageContents(
              ((envelope.payload as any)?.visualization?.views ?? []).map(
                (view: { path: string }) => view.path,
              ),
            )
          : [];
      return {
        content: [{ type: "text", text: shortSimulationText(envelope) }, ...images],
        details: {
          envelope,
          artifactHash,
          specHash: envelope.inputHashes.spec,
          kind: "simulation" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_derive_analysis_model",
    label: "CAD Derive Analysis Model",
    description:
      "Create a harness-owned analysis-model derivation from the authoritative design. fused/bonded are EXECUTED by the harness (boolean union, output written by the harness — mechanically verified); simplified/defeatured/sectioned record your authored model with both ends hashed. Simulations declare the resulting record via analysisModel.derivationRef.",
    promptSnippet: "Derive a verified analysis model from the canonical design",
    promptGuidelines: [
      "Use fused/bonded when a solver needs the assembly as one solid: the harness performs the union, so the derivation cannot be an unrelated model in disguise.",
      "Use simplified/defeatured/sectioned for your own authored reduction; the record honestly labels it authored.",
      "Never hand-edit the derivation record; create a fresh one when either end changes.",
    ],
    parameters: DeriveAnalysisModelSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!existsSync(resolve(ctx.cwd, params.source))) {
        throw new Error(`derivation source does not exist: ${params.source}`);
      }
      if (params.output && !existsSync(resolve(ctx.cwd, params.output))) {
        const mechanical = params.operations.every((op) => op === "fused" || op === "bonded");
        if (!mechanical) {
          throw new Error(`authored derivations require an existing output: ${params.output}`);
        }
      }
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "derivation", params);
      const envelope = await deriveAnalysisModel(ctx.cwd, specPath, outputDir, 3_600_000);
      const payload = envelope.payload as {
        error?: string;
        recordPath?: string;
        sourceHash?: string;
        outputHash?: string;
        executed?: boolean;
      };
      const text = envelope.ok
        ? `cad_derive_analysis_model: derivation record ${payload.recordPath} (${payload.executed ? "harness-executed" : "authored"}). Simulations declare analysisModel {derivationRef: "${payload.recordPath}"}.`
        : `cad_derive_analysis_model failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          kind: "build" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_optimize",
    label: "CAD Optimize",
    description:
      "Run the V0 differentiable 2D rectangular topology optimization walking skeleton: SIMP density + torch-fem autograd + NLopt MMA. The optimizer never calls the LLM and the result is density/surface data only; it does not update Project Head.",
    promptSnippet: "Run deterministic differentiable topology optimization (SIMP + MMA)",
    promptGuidelines: [
      "This V0 capability is a 2D rectangular topology walking skeleton; only use when that problem shape is appropriate.",
      "Optimization output is not CAD: interpret it, then reconstruct/modify build123d CAD and cad_commit_candidate.",
      "Accepted CAD after optimization must be simulated again before acceptance.",
    ],
    parameters: Type.Object(
      {
        mode: Type.Optional(Type.Literal("topology_2d_rect_v0")),
        designDomain: Type.Object(
          {
            x: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
            y: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
            nx: Type.Optional(Type.Integer({ minimum: 2 })),
            ny: Type.Optional(Type.Integer({ minimum: 2 })),
          },
          { additionalProperties: false },
        ),
        material: Type.Object({ E: Type.Number(), nu: Type.Number() }, { additionalProperties: false }),
        objective: Type.Object(
          { type: Type.Literal("compliance"), sense: Type.Literal("minimize") },
          { additionalProperties: false },
        ),
        constraints: Type.Array(
          Type.Object(
            { type: Type.Literal("volume_fraction"), max: Type.Number({ exclusiveMinimum: 0, maximum: 1 }) },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 1 },
        ),
        optimizer: Type.Object(
          {
            type: Type.Literal("mma"),
            maxIterations: Type.Integer({ minimum: 1 }),
            penalty: Type.Optional(Type.Number({ exclusiveMinimum: 1 })),
            Emin: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spec = { ...params, mode: params.mode ?? "topology_2d_rect_v0" };
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "optimization", spec);
      const envelope = await optimizationCommand(ctx.cwd, specPath, outputDir);
      const p = envelope.payload as {
        bestObjective?: number;
        finalVolumeFraction?: number;
        iterations?: number;
        artifact?: string;
        error?: string;
        reason?: string;
      };
      const text = envelope.ok
        ? `cad_optimize completed: iterations=${p.iterations ?? "?"} bestObjective=${p.bestObjective ?? "?"} finalVolumeFraction=${p.finalVolumeFraction ?? "?"}\nThis is density/surface evidence, not a CAD candidate.`
        : `cad_optimize failed: ${p.error ?? p.reason ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.spec,
          specHash: envelope.inputHashes.spec,
          kind: "optimization" as const,
        },
      };
    },
  });
}
