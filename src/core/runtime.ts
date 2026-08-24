import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import {
  CAPABILITY_TOOLS,
  type CadRunState,
  routeKey,
  type EvidenceRef,
} from "../shared/protocol.ts";
import { randomBytes } from "node:crypto";
import { CadProjectStore, migrateProjectOnce, nowIso } from "../shared/store.ts";
import { runBaselineAuto, runCandidateAuto, runConvertCandidateAuto, type PersistFn } from "./auto-actions.ts";
import { recordObservation } from "./observation-index.ts";
import { composeSystemPrompt } from "./context.ts";
import { maybeRebuildContext, registerContextCompaction, renderTaskContext } from "./context-memory.ts";
import { maybeAutoContinue } from "./continuation.ts";
import { registerControlTools, type ControllerDeps } from "./controller.ts";
import { EVIDENCE_KINDS, recordToolEvidence } from "./evidence.ts";
import { applyCadToolOverlay, PI_CAD_OWNED_TOOLS, toolsForState, writePathAllowed } from "./policies.ts";
import { resumeFromUser } from "./state-machine.ts";
import { isHeadless, isTerminalStatus } from "./interaction-mode.ts";
import { readRuntimeAvailability, simulationRuntimeProjection } from "../modules/simulate-v2/runtime.ts";
import { assertLinuxRuntime } from "../shared/platform.ts";
import { selectKernelEngine } from "../harness/engine-router.ts";
import { PermissionEngineV7 } from "../harness/permissions.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../harness/run-store.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { mechanicalContextCompiler } from "../domains/mechanical/context-providers.ts";
import { abortMechanicalRunV7, resumeMechanicalRunV7 } from "../domains/mechanical/control-actions-v7.ts";
import { approveMechanicalRerouteV7 } from "../domains/mechanical/actions-v7.ts";
import { authorizeMechanicalToolV7 } from "../domains/mechanical/tool-policy-v7.ts";
import { registerPiCadNestedToolBridge } from "../integrations/codex-conversion.ts";

function applyV7ToolOverlay(pi: ExtensionAPI, enabled: readonly string[]): void {
  const available = new Set((pi.getAllTools?.() ?? []).map((tool) => tool.name));
  const current = pi.getActiveTools?.() ?? [];
  const foreign = current.filter((name) => !PI_CAD_OWNED_TOOLS.has(name));
  const owned = enabled.filter((name) => available.has(name));
  pi.setActiveTools?.([...new Set([...foreign, ...owned])]);
}

const OPTIONAL_TOOL_NAMES = [
  "cad_generate_drawing",
  "cad_simulate",
  "cad_sim_observe",
  "cad_commit_simulation",
  "cad_optimize",
  "cad_render_scene",
] as const;

async function persist(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadRunState,
  events: Array<{ type: string; data?: unknown }>,
): Promise<void> {
  await store.save(state);
  for (const event of events) {
    await store.appendEvent(event.type, event.data);
  }
  // Overlay, not replace: Pi-CAD only owns its own cad_* tools and must not
  // uninstall other plugins' active tools (Goal, Ralph, ...).
  applyCadToolOverlay(pi, state);
  pi.events.emit("pi-cad:state-changed", state);
  try {
    pi.appendEntry<CadRunState>("pi-cad-run-state", state);
  } catch {
    // Canonical state remains .pi-cad/project.json + .pi-cad/runs/<runId>/.
  }
}

async function guardState(store: CadProjectStore): Promise<CadRunState | null> {
  const state = await store.load();
  if (!state || isTerminalStatus(state.status)) return null;
  return state;
}

function envelopeOk(
  envelope: Parameters<typeof recordToolEvidence>[1] | undefined,
): boolean {
  return Boolean(envelope && envelope.ok);
}

function customToolDetails(event: ToolResultEvent) {
  if (!("details" in event)) return undefined;
  return event.details as
    | {
        envelope?: {
          ok?: boolean;
          payload?: { status?: string; caseId?: string };
          inputHashes?: Record<string, string>;
          artifacts?: Array<{ path: string }>;
          tool?: string;
        };
        kind?: string;
        artifactHash?: string;
        specHash?: string;
        caseId?: string;
        observationStored?: boolean;
        observation?: {
          ok?: boolean;
          tool?: string;
          headline?: string;
          facts?: Array<{ key: string; value: string }>;
          visuals?: Array<{ name: string; path: string }>;
          diagnostics?: Array<{ level: "info" | "warning" | "error"; message: string }>;
          provenance?: {
            tool: string;
            toolVersion?: string;
            backendVersion?: string;
            durationMs: number;
            inputHashes: Record<string, string>;
            outputHashes: Record<string, string>;
          };
          artifacts?: Array<{ path: string; kind: string; sha256: string; role?: string }>;
        };
      }
    | undefined;
}

