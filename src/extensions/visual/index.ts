import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";

import {
  currentVisualEvidenceDir,
  DEFAULT_VIEWS,
  hashOrEmpty,
  inspectVisual,
  readImageContents,
  visualPayload,
} from "../../shared/capability.ts";

const VIEW_NAMES = DEFAULT_VIEWS;

export default function cadVisualExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_inspect_visual",
    label: "CAD Inspect Visual",
    description:
      "Render fixed orthographic views of a STEP artifact and return the images plus camera facts. The tool never names features or judges the design; you interpret the images.",
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
      const views = params.views?.length ? params.views : VIEW_NAMES;
      const outDir = await currentVisualEvidenceDir(ctx.cwd, params.artifact);
      const envelope = await inspectVisual(ctx.cwd, params.artifact, outDir, {
        views,
        width: params.width ?? 640,
        height: params.height ?? 480,
        display: params.display ?? "solid",
        labels: params.labels ?? true,
      });
      const payload = visualPayload(envelope);
      if (!envelope.ok || !payload.views?.length) {
        return {
          content: [
            {
              type: "text",
              text: `cad_inspect_visual failed: ${payload.error ?? "no views returned"}`,
            },
          ],
          details: { envelope },
        };
      }

      const images = await readImageContents(payload.views.map((view) => view.path));
      const text = [
        "cad_inspect_visual succeeded.",
        `artifact: ${params.artifact}`,
        `bbox: ${JSON.stringify(payload.bbox)} mm`,
        `views: ${payload.views.map((view) => view.name).join(", ")}`,
        "Inspect every image yourself. The tool has not named any feature.",
      ].join("\n");
      return {
        content: [{ type: "text", text }, ...images],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact ?? (await hashOrEmpty(resolve(ctx.cwd, params.artifact))),
          kind: "visual" as const,
        },
      };
    },
  });
}
