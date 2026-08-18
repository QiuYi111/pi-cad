import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import {
  CAPABILITY_TOOLS,
  type CadRunState,
  type EvidenceRef,
} from "../shared/protocol.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CadProjectStore, nowIso } from "../shared/store.ts";
import { runBaselineAuto, runCandidateAuto, runConvertCandidateAuto, type PersistFn } from "./auto-actions.ts";
import { packageRoot } from "../shared/capability.ts";
import { composeSystemPrompt } from "./context.ts";
import { maybeAutoContinue } from "./continuation.ts";
import { registerControlTools, type ControllerDeps } from "./controller.ts";
import { EVIDENCE_KINDS, recordToolEvidence } from "./evidence.ts";
import { isMutatingBash, toolsForPhase, writePathAllowed } from "./policies.ts";
import { resumeFromUser } from "./state-machine.ts";

const OPTIONAL_TOOL_NAMES = [
  "cad_generate_drawing",
  "cad_simulate",
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
  pi.setActiveTools(toolsForPhase(state.phase));
  pi.events.emit("pi-cad:state-changed", state);
  try {
    pi.appendEntry<CadRunState>("pi-cad-run-state", state);
  } catch {
    // Canonical state remains .pi-cad/project.json + .pi-cad/runs/<runId>/.
  }
}

async function guardState(store: CadProjectStore): Promise<CadRunState | null> {
  const state = await store.load();
  if (!state || state.status === "done" || state.status === "aborted") return null;
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
          payload?: { status?: string };
          inputHashes?: Record<string, string>;
          artifacts?: Array<{ path: string }>;
          tool?: string;
        };
        kind?: string;
        artifactHash?: string;
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
  if (!info?.envelope || !info.kind) return;
  const kind = info.kind as EvidenceRef["kind"];
  if (!EVIDENCE_KINDS.includes(kind)) return;
  if (!envelopeOk(info.envelope)) return;
  if (kind === "simulation") {
    const payload = info.envelope.payload as { status?: string } | undefined;
    if (payload?.status !== "solved" || (info.envelope.artifacts?.length ?? 0) === 0) {
      return;
    }
  }
  if (kind === "optimization" && (info.envelope.artifacts?.length ?? 0) === 0) return;
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

async function unavailableCapabilities(pi: ExtensionAPI): Promise<string[]> {
  const available = new Set((pi.getAllTools?.() ?? []).map((tool) => tool.name));
  const missing = [...CAPABILITY_TOOLS].filter((name) => !available.has(name));
  const result = missing.filter((name) =>
    (OPTIONAL_TOOL_NAMES as readonly string[]).includes(name),
  );
  try {
    const raw = await readFile(join(packageRoot(), ".pi-cad-runtime.json"), "utf-8");
    const doctor = JSON.parse(raw) as {
      capabilities?: {
        simulation?: { status?: string };
        differentiableOptimization?: { status?: string };
      };
    };
    if (available.has("cad_simulate") && doctor.capabilities?.simulation?.status !== "ready") {
      result.push("cad_simulate: doctor simulation backend not ready");
    }
    if (
      available.has("cad_optimize") &&
      doctor.capabilities?.differentiableOptimization?.status !== "ready"
    ) {
      result.push("cad_optimize: doctor differentiableOptimization not ready");
    }
  } catch {
    // No doctor report installed yet; fall back to tool-registration check.
  }
  return result;
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
    description: "Show the Pi-CAD workspace: project, design head, and active run",
    handler: async (args, ctx) => {
      const store = new CadProjectStore(ctx.cwd);
      await store.migrateLegacyProject();
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
            ? `activeRun=${run.runId} workflow=${run.workflow ?? "intake"} phase=${run.phase}`
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

  registerControlTools(pi, deps);

  pi.on("before_agent_start", async (event, ctx) => {
    const store = new CadProjectStore(ctx.cwd);
    await store.migrateLegacyProject();
    const project = await store.ensureProject();
    let state = await store.load();
    if (state && state.status === "waiting_user") {
      state = resumeFromUser(state);
      await persist(pi, store, state, [
        { type: "UserInputResolved", data: { phase: state.phase } },
      ]);
    }
    const active = state && state.status !== "done" && state.status !== "aborted";
    if (active && state) pi.setActiveTools(toolsForPhase(state.phase));
    const missing = await unavailableCapabilities(pi);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${await composeSystemPrompt("", active ? state : null, missing, project)}`,
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