async function handleToolResult(
  pi: ExtensionAPI,
  store: CadProjectStore,
  event: ToolResultEvent,
): Promise<void> {
  const state = await guardState(store);
  if (!state) return;
  const info = customToolDetails(event);
  // Phase 8: every observation bundle the agent saw enters the per-run
  // observation index. Tools that persist their own full raw payload mark the
  // result so this generic hook does not create a duplicate summary snapshot.
  if (info?.observation && !info.observationStored) {
    await recordObservation({
      cwd: store.cwd,
      runId: state.runId,
      phase: state.phase,
      tool: event.toolName,
      bundle: {
        ok: info.observation.ok ?? true,
        tool: info.observation.tool ?? "unknown",
        headline: info.observation.headline ?? "",
        facts: info.observation.facts ?? [],
        visuals: info.observation.visuals ?? [],
        diagnostics: info.observation.diagnostics ?? [],
        provenance: info.observation.provenance ?? {
          tool: info.observation.tool ?? "unknown",
          durationMs: 0,
          inputHashes: {},
          outputHashes: {},
        },
        artifacts: info.observation.artifacts ?? [],
      },
      ...(info.artifactHash ? { artifactHash: info.artifactHash } : {}),
      ...(info.kind ? { evidenceKind: info.kind } : {}),
    });
  }
  if (!info?.envelope || !info.kind) return;
  const kind = info.kind as EvidenceRef["kind"];
  if (!EVIDENCE_KINDS.includes(kind)) return;
  if (!envelopeOk(info.envelope)) return;
  // Simulation V2 is explicit-commit only. A successful solver or observer
  // tool result must never be promoted by the generic tool-result hook.
  if (kind === "simulation") return;
  if (kind === "optimization" && (info.envelope.artifacts?.length ?? 0) === 0) return;
  const artifactHash =
    info.artifactHash ??
    info.envelope.inputHashes?.artifact ??
    info.envelope.inputHashes?.after;
  if (!artifactHash) return;
  const specHash =
    info.specHash ??
    (kind === "optimization" ? info.envelope.inputHashes?.spec : undefined);
  const caseId =
    info.caseId ??
    undefined;
  const envelope = info.envelope as Parameters<typeof recordToolEvidence>[1];
  const next = recordToolEvidence(state, envelope, kind, artifactHash, specHash, caseId);
  await persist(pi, store, next, [
    {
      type: "EvidenceCreated",
      data: {
        kind,
        artifactHash,
        ...(specHash ? { specHash } : {}),
        ...(caseId ? { caseId } : {}),
        paths: envelope.artifacts?.map((artifact) => artifact.path) ?? [],
      },
    },
  ]);
}

async function unavailableCapabilities(pi: ExtensionAPI): Promise<string[]> {
  const available = new Set((pi.getAllTools?.() ?? []).map((tool) => tool.name));
  const missing = [...CAPABILITY_TOOLS].filter((name) => !available.has(name));
  return missing.filter((name) =>
    (OPTIONAL_TOOL_NAMES as readonly string[]).includes(name),
  );
}

async function simulationCapabilityContext(cwd: string, enabled: boolean): Promise<string> {
  if (!enabled) return "";
  const configured = await simulationRuntimeProjection().catch(() => []);
  const visible = configured.filter((entry) =>
    !entry.developmentOnly || process.env.PI_CAD_ENABLE_DEV_RUNTIMES === "1",
  );
  if (visible.length === 0) return "## Configured managed runtimes\n- none configured";
  const availability = new Map<string, Awaited<ReturnType<typeof readRuntimeAvailability>>>();
  await Promise.all(visible.map(async (entry) => {
    const value = await readRuntimeAvailability(cwd, entry.backend, entry.runtime).catch(() => null);
    availability.set(`${entry.backend}/${entry.runtime}`, value);
  }));
  return [
    "## Configured managed runtimes",
    "Availability is qualified only when the corresponding tool is executed; unknown never means ready.",
    ...visible.map((entry) => {
      const cached = availability.get(`${entry.backend}/${entry.runtime}`);
      return [
      `- backend=${entry.backend} runtime=${entry.runtime} kind=${entry.kind} availability=${cached ? "ready" : "unknown"}`,
      `  executable=${entry.agentCapabilities.executables.join(",") || "none"}; pythonModules=${entry.agentCapabilities.pythonModules.join(",") || "none"}`,
      `  python=${entry.agentCapabilities.pythonCommand}; sandbox=${entry.agentCapabilities.sandbox}; network=${entry.agentCapabilities.network}`,
      `  accelerator=requested:${entry.agentCapabilities.accelerator}${cached?.identity.accelerator?.actualDevice ? `,actual:${String(cached.identity.accelerator.actualDevice)}` : ""}; limits=${entry.limits.cpu}CPU/${entry.limits.memoryGiB}GiB/${entry.limits.wallHours}h; template=${entry.agentCapabilities.cookbookTemplateId}`,
    ].join("\n");
    }),
  ].join("\n");
}

