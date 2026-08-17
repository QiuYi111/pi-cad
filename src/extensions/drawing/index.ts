import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { drawingCommand } from "../../shared/capability.ts";

export default function cadDrawingExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_generate_drawing",
    label: "CAD Generate Drawing",
    description:
      "Validate or generate a spec-driven manufacturing drawing (DXF + SVG in the V0 backend). The tool executes the spec; it does not decide whether dimensions/tolerances are complete. PDF and standards-compliant GD&T symbols are explicitly unavailable in this backend.",
    promptSnippet: "Validate or generate a spec-driven drawing",
    promptGuidelines: [
      "Write drawing-spec.json first with artifact, views, dimensions, tolerances, feature_refs, and inspection method.",
      "A projection without complete manufacturing definition is not a release drawing.",
      "Treat generated files as execution evidence, not automatic drawing completeness.",
    ],
    parameters: Type.Object({
      stage: Type.Enum({ validate: "validate", generate: "generate" }),
      spec: Type.String({ description: "Path to drawing spec JSON" }),
      outputDir: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const outputDir = params.outputDir ?? ".pi-cad/release/drawing";
      const envelope = await drawingCommand(ctx.cwd, params.stage, params.spec, outputDir);
      const payload = envelope.payload as { status?: string; error?: string; warnings?: string[]; outputs?: string[] };
      const text = envelope.ok
        ? `cad_generate_drawing stage=${params.stage} status=${payload.status ?? "ok"}\noutputs=${JSON.stringify(payload.outputs ?? [])}\nwarnings=${JSON.stringify(payload.warnings ?? [])}`
        : `cad_generate_drawing failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.spec,
          kind: "drawing" as const,
        },
      };
    },
  });
}
