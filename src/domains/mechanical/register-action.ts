import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TOOL_PURPOSES } from "../../core/agent-contract.ts";
import { ACTIVE_PUBLIC_TOOLS, type ActivePublicTool, type PublicToolGroup } from "../../shared/public-tools.ts";
import { mechanicalRegistries } from "./registries.ts";
import { canonicalJson } from "../../harness/canonical.ts";

export { mechanicalRegistries } from "./registries.ts";

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0] & { name: ActivePublicTool; parameters?: unknown };

function groupOf(name: ActivePublicTool): PublicToolGroup {
  for (const [group, tools] of Object.entries(ACTIVE_PUBLIC_TOOLS) as Array<[PublicToolGroup, readonly ActivePublicTool[]]>) {
    if (tools.includes(name)) return group;
  }
  throw new Error(`unknown Mechanical action: ${name}`);
}

function mutationOf(group: PublicToolGroup, name: ActivePublicTool): string {
  if (group === "probe") return "observation-only";
  if (group === "control") return name === "cad_wait_for_user" ? "state-pause" : "transactional-state";
  if (group === "model") return "declared-artifact";
  if (group === "simulation" || group === "optimization") return "managed-recipe-run";
  return "declared-deliverable";
}

/** Pin the live tool's actual schema without depending on a Pi session. */
export function captureMechanicalAction(tool: ToolDefinition): void {
  if (tool.name === "cad_start") {
    const pinned = mechanicalRegistries.actions.require("cad_start").contract.schema as { input?: unknown };
    if (canonicalJson(pinned.input) !== canonicalJson((tool as { parameters?: unknown }).parameters ?? { type: "object", additionalProperties: false })) throw new Error("cad_start live schema differs from its Kernel registration");
    return;
  }
  const group = groupOf(tool.name);
  mechanicalRegistries.actions.registerIdempotent({
    id: tool.name,
    contract: {
      version: "1.0.0",
      schema: {
        input: (tool as { parameters?: unknown }).parameters ?? { type: "object", additionalProperties: false },
        output: { protocol: "pi-tool-result-v1", failClosed: true },
      } as never,
      semantics: {
        owner: "mechanical-pack",
        group,
        mutation: mutationOf(group, tool.name),
        meaning: TOOL_PURPOSES[tool.name],
      } as never,
    },
  });
}

/** Register the live Pi tool and pin its actual input schema in the Action Registry. */
export function registerMechanicalActionTool(pi: ExtensionAPI, tool: ToolDefinition): void {
  captureMechanicalAction(tool);
  pi.registerTool(tool);
}

/** Register a Kernel-owned public action whose pinned contract is installed by the Kernel registry bootstrap. */
export function registerKernelActionTool(pi: ExtensionAPI, tool: ToolDefinition): void {
  if (tool.name !== "cad_start") throw new Error(`not a Kernel-owned public action: ${tool.name}`);
  pi.registerTool(tool);
}