export default function cadCore(pi: ExtensionAPI) {
  const codexBridge = registerPiCadNestedToolBridge(pi);
  assertLinuxRuntime("Pi-CAD extension");
  const deps: ControllerDeps = {
    pi,
    persist,
    runBaselineAuto,
    runCandidateAuto,
    runConvertCandidateAuto,
  };

  pi.registerCommand("cad", {
    description: "Show the Pi-CAD workspace: project, design head, and active run",
    handler: async (args, ctx) => {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
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
        return;
      }
      const store = new CadProjectStore(ctx.cwd);
      await migrateProjectOnce(store);
      const project = await store.ensureProject();
      const run = await store.load();
      if (ctx.hasUI) {
        const lines = [
          "Pi-CAD workspace",
          `project=${project.projectId}`,
          project.head.artifactPath
            ? `head=${project.head.artifactPath} @ ${project.head.artifactHash?.slice(0, 12)}`
            : "head=none",
          run
            ? `activeRun=${run.runId} route=${run.route ? routeKey(run.route) : "intake"} phase=${run.phase}`
            : "activeRun=none (IDLE)",
        ];
        ctx.ui.notify(lines.join(" · "), run ? "info" : "info");
      }
      if (args.trim()) pi.sendUserMessage(args, { expandPromptTemplates: false });
    },
  });

  pi.registerCommand("cad-abort", {
    description: "Abort the active workflow run only; project head is untouched",
    handler: async (_args, ctx) => {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
        const state = await abortMechanicalRunV7(ctx.cwd);
        if (state && ctx.hasUI) ctx.ui.notify(`Run ${state.runId} aborted; v7 Project Head unchanged`, "warning");
        return;
      }
      const store = new CadProjectStore(ctx.cwd);
      const state = await store.load();
      if (!state) return;
      const next: CadRunState = {
        ...state,
        status: "aborted",
        updatedAt: nowIso(),
      };
      await persist(pi, store, next, [
        { type: "Aborted", data: { runId: state.runId } },
      ]);
      await store.setCurrentRun(null);
      if (ctx.hasUI) ctx.ui.notify(`Run ${state.runId} aborted; project head unchanged`, "warning");
    },
  });

  // Explicit user-side reroute authority. An ordinary user reply proves
  // only that the user spoke; approving a downgrade is a separate, visible
  // action. The issued token is bound to the exact pending route and is
  // consumed by the next cad_reroute for that route only.
  pi.registerCommand("cad-approve-reroute", {
    description: "Approve the pending Pi-CAD reroute (issues a one-time authority token for that exact route)",
    handler: async (_args, ctx) => {
      if (await selectKernelEngine(ctx.cwd) === "v7") {
        try {
          const loaded = await approveMechanicalRerouteV7(ctx.cwd);
          if (ctx.hasUI) ctx.ui.notify(`Exact v7 reroute authority issued for run ${loaded.state.runId}`, "info");
        } catch (error) {
          if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }
      const store = new CadProjectStore(ctx.cwd);
      const state = await store.load();
      if (!state || state.status === "done" || state.status === "aborted") {
        if (ctx.hasUI) ctx.ui.notify("No active Pi-CAD workflow", "info");
        return;
      }
      if (!state.pendingReroute) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "No pending reroute to approve. The Agent must record one with cad_reroute first.",
            "warning",
          );
        }
        return;
      }
      const approvedKey = routeKey(state.pendingReroute.route);
      const next: CadRunState = {
        ...state,
        status: "active",
        rerouteAuthorityToken: randomBytes(16).toString("hex"),
        rerouteAuthorityRoute: approvedKey,
        updatedAt: nowIso(),
      };
      await persist(pi, store, next, [
        { type: "RerouteAuthorityIssued", data: { approvedRoute: approvedKey, note: "one-time authority bound to this exact route; consumed by the next cad_reroute" } },
      ]);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Reroute to ${approvedKey} approved. The Agent may perform this reroute exactly once.`,
          "info",
        );
      }
    },
  });

  registerControlTools(pi, deps);
  registerContextCompaction(pi);

  // Resolve an interactive wait as a bounded input transaction. Prompt
  // projection remains read-only and never repairs/migrates state.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (await selectKernelEngine(ctx.cwd) === "v7") {
      await resumeMechanicalRunV7(ctx.cwd);
      return { action: "continue" as const };
    }
    const store = new CadProjectStore(ctx.cwd);
    const state = await store.load();
    if (state && state.status === "waiting_user" && !isHeadless(state)) {
      const next = resumeFromUser(state);
      await persist(pi, store, next, [
        { type: "UserInputResolved", data: { phase: state.phase } },
      ]);
    }
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (await selectKernelEngine(ctx.cwd) === "v7") {
      await codexBridge.ensureProvider();
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
      return { systemPrompt: `${event.systemPrompt}\n\n## Pi-CAD Harness Kernel v7\nworkflow=${loaded.workflow.id}@${loaded.workflow.version} hash=${loaded.workflow.hash}\nregistryContract=${loaded.registryContract.hash}\n\n${compiled.text}` };
    }
    const store = new CadProjectStore(ctx.cwd);
    const [project, state] = await Promise.all([store.loadProject(), store.load()]);
    const active = state && !isTerminalStatus(state.status);
    // Always apply — also when idle/done/aborted — so a finished run drops
    // back to the intake overlay (cad_route) without disturbing any other
    // plugin's active tools.
    applyCadToolOverlay(pi, active ? state : null);
    const missing = await unavailableCapabilities(pi);
    // Mission + Working Context + reference index, appended after the
    // canonical state projection. Empty on fresh runs until the first
    // context rebuild writes working.md.
    const taskContext = active ? await renderTaskContext(store.cwd, state) : "";
    const simulationCapabilities = active
      ? await simulationCapabilityContext(ctx.cwd, toolsForState(state).includes("cad_simulate"))
      : "";
    const base = await composeSystemPrompt("", active ? state : null, missing, project, simulationCapabilities);
    const suffix = taskContext ? `\n\n${taskContext}` : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n${base}${suffix}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (await selectKernelEngine(ctx.cwd) === "v7") {
      return authorizeMechanicalToolV7({ cwd: ctx.cwd, toolName: event.toolName, toolInput: event.input });
    }
    const store = new CadProjectStore(ctx.cwd);
    const state = await guardState(store);
    if (!state) return;

    // Phase enforcement for Pi-CAD-owned tools. setActiveTools is only
    // visibility hygiene; a tool force-reactivated by the user or another
    // extension must still be blocked here.
    const phaseAllowed = new Set(toolsForState(state));
    if (state.routeRequiresReassessment && !phaseAllowed.has(event.toolName)) {
      return {
        block: true,
        reason: `Pi-CAD route reassessment lock: ${event.toolName} is disabled until cad_reroute succeeds or the exact same requirements hash is confirmed unchanged`,
      };
    }
    if (isHeadless(state) && event.toolName === "cad_wait_for_user") {
      return {
        block: true,
        reason:
          "Pi-CAD HEADLESS: cad_wait_for_user is illegal; use cad_defer_clarification for an engineering fallback or cad_declare_blocker for user-owned authority",
      };
    }
    if (PI_CAD_OWNED_TOOLS.has(event.toolName) && !phaseAllowed.has(event.toolName)) {
      return {
        block: true,
        reason: `Pi-CAD: ${event.toolName} is not available in phase ${state.phase}`,
      };
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as { path?: string };
      if (input.path) {
        const check = writePathAllowed(
          ctx.cwd,
          input.path,
          state.mutationPolicy,
          phaseAllowed.has("cad_simulate"),
        );
        if (!check.allowed) {
          return { block: true, reason: `Pi-CAD ${state.mutationPolicy}: ${check.reason}` };
        }
      }
    }
    if (event.toolName === "bash") {
      if (state.mutationPolicy === "read_only") {
        // Shell mutation detection by pattern is fundamentally incomplete
        // (e.g. `python -c "open(...).write(...)"` matches no redirect rule).
        // Read-only phases get no raw shell at all: read/grep/find/ls and
        // cad_probe (programmable presets) cover legitimate read-only
        // computation.
        return {
          block: true,
          reason:
            "Pi-CAD read_only: raw shell execution is disabled; use read/grep/find/ls or cad_probe for computation",
        };
      }
    }
    if (
      state.mutationPolicy === "read_only" &&
      (event.toolName === "cad_build_step" || event.toolName === "cad_export")
    ) {
      return { block: true, reason: "Pi-CAD read_only: mutation tools require a source phase" };
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (await selectKernelEngine(ctx.cwd) === "v7") return;
    const store = new CadProjectStore(ctx.cwd);
    await handleToolResult(pi, store, event);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (await selectKernelEngine(ctx.cwd) === "v7") return;
    const store = new CadProjectStore(ctx.cwd);
    const state = await guardState(store);
    if (!state) return;
    // Rebuild the brain before deciding to continue: when a context rebuild
    // was triggered, continuation resumes from the compaction's
    // onComplete/onError with freshly loaded state.
    if (maybeRebuildContext(pi, store, state, ctx)) return;
    await maybeAutoContinue(pi, store, state, ctx);
  });
}
