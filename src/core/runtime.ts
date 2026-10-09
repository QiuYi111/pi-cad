import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { assertLinuxRuntime } from "../shared/platform.ts";
import { assertNoLegacyRun } from "../harness/legacy-run.ts";
import { PermissionEngineV7, assertScopedWrite } from "../harness/permissions.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../harness/run-store.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { mechanicalContextCompiler } from "../domains/mechanical/context-providers.ts";
import { PI_CAD_OWNED_TOOLS } from "../domains/mechanical/owned-tools.ts";
import { abortMechanicalRunV7, resumeMechanicalRunV7 } from "../domains/mechanical/control-actions-v7.ts";
import { approveMechanicalRerouteV7 } from "../domains/mechanical/actions-v7.ts";
import { maybeRebuildContextV7, registerContextCompaction, renderV7WorkingContext } from "./context-memory.ts";
import { registerControlTools } from "./controller.ts";

const V7_WRITE_RULES = [
  { scope: "project:source", roots: ["models", "src", "design"] },
  { scope: "project:recipe", roots: ["recipes", "simulation"] },
  { scope: "project:deliverable", roots: ["build", "drawings", "presentation", "exports"] },
] as const;

function applyV7ToolOverlay(pi: ExtensionAPI, enabled: readonly string[]): void {
  const available = new Set((pi.getAllTools?.() ?? []).map((tool) => tool.name));
  const current = pi.getActiveTools?.() ?? [];
  const foreign = current.filter((name) => !PI_CAD_OWNED_TOOLS.has(name));
  const owned = enabled.filter((name) => available.has(name));
  pi.setActiveTools?.([...new Set([...foreign, ...owned])]);
}

/**
 * Pi-CAD v7 extension entry. Every hook first passes the engine guard, which
 * refuses projects that still carry an unfinished legacy run.
 */
export default function cadCore(pi: ExtensionAPI) {
  assertLinuxRuntime("Pi-CAD extension");

  pi.registerCommand("cad", {
    description: "Show the Pi-CAD workspace: project, design head, and active run",
    handler: async (args, ctx) => {
      await assertNoLegacyRun(ctx.cwd);
      const project = new HarnessProjectStoreV7(ctx.cwd);
      const [{ state }, run] = await Promise.all([project.load(), project.currentRun(mechanicalRegistries)]);
      if (ctx.hasUI) {
        const artifacts = Object.values(state.head.artifacts);
        ctx.ui.notify([
          "Pi-CAD workspace (Kernel v7)",
          `project=${state.projectId}`,
          artifacts.length ? `head=${artifacts.map((item) => `${item.path}@${item.sha256.slice(0, 12)}`).join(",")}` : "head=none",
          run ? `activeRun=${run.state.runId} workflow=${run.workflow.id} phase=${run.state.phase}` : "activeRun=none (IDLE)",
        ].join(" · "), "info");
      }
      if (args.trim()) pi.sendUserMessage(args, { expandPromptTemplates: false });
    },
  });

  pi.registerCommand("cad-abort", {
    description: "Abort the active workflow run only; project head is untouched",
    handler: async (_args, ctx) => {
      await assertNoLegacyRun(ctx.cwd);
      const state = await abortMechanicalRunV7(ctx.cwd);
      if (state && ctx.hasUI) ctx.ui.notify(`Run ${state.runId} aborted; v7 Project Head unchanged`, "warning");
    },
  });

  // Explicit user-side reroute authority. An ordinary user reply proves
  // only that the user spoke; approving a downgrade is a separate, visible
  // action. The issued token is bound to the exact pending route and is
  // consumed by the next cad_reroute for that route only.
  pi.registerCommand("cad-approve-reroute", {
    description: "Approve the pending Pi-CAD reroute (issues a one-time authority token for that exact route)",
    handler: async (_args, ctx) => {
      await assertNoLegacyRun(ctx.cwd);
      try {
        const loaded = await approveMechanicalRerouteV7(ctx.cwd);
        if (ctx.hasUI) ctx.ui.notify(`Exact v7 reroute authority issued for run ${loaded.state.runId}`, "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  registerControlTools(pi);
  registerContextCompaction(pi);

  // Resolve an interactive wait as a bounded input transaction. Prompt
  // projection remains read-only and never repairs/migrates state.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    await assertNoLegacyRun(ctx.cwd);
    await resumeMechanicalRunV7(ctx.cwd);
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await assertNoLegacyRun(ctx.cwd);
    const project = new HarnessProjectStoreV7(ctx.cwd);
    const loaded = await project.currentRun(mechanicalRegistries);
    if (!loaded || ["done", "aborted"].includes(loaded.state.status)) {
      applyV7ToolOverlay(pi, ["cad_start", "cad_route"]);
      return { systemPrompt: `${event.systemPrompt}\n\n## Pi-CAD Harness Kernel v7\nNo active run. Call cad_route for the default Mechanical intake, or cad_start for the project-selected generic workflow.` };
    }
    const permissions = new PermissionEngineV7(mechanicalRegistries, loaded.registryContract);
    applyV7ToolOverlay(pi, permissions.enabledActions(loaded.state, loaded.workflow));
    const phase = loaded.workflow.phases[loaded.state.phase]!;
    const compiled = await mechanicalContextCompiler(mechanicalRegistries).compile({
      project: project.transactions,
      run: new HarnessRunStoreV7(ctx.cwd, loaded.state.runId).transactions,
      providerIds: phase.contextProviders,
      allowedIndexes: new Set(["obligations", "observations", "runtime-availability"]),
      aggregateReadBudget: 1024 * 1024,
      aggregateEmitBudget: 96 * 1024,
    });
    const working = await renderV7WorkingContext(ctx.cwd, loaded.state.runId);
    return { systemPrompt: `${event.systemPrompt}\n\n## Pi-CAD Harness Kernel v7\nworkflow=${loaded.workflow.id}@${loaded.workflow.version} hash=${loaded.workflow.hash}\nregistryContract=${loaded.registryContract.hash}\n\n${compiled.text}${working ? `\n\n${working}` : ""}` };
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      await assertNoLegacyRun(ctx.cwd);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    const loaded = await new HarnessProjectStoreV7(ctx.cwd).currentRun(mechanicalRegistries);
    if (!loaded) {
      if (PI_CAD_OWNED_TOOLS.has(event.toolName) && !["cad_start", "cad_route"].includes(event.toolName)) return { block: true, reason: "Pi-CAD v7 has no active run; call cad_route or cad_start first" };
      return undefined;
    }
    const permissions = new PermissionEngineV7(mechanicalRegistries, loaded.registryContract);
    if (PI_CAD_OWNED_TOOLS.has(event.toolName)) {
      try { permissions.assertAction(loaded.state, loaded.workflow, event.toolName); }
      catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = (event.input as { path?: string }).path;
      if (path) {
        try {
          assertScopedWrite({ cwd: ctx.cwd, target: path, enabledScopes: loaded.workflow.phases[loaded.state.phase]!.writeScopes, rules: V7_WRITE_RULES.map((rule) => ({ scope: rule.scope, roots: [...rule.roots] })) });
        } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
      }
    }
    return undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await assertNoLegacyRun(ctx.cwd);
    const loaded = await new HarnessProjectStoreV7(ctx.cwd).currentRun(mechanicalRegistries);
    if (loaded && loaded.state.status === "active") maybeRebuildContextV7(pi, loaded, ctx);
  });
}
