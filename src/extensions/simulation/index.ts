import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { simulationCommand } from "../../shared/capability.ts";

export default function cadSimulationExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_run_simulation",
    label: "CAD Run Simulation",
    description:
      "Validate or run a spec-driven static structural simulation. The tool returns explicit unavailable status when the gmsh/pyvista/CalculiX backend is not installed; it never invents a substitute solver or upgrades unavailable into completed evidence.",
    promptSnippet: "Validate or run a spec-driven simulation",
    promptGuidelines: [
      "Write analysis-spec.json with artifact, solver, analysis, materials, loads, constraints, mesh, and acceptance metrics.",
      "A contour plot without model-form, convergence, and correlation evidence is not substantiation.",
      "unavailable is an honest evidence state, not a failure to be hidden.",
    ],
    parameters: Type.Object({
      stage: Type.Enum({ validate: "validate", run: "run" }),
      spec: Type.String(),
      outputDir: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const envelope = await simulationCommand(ctx.cwd, params.stage, params.spec, params.outputDir);
      const payload = envelope.payload as { status?: string; reason?: string; error?: string };
      const text = envelope.ok
        ? `cad_run_simulation stage=${params.stage} status=${payload.status ?? "ok"}${payload.reason ? `\nreason=${payload.reason}` : ""}`
        : `cad_run_simulation failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.spec,
          kind: "simulation" as const,
        },
      };
    },
  });
}
