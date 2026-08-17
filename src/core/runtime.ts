import type {
  ExtensionAPI,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  CAPABILITY_TOOLS,
  type CadProjectState,
  type EvidenceRef,
} from "../shared/protocol.ts";
import {
  CadProjectStore,
  nowIso,
} from "../shared/store.ts";
import { maybeAutoContinue } from "./continuation.ts";
import { composeSystemPrompt } from "./context.ts";
import {
  registerControlTools,
  type ControllerDeps,
} from "./controller.ts";
import {
  EVIDENCE_KINDS,
  recordToolEvidence,
} from "./evidence.ts";
import { isMutatingBash, toolsForPhase, writePathAllowed } from "./policies.ts";
import {
  createIntakeState,
  resumeFromUser,
  workflowSpec,
} from "./state-machine.ts";
import {
  runBaselineAuto,
  runCandidateAuto,
  runConvertCandidateAuto,
  type PersistFn,
} from "./auto-actions.ts";

const OPTIONAL_TOOL_NAMES = [
  "cad_generate_drawing",
  "cad_run_simulation",
  "cad_render_scene",
] as const;

async function persist(
  pi: ExtensionAPI,
  store: CadProjectStore,
  state: CadProjectState,
  events: Array<{ type: string; data?: unknown }>,
): Promise<void> {
  await store.save(state);
  for (const event of events) {
    await store.appendEvent(event.type, event.data);
  }
  pi.setActiveTools(toolsForPhase(state.phase));
  pi.events.emit("pi-cad:state-changed", state);
  try {
    pi.appendEntry<CadProjectState>("pi-cad-state", state);
  } catch {
    // Canonical state remains .pi-cad/state.json.
  }
}

async function guardState(store: CadProjectStore): Promise<CadProjectState | null> {
  const state = await store.load();
  if (!state || state.status === "done" || state.status === "aborted") return null;
  return state;
}

function customToolDetails(event: ToolResultEvent) {
  if (!("details" in event)) return undefined;
  return event.details as
    | { envelope?: { inputHashes?: Record<string, string>; artifacts?: Array<{ path: string }>; tool?: string }; kind?: string; artifactHash?: string }
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
  if (!info?.envelope || !info.kind) return;
  const kind = info.kind as EvidenceRef["kind"];
  if (!EVIDENCE_KINDS.includes(kind)) return;
  const artifactHash =
    info.artifactHash ??
    info.envelope.inputHashes?.artifact ??
    info.envelope.inputHashes?.after;
  if (!artifactHash) return;
  const envelope = info.envelope as Parameters<typeof recordToolEvidence>[1];
  const next = recordToolEvidence(state, envelope, kind, artifactHash);
  await persist(pi, store, next, [
    {
      type: "EvidenceCreated",
      data: {
        kind,
        artifactHash,
        paths: envelope.artifacts?.map((artifact) => artifact.path) ?? [],
      },
    },
  ]);
}

function unavailableCapabilities(pi: ExtensionAPI): string[] {
  const available = new Set((pi.getAllTools?.() ?? []).map((tool) => tool.name));
  const missing = [...CAPABILITY_TOOLS].filter((name) => !available.has(name));
  return missing.filter((name) =>
    (OPTIONAL_TOOL_NAMES as readonly string[]).includes(name),
  );
}

const REROUTE_SAFE_PHASES = new Set([
  "requirements",
  "concept",
  "domain_analysis",
  "baseline",
  "source_baseline",
  "plan",
  "intent",
  "transform_plan",
  "investigate",
  "explain",
  "audit",
  "gap_closure",
]);

async function createTask(
  pi: ExtensionAPI,
  project: CadProjectStore,
  previous: CadProjectState | null,
  reason: string,
): Promise<CadProjectState | null> {
  const task = await project.createTask({
    parentTaskId: previous?.taskId,
  });
  const state = createIntakeState({
    taskId: task.taskId,
    parentTaskId: previous?.taskId,
  });
  await task.save(state);
  await project.setCurrentTask(task.taskId);
  await persist(pi, project, state, [
    {
      type: "CadStarted",
      data: {
        taskId: state.taskId,
        parentTaskId: previous?.taskId,
        reason,
      },
    },
  ]);
  return state;
}

