import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import {
  CAPABILITY_TOOLS,
  type CadRunState,
  routeKey,
  type EvidenceRef,
} from "../shared/protocol.ts";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CadProjectStore, nowIso } from "../shared/store.ts";
import { runBaselineAuto, runCandidateAuto, runConvertCandidateAuto, type PersistFn } from "./auto-actions.ts";
import { currentDoctorReport, type DoctorReport, packageRoot } from "../shared/capability.ts";
import { composeSystemPrompt } from "./context.ts";
import { maybeRebuildContext, registerContextCompaction, renderTaskContext } from "./context-memory.ts";
import { maybeAutoContinue } from "./continuation.ts";
import { registerControlTools, type ControllerDeps } from "./controller.ts";
import { EVIDENCE_KINDS, recordToolEvidence } from "./evidence.ts";
import { applyCadToolOverlay, PI_CAD_OWNED_TOOLS, toolsForPhase, writePathAllowed } from "./policies.ts";
import { resumeFromUser } from "./state-machine.ts";

const OPTIONAL_TOOL_NAMES = [
  "cad_generate_drawing",
  "cad_simulate",
  "cad_simulate_flow",
  "cad_simulate_thermal",
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
          payload?: { status?: string; caseId?: string };
          inputHashes?: Record<string, string>;
          artifacts?: Array<{ path: string }>;
          tool?: string;
        };
        kind?: string;
        artifactHash?: string;
        specHash?: string;
        caseId?: string;
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
  const specHash =
    info.specHash ??
    (kind === "simulation" || kind === "optimization" ? info.envelope.inputHashes?.spec : undefined);
  const caseId =
    info.caseId ??
    (kind === "simulation" ? (info.envelope.payload as { caseId?: string } | undefined)?.caseId : undefined);
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

async function unavailableCapabilities(pi: ExtensionAPI, cwd?: string): Promise<string[]> {
  const available = new Set((pi.getAllTools?.() ?? []).map((tool) => tool.name));
  const missing = [...CAPABILITY_TOOLS].filter((name) => !available.has(name));
  const result = missing.filter((name) =>
    (OPTIONAL_TOOL_NAMES as readonly string[]).includes(name),
  );
  // Runtime source of truth is a live `cadctl doctor` against the Python the
  // harness would actually use (PI_CAD_PYTHON / PI_CAD_VENV honored), cached
  // per session. The install-time .pi-cad-runtime.json is only a fallback
  // diagnostic when the live probe itself cannot run.
  let doctor: DoctorReport | null = await currentDoctorReport(cwd);
  if (!doctor) {
    try {
      const raw = await readFile(join(packageRoot(), ".pi-cad-runtime.json"), "utf-8");
      doctor = JSON.parse(raw) as DoctorReport;
    } catch {
      // No doctor report installed and probe failed; fall back to the
      // tool-registration check only.
    }
  }
  if (doctor?.capabilities) {
    if (available.has("cad_simulate") && doctor.capabilities.simulation?.status !== "ready") {
      result.push("cad_simulate: doctor simulation backend not ready");
    }
    const thermalFluid = doctor.capabilities.thermalFluid as { status?: string } | undefined;
    if (available.has("cad_simulate_flow") && thermalFluid?.status !== "ready") {
      result.push("cad_simulate_flow: doctor thermalFluid backend not ready");
    }
    if (available.has("cad_simulate_thermal") && thermalFluid?.status !== "ready") {
      result.push("cad_simulate_thermal: doctor thermalFluid backend not ready");
    }
    if (
      available.has("cad_optimize") &&
      doctor.capabilities.differentiableOptimization?.status !== "ready"
    ) {
      result.push("cad_optimize: doctor differentiableOptimization not ready");
    }
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
      await store.migrate();
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

  pi.on("before_agent_start", async (event, ctx) => {
    const store = new CadProjectStore(ctx.cwd);
    await store.migrate();
    const project = await store.ensureProject();
    let state = await store.load();
    if (state && state.status === "waiting_user") {
      state = resumeFromUser(state);
      // Deliberately NO reroute authority here: an ordinary user reply only
      // proves the user spoke, not that they approved a downgrade. Downgrade
      // authority is issued exclusively by the /cad-approve-reroute command.
      await persist(pi, store, state, [
        { type: "UserInputResolved", data: { phase: state.phase } },
      ]);
    }
    const active = state && state.status !== "done" && state.status !== "aborted";
    // Always apply — also when idle/done/aborted — so a finished run drops
    // back to the intake overlay (cad_route) without disturbing any other
    // plugin's active tools.
    applyCadToolOverlay(pi, active ? state : null);
    const missing = await unavailableCapabilities(pi, ctx.cwd);
    // Mission + Working Context + reference index, appended after the
    // canonical state projection. Empty on fresh runs until the first
    // context rebuild writes working.md.
    const taskContext = active ? await renderTaskContext(store.cwd, state) : "";
    const base = await composeSystemPrompt("", active ? state : null, missing, project);
    const suffix = taskContext ? `\n\n${taskContext}` : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n${base}${suffix}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const store = new CadProjectStore(ctx.cwd);
    const state = await guardState(store);
    if (!state) return;

    // Phase enforcement for Pi-CAD-owned tools. setActiveTools is only
    // visibility hygiene; a tool force-reactivated by the user or another
    // extension must still be blocked here.
    const phaseAllowed = new Set(toolsForPhase(state.phase));
    if (PI_CAD_OWNED_TOOLS.has(event.toolName) && !phaseAllowed.has(event.toolName)) {
      return {
        block: true,
        reason: `Pi-CAD: ${event.toolName} is not available in phase ${state.phase}`,
      };
    }

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
    const store = new CadProjectStore(ctx.cwd);
    await handleToolResult(pi, store, event);
  });

  pi.on("agent_settled", async (_event, ctx) => {
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
