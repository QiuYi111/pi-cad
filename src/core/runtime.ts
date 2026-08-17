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
  nowIso,
  ProjectStateStore,
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
  store: ProjectStateStore,
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

async function guardState(store: ProjectStateStore): Promise<CadProjectState | null> {
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
  store: ProjectStateStore,
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

export default function cadCore(pi: ExtensionAPI) {
  const deps: ControllerDeps = {
    pi,
    persist,
    runBaselineAuto,
    runCandidateAuto,
    runConvertCandidateAuto,
  };

  pi.registerCommand("cad", {
    description: "Activate the Pi-CAD workflow (quick, analyze, modify, greenfield, hybrid, convert, release)",
    handler: async (args, ctx) => {
      const store = new ProjectStateStore(ctx.cwd);
      let state = await store.load();
      if (!state) {
        state = createIntakeState();
        await persist(pi, store, state, [{ type: "CadStarted", data: { taskId: state.taskId } }]);
        if (ctx.hasUI) ctx.ui.notify("Pi-CAD workflow activated: INTAKE", "info");
      } else if (ctx.hasUI) {
        ctx.ui.notify(`Pi-CAD workflow already active: ${state.phase.toUpperCase()}`, "info");
      }
      if (args.trim()) {
        pi.sendUserMessage(args, { expandPromptTemplates: false });
      }
    },
  });

  pi.registerCommand("cad-abort", {
    description: "Abort the active Pi-CAD workflow",
    handler: async (_args, ctx) => {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await store.load();
      if (!state) return;
      const next = { ...state, status: "aborted" as const, updatedAt: nowIso() };
      await persist(pi, store, next, [{ type: "Aborted", data: { taskId: state.taskId } }]);
      if (ctx.hasUI) ctx.ui.notify("Pi-CAD workflow aborted", "warning");
    },
  });

  registerControlTools(pi, deps);

  pi.on("before_agent_start", async (event, ctx) => {
    const store = new ProjectStateStore(ctx.cwd);
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
    return {
      systemPrompt: `${event.systemPrompt}\n\n${await composeSystemPrompt("", active ? state : null, missing)}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const store = new ProjectStateStore(ctx.cwd);
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
    const store = new ProjectStateStore(ctx.cwd);
    await handleToolResult(pi, store, event);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const store = new ProjectStateStore(ctx.cwd);
    const state = await guardState(store);
    if (!state) return;
    await maybeAutoContinue(pi, store, state, ctx);
  });
}

