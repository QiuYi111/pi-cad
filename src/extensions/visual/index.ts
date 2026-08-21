import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DEFAULT_VIEWS } from "../../shared/capability.ts";
import { ensureProbePresets, probePreset, renderProbeResult } from "../../modules/probe/index.ts";

const VIEW_NAMES = DEFAULT_VIEWS;

export default function cadVisualExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_inspect_visual",
    label: "CAD Inspect Visual",
    description:
      "[Deprecated wrapper — call cad_probe with preset=visual instead; retires after the Phase 3 benchmark gate.] Render fixed orthographic views of a STEP artifact and return the images plus camera facts. The tool never names features or judges the design; you interpret the images.",
    promptSnippet: "Render current STEP artifact views (iso/front/back/left/right/top/bottom)",
    promptGuidelines: [
      "Inspect the returned images yourself before making geometric claims.",
      "Prefer the views attached by cad_commit_candidate; call this tool again for targeted looks at the current artifact.",
    ],
    parameters: Type.Object({
      artifact: Type.String({ description: "Path to the STEP artifact, relative to the project root" }),
      views: Type.Optional(
        Type.Array(Type.Enum({
          iso: "iso",
          front: "front",
          back: "back",
          left: "left",
          right: "right",
          top: "top",
          bottom: "bottom",
        })),
      ),
      display: Type.Optional(Type.Enum({ solid: "solid" })),
      labels: Type.Optional(Type.Boolean({ description: "Draw the view name on the image" })),
      width: Type.Optional(Type.Integer({ minimum: 160, maximum: 1600, default: 640 })),
      height: Type.Optional(Type.Integer({ minimum: 120, maximum: 1200, default: 480 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Phase 2: thin wrapper over the probe registry.
      ensureProbePresets();
      const preset = probePreset("visual");
      if (!preset) {
        return {
          content: [{ type: "text", text: "cad_inspect_visual failed: preset visual not registered" }],
        };
      }
      const result = await preset.run(
        {
          artifact: params.artifact,
          views: params.views?.length ? params.views : [...VIEW_NAMES],
          width: params.width ?? 640,
          height: params.height ?? 480,
          labels: params.labels ?? true,
          display: params.display ?? "solid",
        },
        { cwd: ctx.cwd },
      );
      return renderProbeResult(result, "cad_inspect_visual");
    },
  });
}
