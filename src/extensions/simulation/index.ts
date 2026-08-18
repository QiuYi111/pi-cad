import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";

import {
  optimizationCommand,
  simulationCommand,
} from "../../shared/capability.ts";
import { sha256File } from "../../shared/store.ts";

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
  ].join("\n");
}

export default function cadSimulationExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_simulate",
    label: "CAD Simulate",
    description:
      "Run a spec-driven linear elastic finite element simulation with torch-fem. Input is a simulation spec JSON with artifact/mesh, materials, loads, constraints. The tool returns deterministic fields and provenance only; it never says safe, good, or passes.",
    promptSnippet: "Run deterministic torch-fem linear elasticity on a STEP artifact",
    promptGuidelines: [
      "Write the spec JSON first. Material constants and BCs must be sourced.",
      "Treat simulation evidence as version-bound; current candidate changes stale previous simulation.",
      "Never claim safety from a stress plot; interpret the raw fields yourself.",
    ],
    parameters: Type.Object({
      spec: Type.String({ description: "Path to simulation spec JSON" }),
      outputDir: Type.String({ description: "Run-scoped output directory" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const specPath = resolve(ctx.cwd, params.spec);
      const envelope = await simulationCommand(ctx.cwd, "run", params.spec, params.outputDir);
      let artifactHash = envelope.inputHashes.spec;
      try {
        const spec = JSON.parse(await readFile(specPath, "utf-8"));
        if (spec.artifact) artifactHash = await sha256File(resolve(ctx.cwd, spec.artifact));
      } catch {
        // Keep spec hash as provenance fallback.
      }
      return {
        content: [{ type: "text", text: shortSimulationText(envelope) }],
        details: { envelope, artifactHash, kind: "simulation" as const },
      };
    },
  });

  pi.registerTool({
    name: "cad_optimize",
    label: "CAD Optimize",
    description:
      "Run a differentiable topology optimization over a fixed FE-native density field using the NLopt MMA inner loop. The optimizer never calls the LLM and the result is density/surface data only; it does not update Project Head.",
    promptSnippet: "Run deterministic differentiable topology optimization (SIMP + MMA)",
    promptGuidelines: [
      "Only use when a continuous, mesh-native design variable is appropriate.",
      "Optimization output is not CAD: interpret it, then reconstruct/modify build123d CAD and cad_commit_candidate.",
      "Accepted CAD after optimization must be simulated again before acceptance.",
    ],
    parameters: Type.Object({
      spec: Type.String({ description: "Path to optimization spec JSON" }),
      outputDir: Type.String({ description: "Run-scoped output directory" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const envelope = await optimizationCommand(ctx.cwd, params.spec, params.outputDir);
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
