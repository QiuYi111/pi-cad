import type {
  AgentToolResult,
  ExtensionAPI,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

import {
  artifactPathForKind,
  buildPayload,
  buildStep,
  defaultBuildOutput,
  defaultGeometryEvidencePath,
  defaultVisualEvidenceDir,
  envelopeArtifactHash,
  geometryPayload,
  inspectGeometry,
  inspectVisual,
  readImageContents,
  visualPayload,
} from "../../shared/capability.ts";
import type {
  CadEventEnvelope,
  CadProjectState,
  CadRequirements,
} from "../../shared/protocol.ts";
import {
  ProjectStateStore,
  cloneState,
  nowIso,
  sha256File,
} from "../../shared/store.ts";
import {
  acceptCandidate,
  addEvidence,
  commitRequirements,
  createIntakeState,
  evidenceFromBuild,
  evidenceFromGeometry,
  evidenceFromVisual,
  finishQuick,
  hasCurrentEvidence,
  markEvidenceStale,
  routeQuick,
  toolsForPhase,
  transitionQuick,
} from "../../workflows/quick.ts";

const PROMPT_DIR = new URL("../../prompts/", import.meta.url);
const promptCache = new Map<string, string>();
const nudgedVersions = new Set<string>();

async function loadPrompt(name: string): Promise<string> {
  const cached = promptCache.get(name);
  if (cached !== undefined) return cached;
  try {
    const path = fileURLToPath(new URL(`${name}.md`, PROMPT_DIR));
    const text = await readFile(path, "utf-8");
    promptCache.set(name, text);
    return text;
  } catch {
    const fallback = `# Pi-CAD ${name}\n\nCurrent workflow phase: ${name}.\n`;
    promptCache.set(name, fallback);
    return fallback;
  }
}

function stateSummary(state: CadProjectState): string {
  const lines = [
    `workflow=${state.workflow ?? "unset"} phase=${state.phase} status=${state.status}`,
    `mutationPolicy=${state.mutationPolicy}`,
    `maturity=${state.maturity}`,
  ];
  if (state.candidateLabel) lines.push(`candidate=${state.candidateLabel}`);
  if (state.currentSourceHash) lines.push(`currentSourceHash=${state.currentSourceHash.slice(0, 12)}`);
  if (state.currentArtifactHash) lines.push(`currentArtifactHash=${state.currentArtifactHash.slice(0, 12)}`);
  lines.push(`currentEvidence=${state.evidence.map((e) => e.kind).join(",") || "none"}`);
  if (state.staleEvidence.length) lines.push(`staleEvidence=${state.staleEvidence.length}`);
  return lines.join("\n");
}

async function composeSystemPrompt(base: string, state: CadProjectState | null): Promise<string> {
  const invariants = await loadPrompt("invariants");
  if (!state) {
    return `${base}\n\n${invariants}`;
  }
  const phasePrompt = await loadPrompt(state.phase);
  return [
    base,
    invariants,
    phasePrompt,
    "## Current canonical state (authoritative)",
    stateSummary(state),
    "Use cad_* control tools to move the workflow. Do not claim completion without the corresponding state and evidence.",
  ].join("\n\n");
}

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
    // Session entry persistence is best-effort; canonical state is .pi-cad/state.json.
  }
}

