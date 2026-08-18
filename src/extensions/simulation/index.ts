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

const RegionSchema = Type.Union([
  Type.Object({
    axis: Type.Enum({ x: "x", y: "y", z: "z" }),
    side: Type.Enum({ min: "min", max: "max" }),
  }),
  Type.Object({
    indices: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
  }),
], { description: "Either axis+side (extreme face along an axis) or explicit node indices" });

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
  pi.registerTool({
    name: "cad_simulate",
    label: "CAD Simulate",
    description:
      "Run a linear elastic finite element simulation with torch-fem. Pass the simulation directly: artifact or mesh.box, one homogeneous material, loads, constraints, mesh size. The tool canonicalizes the spec into run-scoped evidence storage itself; it returns deterministic fields and provenance only; it never says safe, good, or passes.",
    promptSnippet: "Run deterministic torch-fem linear elasticity on a STEP artifact",
    promptGuidelines: [
      "Supply material constants, loads, constraints, and mesh explicitly; unknown physics is rejected.",
      "Treat simulation evidence as version-bound; current candidate changes stale previous simulation.",
      "Never claim safety from a stress plot; interpret the raw fields yourself.",
    ],
    parameters: Type.Object({
      artifact: Type.Optional(Type.String({ description: "STEP/STP artifact to simulate; required unless mesh.box is supplied" })),
      units: Type.Optional(Type.Literal("mm_N_MPa")),
      backend: Type.Optional(Type.Literal("torch-fem")),
      device: Type.Optional(Type.Enum({ auto: "auto", cpu: "cpu", cuda: "cuda", mps: "mps" })),
      physics: Type.Object({ type: Type.Literal("linear_elasticity") }),
      materials: Type.Array(
        Type.Object({
          name: Type.Optional(Type.String()),
          E: Type.Number(),
          nu: Type.Number(),
          density: Type.Optional(Type.Number()),
        }),
        { minItems: 1, maxItems: 1 },
      ),
      mesh: Type.Object({
        element: Type.Optional(Type.Literal("tet")),
        size: Type.Number({ exclusiveMinimum: 0 }),
        box: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number()])),
      }),
      constraints: Type.Array(
        Type.Object({
          type: Type.Literal("fixed"),
          region: RegionSchema,
          dofs: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 2 }), { minItems: 1 })),
        }),
        { minItems: 1 },
      ),
      loads: Type.Array(
        Type.Object({
          type: Type.Literal("nodal_force"),
          region: RegionSchema,
          vector: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
          distribute: Type.Optional(Type.Enum({ total: "total", per_node: "per_node" })),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.artifact && !params.mesh.box) {
        throw new Error("cad_simulate requires artifact or mesh.box");
      }
      if (params.artifact && !existsSync(resolve(ctx.cwd, params.artifact))) {
        throw new Error(`simulation artifact does not exist: ${params.artifact}`);
      }
      const spec = {
        ...params,
        units: params.units ?? "mm_N_MPa",
        backend: params.backend ?? "torch-fem",
        device: params.device ?? "auto",
      };
      const { specPath, outputDir } = await writeRunSpec(ctx.cwd, "simulation", spec);
      const envelope = await simulationCommand(ctx.cwd, "run", specPath, outputDir);
      let artifactHash = envelope.inputHashes.spec;
      if (params.artifact) {
        try {
          artifactHash = await sha256File(resolve(ctx.cwd, params.artifact));
        } catch {
          // Keep spec hash as provenance fallback.
        }
      }
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
    parameters: Type.Object({
      mode: Type.Optional(Type.Literal("topology_2d_rect_v0")),
      designDomain: Type.Object({
        x: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
        y: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
        nx: Type.Optional(Type.Integer({ minimum: 2 })),
        ny: Type.Optional(Type.Integer({ minimum: 2 })),
      }),
      material: Type.Object({ E: Type.Number(), nu: Type.Number() }),
      objective: Type.Object({ type: Type.Literal("compliance"), sense: Type.Literal("minimize") }),
      constraints: Type.Array(
        Type.Object({ type: Type.Literal("volume_fraction"), max: Type.Number({ exclusiveMinimum: 0, maximum: 1 }) }),
        { minItems: 1, maxItems: 1 },
      ),
      optimizer: Type.Object({
        type: Type.Literal("mma"),
        maxIterations: Type.Integer({ minimum: 1 }),
        penalty: Type.Optional(Type.Number({ exclusiveMinimum: 1 })),
        Emin: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      }),
    }),
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
          kind: "optimization" as const,
        },
      };
    },
  });
}