export default function cadCore(pi: ExtensionAPI) {
  const deps: ControllerDeps = {
    pi,
    persist,
    runBaselineAuto,
    runCandidateAuto,
    runConvertCandidateAuto,
  };

  pi.registerCommand("cad", {
    description: "Open the current CAD task, or archive a finished one and start a new INTAKE task",
    handler: async (args, ctx) => {
      const store = new CadProjectStore(ctx.cwd);
      await store.migrateLegacyProject();
      const state = await store.load();
      if (!state) {
        await createTask(pi, store, null, "command /cad");
        if (ctx.hasUI) ctx.ui.notify("Pi-CAD workflow activated: INTAKE", "info");
      } else if (state.status === "done" || state.status === "aborted") {
        const next = await createTask(pi, store, state, "command /cad after terminal task");
        if (ctx.hasUI && next) {
          ctx.ui.notify(
            `Previous task ${state.taskId} (${state.workflow}/${state.status}) archived. New task ${next.taskId}: INTAKE`,
            "info",
          );
        }
      } else if (ctx.hasUI) {
        ctx.ui.notify(`Pi-CAD already active: ${state.workflow}/${state.phase}`, "warning");
      }
      if (args.trim()) pi.sendUserMessage(args, { expandPromptTemplates: false });
    },
  });

  pi.registerCommand("cad-new", {
    description: "Explicitly start a new CAD task; refuses while a task is active",
    handler: async (args, ctx) => {
      const store = new CadProjectStore(ctx.cwd);
      await store.migrateLegacyProject();
      const state = await store.load();
      if (state && state.status === "active" && state.phase !== "intake") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Current task ${state.taskId} is still active (${state.workflow}/${state.phase}). Abort it before /cad-new.`,
            "error",
          );
        }
        return;
      }
      const previous = state && state.status !== "active" ? state : null;
      const next = await createTask(pi, store, previous, "command /cad-new");
      if (ctx.hasUI && next) ctx.ui.notify(`New task ${next.taskId}: INTAKE`, "info");
      if (args.trim()) pi.sendUserMessage(args, { expandPromptTemplates: false });
    },
  });

  pi.registerCommand("cad-reroute", {
    description: "Reset an active but pre-source task back to INTAKE so the Agent can route again",
    handler: async (_args, ctx) => {
      const store = new CadProjectStore(ctx.cwd);
      const state = await store.load();
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("No current CAD task", "warning");
        return;
      }
      if (!REROUTE_SAFE_PHASES.has(state.phase) || state.status !== "active") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Reroute is only allowed before source/destructive stages. Current: ${state.workflow}/${state.phase} (${state.status})`,
            "error",
          );
        }
        return;
      }
      const next: CadProjectState = {
        ...state,
        workflow: null,
        phase: "intake",
        status: "active",
        mutationPolicy: "read_only",
        candidateLabel: undefined,
        currentSourcePath: undefined,
        currentSourceHash: undefined,
        currentArtifactPath: undefined,
        currentArtifactHash: undefined,
        updatedAt: nowIso(),
      };
      await persist(pi, store, next, [
        { type: "TaskRerouted", data: { taskId: state.taskId, previousWorkflow: state.workflow } },
      ]);
      if (ctx.hasUI) ctx.ui.notify(`Task ${state.taskId} reset to INTAKE`, "info");
    },
  });

  pi.registerCommand("cad-abort", {
    description: "Abort only the current CAD task",
    handler: async (_args, ctx) => {
      const store = new CadProjectStore(ctx.cwd);
      const state = await store.load();
      if (!state) return;
      const next = { ...state, status: "aborted" as const, updatedAt: nowIso() };
      await persist(pi, store, next, [{ type: "Aborted", data: { taskId: state.taskId } }]);
      if (ctx.hasUI) ctx.ui.notify(`Task ${state.taskId} aborted`, "warning");
    },
  });

  registerControlTools(pi, deps);

  pi.on("before_agent_start", async (event, ctx) => {
    const store = new CadProjectStore(ctx.cwd);
    await store.migrateLegacyProject();
    let state = await store.load();
    if (state && state.status === "waiting_user") {
      state = resumeFromUser(state);
      await persist(pi, store, state, [
        { type: "UserInputResolved", data: { phase: state.phase } },
      ]);
    }
    const active = state && state.status !== "done" && state.status !== "aborted";
    if (active && state) {
      pi.setActiveTools(toolsForPhase(state.phase));
    }
    const missing = unavailableCapabilities(pi);
    let parentState: CadProjectState | null = null;
    if (active && state?.parentTaskId) {
      parentState = await store.task(state.parentTaskId).then((task) => task.load());
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${await composeSystemPrompt("", active ? state : null, missing, parentState)}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const store = new CadProjectStore(ctx.cwd);
    const state = await guardState(store);
    if (!state) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as { path?: string };
      if (input.path) {
        const check = writePathAllowed(ctx.cwd, input.path, state.mutationPolicy);
        if (!check.allowed) {
          return { block: true, reason: `Pi-CAD ${state.mutationPolicy}: ${check.reason}` };
        }
      }
    }
    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      if (state.mutationPolicy === "read_only" && input.command && isMutatingBash(input.command)) {
        return {
          block: true,
          reason: `Pi-CAD read_only: mutating bash command blocked (${input.command.slice(0, 80)})`,
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
    const store = new CadProjectStore(ctx.cwd);
    await handleToolResult(pi, store, event);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const store = new CadProjectStore(ctx.cwd);
    const state = await guardState(store);
    if (!state) return;
    await maybeAutoContinue(pi, store, state, ctx);
  });
}