function okTool(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function errTool(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function evidenceSummary(envelope: CadEventEnvelope, kind: string): string {
  if (!envelope.ok) return `${kind} failed`;
  return `${kind}: ${envelope.artifacts.length} artifact(s), hash(es) ${envelope.artifacts
    .map((a) => a.sha256.slice(0, 10))
    .join(",")}`;
}

function customToolDetails(event: ToolResultEvent): { envelope?: CadEventEnvelope; kind?: string } | undefined {
  if (!("details" in event)) return undefined;
  const details = event.details as { envelope?: CadEventEnvelope; kind?: string } | undefined;
  return details;
}

function isMutatingBash(command: string): boolean {
  const c = command.trim();
  if (/\b(rm|mv|cp|touch|tee|install|chmod|chown|ln|mkfs|dd)\b/.test(c)) return true;
  if (/(^|[|&;]\s*)(cat|echo|printf|python3?|uv)\b[^\n|&;]*\s(>>?)\s/.test(c)) return true;
  if (/>\s*\S/.test(c) && !/(2>)/.test(c)) return true;
  if (/\bcadctl\s+(build|render)\b/.test(c)) return true;
  return false;
}

function writePathAllowed(cwd: string, rawPath: string, policy: "read_only" | "source_only" | "allowed"): { allowed: boolean; reason?: string } {
  if (policy === "allowed") return { allowed: true };
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(resolve(cwd), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { allowed: false, reason: "path escapes project root" };
  }
  if (rel.startsWith(".pi-cad")) {
    return { allowed: false, reason: ".pi-cad is owned by the harness" };
  }
  if (policy === "read_only") {
    return { allowed: false, reason: `workflow phase is read_only (tried to write ${rel})` };
  }
  // source_only: only the authored model sources are mutable.
  const ok = extname(absolute) === ".py" || rel.startsWith("models/");
  if (!ok) {
    return { allowed: false, reason: `source_only policy allows only Python model sources (tried ${rel})` };
  }
  return { allowed: true };
}

async function verifyCurrentArtifacts(
  cwd: string,
  state: CadProjectState,
): Promise<string | null> {
  if (!state.currentSourcePath || !state.currentArtifactPath) {
    return "current source/artifact paths are not bound";
  }
  const sourceAbs = resolve(cwd, state.currentSourcePath);
  const artifactAbs = resolve(cwd, state.currentArtifactPath);
  if (!existsSync(sourceAbs)) return `current source is missing: ${state.currentSourcePath}`;
  if (!existsSync(artifactAbs)) return `current artifact is missing: ${state.currentArtifactPath}`;
  if (state.currentSourceHash && (await sha256File(sourceAbs)) !== state.currentSourceHash) {
    return "current source hash does not match the bound version";
  }
  if (state.currentArtifactHash && (await sha256File(artifactAbs)) !== state.currentArtifactHash) {
    return "current artifact hash does not match the bound version";
  }
  return null;
}

async function guardState(store: ProjectStateStore): Promise<CadProjectState | null> {
  const state = await store.load();
  if (!state || state.status === "done" || state.status === "aborted") return null;
  return state;
}

async function toolResult(
  pi: ExtensionAPI,
  store: ProjectStateStore,
  event: ToolResultEvent,
): Promise<void> {
  const state = await guardState(store);
  if (!state) return;
  const info = customToolDetails(event);
  if (!info?.envelope || !info.kind) return;

  if (info.kind === "visual" || info.kind === "geometry") {
    const artifactHash = info.envelope.inputHashes.artifact;
    if (!artifactHash) return;
    const sourceHash = state.currentSourceHash;
    const paths = info.envelope.artifacts.map((a) => a.path);
    const kind = info.kind;
    let next = cloneState(state);
    next.evidence = next.evidence.filter(
      (ref) => !(ref.kind === kind && ref.artifactHash === artifactHash),
    );
    next = addEvidence(next, {
      id: `${kind}-${artifactHash.slice(0, 12)}`,
      kind,
      tool: info.envelope.tool,
      artifactHash,
      sourceHash,
      paths,
      createdAt: nowIso(),
    });
    await persist(pi, store, next, [
      { type: "EvidenceCreated", data: { kind, artifactHash, paths } },
    ]);
  }
}

export default function cadCore(pi: ExtensionAPI) {
  pi.registerCommand("cad", {
    description: "Activate the Pi-CAD Quick workflow (V0 walking skeleton)",
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

  pi.registerTool({
    name: "cad_route",
    label: "Pi-CAD Route",
    description:
      "Explicitly route the current CAD task into a workflow. V0 supports only quick for fully specified direct geometry. Routing is the Agent's semantic decision; the harness only validates the route name.",
    promptSnippet: "Choose the Pi-CAD workflow for a CAD task (V0: quick only)",
    promptGuidelines: [
      "Call cad_route from intake before any CAD mutation.",
      "Quick requires explicit geometry, no architecture choice, no legacy intent recovery, and no fit-critical interface.",
    ],
    parameters: Type.Object({
      workflow: Type.Enum({ quick: "quick" }),
      reason: Type.String({ description: "Why this task matches the selected workflow" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await store.load();
      const result = routeQuick(state, params.workflow, params.reason);
      if (!result.ok) return errTool(result.reason);
      await persist(pi, store, result.state, result.events);
      return okTool(
        `Routed to ${params.workflow}. Harness state is now authoritative.\n\n${await loadPrompt("requirements")}`,
        { state: result.state },
      );
    },
  });

  pi.registerTool({
    name: "cad_commit_requirements",
    label: "Pi-CAD Commit Requirements",
    description:
      "Commit the current maturity working brief after shared understanding is reached. The harness checks schema only; it does not judge whether the requirements are good engineering.",
    promptSnippet: "Commit the Quick working brief and enter the build phase",
    promptGuidelines: [
      "Do not commit requirements before the task is sufficiently defined.",
      "Fully specified V0 tasks may commit with zero extra user questions.",
    ],
    parameters: Type.Object({
      goal: Type.String(),
      deliverables: Type.Array(Type.String(), { minItems: 1 }),
      must: Type.Array(Type.String(), { default: [] }),
      preferences: Type.Array(Type.String(), { default: [] }),
      assumptions: Type.Array(Type.String(), { default: [] }),
      openUnknowns: Type.Array(Type.String(), { default: [] }),
      maturity: Type.Enum({
        review: "review",
        concept: "concept",
        prototype: "prototype",
        engineering: "engineering",
        manufacturing: "manufacturing",
        release: "release",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const record = params as unknown as CadRequirements;
      const result = commitRequirements(state, record);
      if (!result.ok) return errTool(result.reason);
      await store.writeRecord("requirements", record);
      await persist(pi, store, result.state, result.events);
      return okTool(
        `Requirements committed (${result.state.requirementsVersion?.slice(0, 12)}). Harness phase is now BUILD.\n\n${await loadPrompt("build")}`,
        { state: result.state, requirementsVersion: result.state.requirementsVersion },
      );
    },
  });

  pi.registerTool({
    name: "cad_commit_candidate",
    label: "Pi-CAD Commit Candidate",
    description:
      "Commit authored build123d sources as a candidate. The harness automatically builds STEP, renders current views, gathers geometry facts, binds evidence to the artifact hash, and enters review. The harness does not judge the design.",
    promptSnippet: "Commit model source; harness runs build + visual + geometry automatically",
    promptGuidelines: [
      "Only call from the build phase.",
      "Write the source first with the normal write tool. The harness owns build outputs and evidence.",
      "After the result, inspect every returned view and use cad_measure for critical dimensions.",
    ],
    parameters: Type.Object({
      sources: Type.Array(Type.String(), { minItems: 1 }),
      label: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      if (state.phase !== "build") {
        return errTool(`cad_commit_candidate is only valid in build; current phase is ${state.phase}`);
      }

      const source = params.sources[0];
      const sourceAbs = resolve(ctx.cwd, source);
      if (!existsSync(sourceAbs)) {
        return errTool(`candidate source does not exist: ${source}`);
      }
      const sourceHash = await sha256File(sourceAbs);
      const output = defaultBuildOutput(ctx.cwd, source);
      const buildEnvelope = await buildStep(ctx.cwd, { source, output, force: true });
      if (!buildEnvelope.ok) {
        return errTool(
          `Candidate build failed. The workflow remains in BUILD.\n${buildPayload(buildEnvelope).error ?? "unknown build error"}\n${buildPayload(buildEnvelope).stderr ?? ""}`,
          { envelope: buildEnvelope, sourceHash },
        );
      }

      const stepPath = artifactPathForKind(buildEnvelope, "step") ?? output;
      const artifactHash = envelopeArtifactHash(buildEnvelope, "step") ?? (await sha256File(stepPath));
      const visualDir = defaultVisualEvidenceDir(ctx.cwd, stepPath);
      const geometryPath = defaultGeometryEvidencePath(ctx.cwd, stepPath);

      let next = cloneState(state);
      next = markEvidenceStale(next);
      next = addEvidence(next, evidenceFromBuild(buildEnvelope, artifactHash, sourceHash));
      const warnings: string[] = [];
      const events: Array<{ type: string; data?: unknown }> = [
        { type: "SourceChanged", data: { source, sourceHash } },
        { type: "ArtifactBuilt", data: { artifact: stepPath, artifactHash } },
      ];

      const visualEnvelope = await inspectVisual(ctx.cwd, stepPath, visualDir);
      if (visualEnvelope.ok) {
        next = addEvidence(next, evidenceFromVisual(visualEnvelope, artifactHash, sourceHash));
        events.push({ type: "EvidenceCreated", data: { kind: "visual", artifactHash } });
      } else {
        warnings.push(`visual auto-action failed: ${visualPayload(visualEnvelope).error ?? "unknown error"}`);
      }

      const geometryEnvelope = await inspectGeometry(ctx.cwd, stepPath, geometryPath);
      if (geometryEnvelope.ok) {
        next = addEvidence(next, evidenceFromGeometry(geometryEnvelope, artifactHash, sourceHash));
        events.push({ type: "EvidenceCreated", data: { kind: "geometry", artifactHash } });
      } else {
        warnings.push(`geometry auto-action failed: ${geometryPayload(geometryEnvelope).error ?? "unknown error"}`);
      }

      const accepted = acceptCandidate(
        next,
        {
          label: params.label,
          sources: params.sources,
          sourceHashes: { [source]: sourceHash },
          sourcePath: source,
          artifactPath: stepPath,
        },
        artifactHash,
      );
      if (!accepted.ok) return errTool(accepted.reason);
      next = accepted.state;
      events.push(...accepted.events);

      await store.writeManifest({
        schemaVersion: 1,
        candidate: params.label,
        source: source,
        sourceHash,
        artifact: stepPath,
        artifactHash,
        evidence: next.evidence.map((ref) => ({ kind: ref.kind, artifactHash: ref.artifactHash, paths: ref.paths })),
        warnings,
        updatedAt: nowIso(),
      });
      await persist(pi, store, next, events);

      const images = visualEnvelope.ok
        ? await readImageContents((visualPayload(visualEnvelope).views ?? []).map((view) => view.path))
        : [];
      const summary = [
        `Candidate ${params.label} committed. Harness executed:`,
        `- ${evidenceSummary(buildEnvelope, "build")}`,
        `- ${evidenceSummary(visualEnvelope, "visual")}`,
        `- ${evidenceSummary(geometryEnvelope, "geometry")}`,
        `artifactHash=${artifactHash.slice(0, 12)}`,
        `sourceHash=${sourceHash.slice(0, 12)}`,
        ...(warnings.length ? [`warnings: ${warnings.join("; ")}`] : []),
        "",
        "Phase is REVIEW. Inspect the attached current-version images yourself.",
      ].join("\n");
      return {
        content: [{ type: "text", text: summary }, ...images],
        details: { state: next, envelope: buildEnvelope },
      };
    },
  });

  pi.registerTool({
    name: "cad_transition",
    label: "Pi-CAD Transition",
    description:
      "Express an explicit workflow transition. V0: revise returns from review to build; accepted moves review to ready only when current visual and geometry evidence exists for the current artifact hash.",
    promptSnippet: "Move the Quick workflow with revise or accepted",
    promptGuidelines: [
      "revise: local geometry issue; edit source and commit a new candidate.",
      "accepted: you have personally interpreted current views and verified critical facts.",
    ],
    parameters: Type.Object({
      event: Type.Enum({ revise: "revise", accepted: "accepted" }),
      note: Type.String({ description: "Engineering reason and checks performed" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");

      if (params.event === "accepted" && state.phase === "review") {
        const verification = await verifyCurrentArtifacts(ctx.cwd, state);
        if (verification) return errTool(`cannot accept: ${verification}`);
        if (!state.currentArtifactHash || !state.currentSourceHash) {
          return errTool("cannot accept: current source/artifact hashes are not bound");
        }
        if (!hasCurrentEvidence(state, "visual")) {
          return errTool("cannot accept: current visual evidence is missing or stale");
        }
        if (!hasCurrentEvidence(state, "geometry")) {
          return errTool("cannot accept: current geometry evidence is missing or stale");
        }
      }

      const result = transitionQuick(state, params.event, params.note);
      if (!result.ok) return errTool(result.reason);
      await persist(pi, store, result.state, result.events);
      const nextPrompt =
        result.state.phase === "ready" ? await loadPrompt("ready") : await loadPrompt("build");
      return okTool(
        `Transition ${params.event} accepted. Phase is now ${result.state.phase.toUpperCase()}.\n\n${nextPrompt}`,
        { state: result.state },
      );
    },
  });

  pi.registerTool({
    name: "cad_finish",
    label: "Pi-CAD Finish",
    description:
      "Request workflow closure. The harness verifies READY phase, current source/artifact files, and current-version visual and geometry evidence. It does not judge whether the design itself is good.",
    promptSnippet: "Close the Quick workflow after Ready",
    promptGuidelines: ["Only call after cad_transition(accepted) and delivery."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const verification = await verifyCurrentArtifacts(ctx.cwd, state);
      if (verification) return errTool(`cad_finish blocked: ${verification}`);
      const result = finishQuick(state);
      if (!result.ok) return errTool(result.reason);
      await persist(pi, store, result.state, result.events);
      return okTool(
        `Workflow ${result.state.workflow} finished. taskId=${result.state.taskId}. Deliver source + STEP with current evidence.`,
        { state: result.state },
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const store = new ProjectStateStore(ctx.cwd);
    const state = await guardState(store);
    if (state) {
      pi.setActiveTools(toolsForPhase(state.phase));
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${await composeSystemPrompt("", state)}`,
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
        return { block: true, reason: `Pi-CAD read_only: mutating bash command blocked (${input.command.slice(0, 80)})` };
      }
    }

    if (state.mutationPolicy === "read_only" && event.toolName === "cad_build_step") {
      return { block: true, reason: "Pi-CAD read_only: use cad_commit_candidate from the build phase instead" };
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const store = new ProjectStateStore(ctx.cwd);
    await toolResult(pi, store, event);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const store = new ProjectStateStore(ctx.cwd);
    const state = await guardState(store);
    if (!state) return;
    if (state.phase !== "build" && state.phase !== "review") return;
    const key = `${state.taskId}:${state.phase}:${state.currentSourceHash ?? "none"}:${state.currentArtifactHash ?? "none"}`;
    if (nudgedVersions.has(key)) return;
    nudgedVersions.add(key);
    pi.sendUserMessage(
      `Pi-CAD workflow is still in ${state.phase.toUpperCase()} (${stateSummary(state)}). Continue the Quick workflow: build and commit a candidate, or review the current evidence and transition.`,
      { deliverAs: "followUp" },
    );
  });
}
