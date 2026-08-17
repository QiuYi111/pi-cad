import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { presentationCommand } from "../../shared/capability.ts";

export default function cadPresentationExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_render_scene",
    label: "CAD Render Scene",
    description:
      "Validate, generate, or run a spec-driven product presentation scene. Generate always writes the deterministic scene script; run returns explicit unavailable when Blender/FFmpeg are missing. The tool does not judge aesthetic quality.",
    promptSnippet: "Validate/generate/run a spec-driven presentation scene",
    promptGuidelines: [
      "Write visual-spec.json with artifact, at least two reference-backed directions, materials, lighting, and camera.",
      "A technically correct default render is not release-quality presentation.",
      "script-generated and unavailable are honest evidence states.",
    ],
    parameters: Type.Object({
      stage: Type.Enum({ validate: "validate", generate: "generate", run: "run" }),
      spec: Type.String(),
      outputDir: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const envelope = await presentationCommand(ctx.cwd, params.stage, params.spec, params.outputDir);
      const payload = envelope.payload as { status?: string; reason?: string; outputs?: string[]; error?: string };
      const text = envelope.ok
        ? `cad_render_scene stage=${params.stage} status=${payload.status ?? "ok"}${payload.reason ? `\nreason=${payload.reason}` : ""}\noutputs=${JSON.stringify(payload.outputs ?? [])}`
        : `cad_render_scene failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.spec,
          kind: "presentation" as const,
        },
      };
    },
  });
}
