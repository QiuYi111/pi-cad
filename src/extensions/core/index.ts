import type {
  AgentToolResult,
  ExtensionAPI,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

import {
  artifactPathForKind,
  assemblyTree,
  buildPayload,
  buildStep,
  compareGeometry,
  defaultBuildOutput,
  defaultGeometryEvidencePath,
  defaultVisualEvidenceDir,
  envelopeArtifactHash,
  exportArtifact,
  geometryPayload,
  inspectGeometry,
  inspectVisual,
  readImageContents,
  visualPayload,
} from "../../shared/capability.ts";
import type {
  CadEventEnvelope,
  CadPhase,
  CadPlan,
  CadProjectState,
  CadRequirements,
  CadWorkflow,
  EvidenceRef,
} from "../../shared/protocol.ts";
import {
  ALL_WORKFLOWS,
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
  commitPlan,
  commitRequirements,
  createIntakeState,
  evidenceFromBuild,
  evidenceFromEnvelope,
  finish,
  hasCurrentEvidence,
  hasEvidenceForArtifact,
  markEvidenceStale,
  releaseWorkstreamsClosed,
  resumeFromUser,
  route,
  toolsForPhase,
  transition,
  waitForUser,
} from "../../workflows/registry.ts";

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
    const fallback = `# Pi-CAD ${name}\n\nCurrent workflow phase: ${name}. Use cad_* control tools to continue.\n`;
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
  if (state.baselineArtifactHash) lines.push(`baselineArtifactHash=${state.baselineArtifactHash.slice(0, 12)}`);
  lines.push(`currentEvidence=${state.evidence.map((e) => e.kind).join(",") || "none"}`);
  if (state.staleEvidence.length) lines.push(`staleEvidence=${state.staleEvidence.length}`);
  if (state.workflow === "release") {
    lines.push(`workstreams=${Object.entries(state.workstreamStatuses ?? {}).map(([k, v]) => `${k}:${v}`).join(",") || "unset"}`);
  }
  return lines.join("\n");
}

async function composeSystemPrompt(base: string, state: CadProjectState | null): Promise<string> {
  const invariants = await loadPrompt("invariants");
  if (!state) return `${base}\n\n${invariants}`;
  const phasePrompt = await loadPrompt(state.phase);
  const statusNote =
    state.status === "waiting_user"
      ? "\n\n## Waiting for user\nA cad_wait_for_user decision is outstanding. The new user turn resolves it; do not re-ask the same question if it was just answered."
      : "";
  return [
    base,
    invariants,
    phasePrompt,
    "## Current canonical state (authoritative)",
    stateSummary(state),
    "Use cad_* control tools to move the workflow. Do not claim completion without the corresponding state and evidence.",
    statusNote,
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
    // Canonical state remains .pi-cad/state.json.
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

function customToolDetails(event: ToolResultEvent): { envelope?: CadEventEnvelope; kind?: string; artifactHash?: string } | undefined {
  if (!("details" in event)) return undefined;
  return event.details as { envelope?: CadEventEnvelope; kind?: string; artifactHash?: string } | undefined;
}

function isMutatingBash(command: string): boolean {
  const c = command.trim();
  if (/\b(rm|mv|cp|touch|tee|install|chmod|chown|ln|mkfs|dd)\b/.test(c)) return true;
  if (/(^|[|&;]\s*)(cat|echo|printf|python3?|uv)\b[^\n|&;]*\s(>>?)\s/.test(c)) return true;
  if (/>\s*\S/.test(c) && !/(2>)/.test(c)) return true;
  if (/\bcadctl\s+(build|render|export|drawing|simulate|present)\b/.test(c)) return true;
  return false;
}

function writePathAllowed(cwd: string, rawPath: string, policy: "read_only" | "source_only" | "allowed"): { allowed: boolean; reason?: string } {
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(resolve(cwd), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return { allowed: false, reason: "path escapes project root" };
  if (rel.startsWith(".pi-cad")) return { allowed: false, reason: ".pi-cad is owned by the harness" };
  if (policy === "allowed") return { allowed: true };
  if (policy === "read_only") return { allowed: false, reason: `workflow phase is read_only (tried to write ${rel})` };
  const ok = extname(absolute) === ".py" || rel.startsWith("models/");
  if (!ok) return { allowed: false, reason: `source_only policy allows only Python model sources (tried ${rel})` };
  return { allowed: true };
}

async function verifyCurrentArtifacts(cwd: string, state: CadProjectState): Promise<string | null> {
  if (state.workflow === "analyze") {
    if (!state.baselineArtifactPath) return "baseline artifact path is not bound";
    const baseline = resolve(cwd, state.baselineArtifactPath);
    if (!existsSync(baseline)) return `baseline artifact is missing: ${state.baselineArtifactPath}`;
    if (state.baselineArtifactHash && (await sha256File(baseline)) !== state.baselineArtifactHash) {
      return "baseline artifact hash does not match the bound version";
    }
    return null;
  }
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

function verifyEvidenceFilesForHash(
  cwd: string,
  state: CadProjectState,
  hash: string,
  kinds: EvidenceRef["kind"][],
): string | null {
  for (const kind of kinds) {
    const refs = state.evidence.filter((ref) => ref.kind === kind && ref.artifactHash === hash);
    if (refs.length === 0) return `${kind} evidence is missing`;
    if (refs.some((ref) => ref.paths.some((path) => !existsSync(resolve(cwd, path))))) {
      return `${kind} evidence files are missing`;
    }
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
  const artifactHash = info.artifactHash ?? info.envelope.inputHashes.artifact ?? info.envelope.inputHashes.after;
  if (!artifactHash) return;
  const kind = info.kind as EvidenceRef["kind"];
  const evidenceKinds: EvidenceRef["kind"][] = [
    "visual",
    "geometry",
    "build",
    "compare",
    "section",
    "drawing",
    "simulation",
    "presentation",
    "convert",
    "assembly",
  ];
  if (!evidenceKinds.includes(kind)) return;
  let next = cloneState(state);
  next.evidence = next.evidence.filter(
    (ref) => !(ref.kind === kind && ref.artifactHash === artifactHash),
  );
  next = addEvidence(next, evidenceFromEnvelope(kind, info.envelope.tool, info.envelope, artifactHash, state.currentSourceHash));
  await persist(pi, store, next, [
    { type: "EvidenceCreated", data: { kind, artifactHash, paths: info.envelope.artifacts.map((a) => a.path) } },
  ]);
}

async function baselineArtifactCandidate(
  record: CadRequirements,
  cwd: string,
): Promise<string | null> {
  const inputs = record.inputs ?? [];
  return inputs.find((input) => /\.(step|stp)$/i.test(input)) ?? null;
}

async function runBaselineAuto(
  pi: ExtensionAPI,
  store: ProjectStateStore,
  state: CadProjectState,
  artifactRel: string,
): Promise<{ state: CadProjectState; images: Array<{ type: "image"; data: string; mimeType: string }>; warnings: string[] }> {
  const cwd = store.cwd;
  const artifactAbs = resolve(cwd, artifactRel);
  const artifactHash = await sha256File(artifactAbs);
  const visualDir = defaultVisualEvidenceDir(cwd, artifactAbs);
  const geometryPath = defaultGeometryEvidencePath(cwd, artifactAbs);
  const warnings: string[] = [];
  const events: Array<{ type: string; data?: unknown }> = [];

  let next = cloneState(state);
  next = {
    ...next,
    baselineSourcePath: /\.(step|stp)$/i.test(artifactRel) ? artifactRel : undefined,
    baselineSourceHash: /\.(step|stp)$/i.test(artifactRel) ? artifactHash : undefined,
    baselineArtifactPath: artifactRel,
    baselineArtifactHash: artifactHash,
  };
  if (next.workflow === "release") {
    next = {
      ...next,
      currentSourcePath: /\.(step|stp)$/i.test(artifactRel) ? artifactRel : artifactRel,
      currentSourceHash: artifactHash,
      currentArtifactPath: artifactRel,
      currentArtifactHash: artifactHash,
    };
  }

  const visualEnvelope = await inspectVisual(cwd, artifactAbs, visualDir);
  if (visualEnvelope.ok) {
    next = addEvidence(next, evidenceFromEnvelope("visual", "cad_inspect_visual", visualEnvelope, artifactHash));
    events.push({ type: "EvidenceCreated", data: { kind: "visual", artifactHash } });
  } else {
    warnings.push(`baseline visual auto-action failed: ${visualPayload(visualEnvelope).error ?? "unknown error"}`);
  }

  const geometryEnvelope = await inspectGeometry(cwd, artifactAbs, geometryPath);
  if (geometryEnvelope.ok) {
    next = addEvidence(next, evidenceFromEnvelope("geometry", "cad_inspect_geometry", geometryEnvelope, artifactHash));
    events.push({ type: "EvidenceCreated", data: { kind: "geometry", artifactHash } });
  } else {
    warnings.push(`baseline geometry auto-action failed: ${geometryPayload(geometryEnvelope).error ?? "unknown error"}`);
  }

  await persist(pi, store, next, [
    { type: "BaselineBound", data: { artifact: artifactRel, artifactHash } },
    ...events,
  ]);
  const images = visualEnvelope.ok
    ? await readImageContents((visualPayload(visualEnvelope).views ?? []).map((view) => view.path))
    : [];
  return { state: next, images, warnings };
}

async function runCandidateAuto(
  pi: ExtensionAPI,
  store: ProjectStateStore,
  state: CadProjectState,
  source: string,
  label: string,
): Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }> {
  const cwd = store.cwd;
  const sourceAbs = resolve(cwd, source);
  if (!existsSync(sourceAbs)) return { ok: false, text: `candidate source does not exist: ${source}` };
  const sourceHash = await sha256File(sourceAbs);
  const output = defaultBuildOutput(cwd, source);
  const buildEnvelope = await buildStep(cwd, { source, output, force: true });
  if (!buildEnvelope.ok) {
    return {
      ok: false,
      text: `Candidate build failed. The workflow remains in ${state.phase.toUpperCase()}.\n${buildPayload(buildEnvelope).error ?? "unknown build error"}\n${buildPayload(buildEnvelope).stderr ?? ""}`,
      details: { envelope: buildEnvelope, sourceHash },
    };
  }

  const stepPath = artifactPathForKind(buildEnvelope, "step") ?? output;
  const artifactHash = envelopeArtifactHash(buildEnvelope, "step") ?? (await sha256File(stepPath));
  const visualDir = defaultVisualEvidenceDir(cwd, stepPath);
  const geometryPath = defaultGeometryEvidencePath(cwd, stepPath);

  let next = markEvidenceStale(cloneState(state));
  next = addEvidence(next, evidenceFromBuild(buildEnvelope, artifactHash, sourceHash));
  const warnings: string[] = [];
  const events: Array<{ type: string; data?: unknown }> = [
    { type: "SourceChanged", data: { source, sourceHash } },
    { type: "ArtifactBuilt", data: { artifact: stepPath, artifactHash } },
  ];

  const visualEnvelope = await inspectVisual(cwd, stepPath, visualDir);
  if (visualEnvelope.ok) {
    next = addEvidence(next, evidenceFromEnvelope("visual", "cad_inspect_visual", visualEnvelope, artifactHash, sourceHash));
    events.push({ type: "EvidenceCreated", data: { kind: "visual", artifactHash } });
  } else {
    warnings.push(`visual auto-action failed: ${visualPayload(visualEnvelope).error ?? "unknown error"}`);
  }

  const geometryEnvelope = await inspectGeometry(cwd, stepPath, geometryPath);
  if (geometryEnvelope.ok) {
    next = addEvidence(next, evidenceFromEnvelope("geometry", "cad_inspect_geometry", geometryEnvelope, artifactHash, sourceHash));
    events.push({ type: "EvidenceCreated", data: { kind: "geometry", artifactHash } });
  } else {
    warnings.push(`geometry auto-action failed: ${geometryPayload(geometryEnvelope).error ?? "unknown error"}`);
  }

  if ((state.workflow === "modify" || state.workflow === "convert") && state.baselineArtifactPath && existsSync(resolve(cwd, state.baselineArtifactPath))) {
    const compareOutput = resolve(cwd, ".pi-cad", "evidence", "compare", `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    const compareEnvelope = await compareGeometry(cwd, state.baselineArtifactPath, stepPath, compareOutput);
    if (compareEnvelope.ok) {
      next = addEvidence(next, evidenceFromEnvelope("compare", "cad_compare_geometry", compareEnvelope, artifactHash, sourceHash));
      events.push({ type: "EvidenceCreated", data: { kind: "compare", artifactHash } });
    } else {
      warnings.push(`compare auto-action failed: ${compareEnvelope.payload.error ?? "unknown error"}`);
    }
  }

  const accepted = acceptCandidate(
    next,
    { label, sources: [source], sourceHashes: { [source]: sourceHash }, sourcePath: source, artifactPath: stepPath },
    artifactHash,
  );
  if (!accepted.ok) return { ok: false, text: accepted.reason };
  next = accepted.state;
  events.push(...accepted.events);

  await store.writeManifest({
    schemaVersion: 2,
    candidate: label,
    source,
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
    `Candidate ${label} committed. Harness executed build, visual, geometry${(state.workflow === "modify" || state.workflow === "convert") && state.baselineArtifactPath ? ", compare" : ""}.`,
    `- ${evidenceSummary(buildEnvelope, "build")}`,
    `- ${evidenceSummary(visualEnvelope, "visual")}`,
    `- ${evidenceSummary(geometryEnvelope, "geometry")}`,
    `artifactHash=${artifactHash.slice(0, 12)}`,
    `sourceHash=${sourceHash.slice(0, 12)}`,
    ...(warnings.length ? [`warnings: ${warnings.join("; ")}`] : []),
    "",
    `Phase is ${next.phase.toUpperCase()}. Inspect the attached current-version images yourself.`,
  ].join("\n");
  return { ok: true, text: summary, images, details: { state: next, envelope: buildEnvelope } };
}

const WORKFLOW_ENUM = Type.Enum({
  quick: "quick",
  analyze: "analyze",
  modify: "modify",
  greenfield: "greenfield",
  hybrid: "hybrid",
  convert: "convert",
  release: "release",
});

export default function cadCore(pi: ExtensionAPI) {
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

  pi.registerTool({
    name: "cad_route",
    label: "Pi-CAD Route",
    description:
      "Route the current CAD task into one of seven workflows: quick, analyze, modify, greenfield, hybrid, convert, release. Routing is the Agent's semantic decision; the harness only validates the route name.",
    promptSnippet: "Choose the Pi-CAD workflow for a CAD task",
    promptGuidelines: [
      "Call cad_route from intake before any CAD mutation.",
      "quick: fully specified direct geometry.",
      "analyze: read-only diagnosis and explanation.",
      "modify: existing artifact plus controlled geometry changes.",
      "greenfield: no complete design exists; architecture must be chosen.",
      "hybrid: retained legacy interfaces plus free greenfield modules.",
      "convert: STEP/GLB/mesh/format or hierarchy conversion.",
      "release: production-oriented complete engineering workstreams.",
    ],
    parameters: Type.Object({
      workflow: WORKFLOW_ENUM,
      reason: Type.String({ description: "Why this task matches the selected workflow" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await store.load();
      const result = route(state, params.workflow as CadWorkflow, params.reason);
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
      "Commit the current maturity working brief. The harness checks schema and, for baseline workflows, automatically binds and inspects supplied STEP inputs. It does not judge requirement quality.",
    promptSnippet: "Commit the working brief and enter the next workflow phase",
    promptGuidelines: [
      "Do not commit before shared understanding is reached.",
      "For analyze/modify/hybrid/convert, list supplied STEP/STP files in inputs so the harness can bind them as the baseline.",
      "Fully specified quick tasks may commit with zero extra questions.",
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
      inputs: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const record = params as unknown as CadRequirements;
      const result = commitRequirements(state, record);
      if (!result.ok) return errTool(result.reason);
      await store.writeRecord("requirements", record);
      let next = result.state;
      const needsBaseline = ["analyze", "modify", "hybrid", "convert"].includes(next.workflow ?? "");
      const baselineInput = await baselineArtifactCandidate(record, ctx.cwd);
      if (needsBaseline && !baselineInput) {
        return errTool(
          `${next.workflow} workflow requires requirements.inputs[] to reference an existing .step/.stp baseline artifact.`,
        );
      }
      if (baselineInput) {
        const baselineAbs = resolve(ctx.cwd, baselineInput);
        if (!existsSync(baselineAbs)) {
          return errTool(`requirements.inputs references missing artifact: ${baselineInput}`);
        }
        const baseline = await runBaselineAuto(pi, store, next, baselineInput);
        next = baseline.state;
        const text = [
          `Requirements committed. Harness bound baseline artifact ${baselineInput} and auto-inspected it.`,
          ...(baseline.warnings.length ? [`warnings: ${baseline.warnings.join("; ")}`] : []),
          "",
          await loadPrompt(next.phase),
        ].join("\n");
        return { content: [{ type: "text", text }, ...baseline.images], details: { state: next } };
      }
      await persist(pi, store, next, result.events);
      return okTool(
        `Requirements committed (${next.requirementsVersion?.slice(0, 12)}). Harness phase is now ${next.phase.toUpperCase()}.\n\n${await loadPrompt(next.phase)}`,
        { state: next, requirementsVersion: next.requirementsVersion },
      );
    },
  });

  pi.registerTool({
    name: "cad_commit_plan",
    label: "Pi-CAD Commit Plan",
    description:
      "Commit plan/design intent for non-Quick workflows. In release audit states it also records workstream statuses. Harness checks schema and transition; it does not judge plan quality.",
    promptSnippet: "Commit protected interfaces, planned changes, datums, review plan, or release workstream status",
    promptGuidelines: [
      "Use in plan/intent/transform_plan to enter the source phase.",
      "Use in release audit/gap_closure/package to record each workstream as open, complete, not_applicable, or blocked_external.",
    ],
    parameters: Type.Object({
      summary: Type.String(),
      protected: Type.Array(Type.String(), { default: [] }),
      plannedChanges: Type.Array(Type.String(), { default: [] }),
      interfaces: Type.Array(Type.Any(), { default: [] }),
      datums: Type.Array(Type.String(), { default: [] }),
      reviewPlan: Type.Array(Type.String(), { default: [] }),
      architecture: Type.Optional(Type.Array(Type.String())),
      selectionRationale: Type.Optional(Type.String()),
      workstreams: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            status: Type.Enum({
              open: "open",
              complete: "complete",
              not_applicable: "not_applicable",
              blocked_external: "blocked_external",
            }),
          }),
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const record = params as unknown as CadPlan;
      const result = commitPlan(state, record);
      if (!result.ok) return errTool(result.reason);
      await store.writeRecord("plan", record);
      await persist(pi, store, result.state, result.events);
      return okTool(
        `Plan committed (${result.state.planVersion?.slice(0, 12)}). Phase is now ${result.state.phase.toUpperCase()}.\n\n${await loadPrompt(result.state.phase)}`,
        { state: result.state, planVersion: result.state.planVersion },
      );
    },
  });

  pi.registerTool({
    name: "cad_commit_candidate",
    label: "Pi-CAD Commit Candidate",
    description:
      "Commit authored build123d sources. The harness automatically builds STEP, renders views, gathers geometry facts, and for modify/convert also compares against the bound baseline. It enters review (or compare for convert). The harness does not judge the design.",
    promptSnippet: "Commit model source; harness runs build + visual + geometry + optional compare automatically",
    promptGuidelines: [
      "Only call from build, modify, or convert phases.",
      "Write the source first with the normal write tool.",
      "After the result, inspect every returned view and query critical dimensions.",
    ],
    parameters: Type.Object({
      sources: Type.Array(Type.String(), { minItems: 1 }),
      label: Type.String({ minLength: 1 }),
      format: Type.Optional(Type.String({ description: "Required for convert workflow when source is a STEP/STP artifact" })),
      output: Type.Optional(Type.String({ description: "Optional explicit converted output path" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      if (!["build", "modify", "convert"].includes(state.phase)) {
        return errTool(`cad_commit_candidate is only valid in build/modify/convert; current phase is ${state.phase}`);
      }
      const source = params.sources[0];
      const sourceExt = extname(source).toLowerCase();
      if (state.phase === "convert" && [".step", ".stp"].includes(sourceExt)) {
        if (!params.format) {
          return errTool("convert workflow with a STEP/STP source requires format (step, stl, glb, brep) and optional output");
        }
        const sourceAbs = resolve(ctx.cwd, source);
        if (!existsSync(sourceAbs)) return errTool(`candidate source does not exist: ${source}`);
        const sourceHash = await sha256File(sourceAbs);
        const output = params.output ?? join(defaultBuildOutput(ctx.cwd, source).replace(/\.[^.]+$/, ""), `.${params.format}`);
        const exportEnvelope = await exportArtifact(ctx.cwd, { source, output, format: params.format });
        if (!exportEnvelope.ok) {
          return errTool(`Conversion export failed: ${String(exportEnvelope.payload.error ?? "unknown error")}`);
        }
        const outputAbs = artifactPathForKind(exportEnvelope, params.format) ?? output;
        const artifactHash = envelopeArtifactHash(exportEnvelope, params.format) ?? (await sha256File(outputAbs));
        let next = markEvidenceStale(cloneState(state));
        const warnings: string[] = [];
        const events: Array<{ type: string; data?: unknown }> = [
          { type: "ConversionRequested", data: { source, format: params.format, output } },
        ];
        next = addEvidence(next, evidenceFromEnvelope("convert", "cad_export", exportEnvelope, artifactHash, sourceHash));
        events.push({ type: "EvidenceCreated", data: { kind: "convert", artifactHash } });

        const assemblyBefore = await assemblyTree(ctx.cwd, source);
        if (assemblyBefore.ok) {
          next = addEvidence(next, evidenceFromEnvelope("assembly", "cad_assembly_tree", assemblyBefore, sourceHash));
          events.push({ type: "EvidenceCreated", data: { kind: "assembly", artifactHash: sourceHash } });
        } else {
          warnings.push(`source assembly-tree failed: ${String(assemblyBefore.payload.error ?? "unknown")}`);
        }
        if ([".step", ".stp"].includes(extname(outputAbs).toLowerCase())) {
          const assemblyAfter = await assemblyTree(ctx.cwd, outputAbs);
          if (assemblyAfter.ok) {
            next = addEvidence(next, evidenceFromEnvelope("assembly", "cad_assembly_tree", assemblyAfter, artifactHash));
            events.push({ type: "EvidenceCreated", data: { kind: "assembly", artifactHash } });
          } else {
            warnings.push(`converted assembly-tree failed: ${String(assemblyAfter.payload.error ?? "unknown")}`);
          }
          const visualAfter = await inspectVisual(ctx.cwd, outputAbs, defaultVisualEvidenceDir(ctx.cwd, outputAbs));
          if (visualAfter.ok) {
            next = addEvidence(next, evidenceFromEnvelope("visual", "cad_inspect_visual", visualAfter, artifactHash, sourceHash));
            events.push({ type: "EvidenceCreated", data: { kind: "visual", artifactHash } });
          } else {
            warnings.push(`converted visual failed: ${String(visualPayload(visualAfter).error ?? "unknown")}`);
          }
          const geometryAfter = await inspectGeometry(ctx.cwd, outputAbs, defaultGeometryEvidencePath(ctx.cwd, outputAbs));
          if (geometryAfter.ok) {
            next = addEvidence(next, evidenceFromEnvelope("geometry", "cad_inspect_geometry", geometryAfter, artifactHash, sourceHash));
            events.push({ type: "EvidenceCreated", data: { kind: "geometry", artifactHash } });
          } else {
            warnings.push(`converted geometry failed: ${String(geometryPayload(geometryAfter).error ?? "unknown")}`);
          }
          const compareEnv = await compareGeometry(ctx.cwd, source, outputAbs, resolve(ctx.cwd, ".pi-cad", "evidence", "compare", `${params.label.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`));
          if (compareEnv.ok) {
            next = addEvidence(next, evidenceFromEnvelope("compare", "cad_compare_geometry", compareEnv, artifactHash, sourceHash));
            events.push({ type: "EvidenceCreated", data: { kind: "compare", artifactHash } });
          } else {
            warnings.push(`converted compare failed: ${String(compareEnv.payload.error ?? "unknown")}`);
          }
        }
        const accepted = acceptCandidate(
          next,
          { label: params.label, sources: [source], sourceHashes: { [source]: sourceHash }, sourcePath: source, artifactPath: outputAbs },
          artifactHash,
        );
        if (!accepted.ok) return errTool(accepted.reason);
        next = accepted.state;
        events.push(...accepted.events);
        await persist(pi, store, next, events);
        const text = [
          `Conversion candidate ${params.label} committed.`,
          `source=${source} output=${output} format=${params.format}`,
          `artifactHash=${artifactHash.slice(0, 12)}`,
          ...(warnings.length ? [`warnings: ${warnings.join("; ")}`] : []),
          `Phase is ${next.phase.toUpperCase()}.`,
        ].join("\n");
        return { content: [{ type: "text", text }], details: { state: next, envelope: exportEnvelope } };
      }

      const result = await runCandidateAuto(pi, store, state, source, params.label);
      if (!result.ok) return errTool(result.text ?? "candidate failed", result.details);
      return {
        content: [{ type: "text", text: result.text ?? "" }, ...(result.images ?? [])],
        details: result.details,
      };
    },
  });

  pi.registerTool({
    name: "cad_transition",
    label: "Pi-CAD Transition",
    description:
      "Express an explicit workflow transition. The harness validates only procedural guards: current evidence, file existence, artifact hashes, and workflow-specific transition legality.",
    promptSnippet: "Move the current workflow with an explicit transition event",
    promptGuidelines: [
      "accepted requires you have personally interpreted current evidence.",
      "revise/local_geometry_issue return to the source phase.",
      "intent_issue/architecture_issue return to plan/intent or concept.",
      "baseline_understood requires current baseline visual and geometry evidence.",
      "release accepted requires all workstream statuses to be complete/not_applicable/blocked_external.",
    ],
    parameters: Type.Object({
      event: Type.String(),
      note: Type.String({ description: "Engineering reason and checks performed" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");

      if (params.event === "accepted" && (state.phase === "review" || state.phase === "compare")) {
        const verification = await verifyCurrentArtifacts(ctx.cwd, state);
        if (verification) return errTool(`cannot accept: ${verification}`);
        const kinds: EvidenceRef["kind"][] = (() => {
          if (state.workflow === "modify") return ["visual", "geometry", "compare"];
          if (state.workflow === "convert") {
            return /\.(step|stp)$/i.test(state.currentArtifactPath ?? "")
              ? ["visual", "geometry", "compare"]
              : ["convert"];
          }
          return ["visual", "geometry"];
        })();
        const evidenceVerification = state.currentArtifactHash
          ? verifyEvidenceFilesForHash(ctx.cwd, state, state.currentArtifactHash, kinds)
          : "current artifact hash is not bound";
        if (evidenceVerification) return errTool(`cannot accept: ${evidenceVerification}`);
      }
      if (params.event === "accepted" && state.phase === "final_review" && state.workflow === "release") {
        const closed = releaseWorkstreamsClosed(state);
        if (closed) return errTool(`cannot accept: ${closed}`);
      }
      if (params.event === "baseline_understood" && (state.phase === "baseline" || state.phase === "source_baseline")) {
        if (state.baselineArtifactHash) {
          const verification = verifyEvidenceFilesForHash(ctx.cwd, state, state.baselineArtifactHash, ["visual", "geometry"]);
          if (verification) return errTool(`cannot leave baseline: ${verification}`);
        }
      }

      const result = transition(state, params.event, params.note);
      if (!result.ok) return errTool(result.reason);
      await persist(pi, store, result.state, result.events);
      return okTool(
        `Transition ${params.event} accepted. Phase is now ${result.state.phase.toUpperCase()}.\n\n${await loadPrompt(result.state.phase)}`,
        { state: result.state },
      );
    },
  });

  pi.registerTool({
    name: "cad_wait_for_user",
    label: "Pi-CAD Wait for User",
    description:
      "Pause the workflow for a user decision. The harness records the phase and reason; the next user turn restores the same phase.",
    promptSnippet: "Pause the workflow for a required user decision",
    promptGuidelines: [
      "Use only when a missing decision materially affects the design and cannot be resolved from files or tools.",
      "Ask one decision per pause and give your recommended answer.",
    ],
    parameters: Type.Object({
      reason: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const result = waitForUser(state, params.reason);
      if (!result.ok) return errTool(result.reason);
      await persist(pi, store, result.state, result.events);
      return okTool(
        `Workflow paused in ${result.state.phase}. Waiting for the user decision.\nReason: ${params.reason}`,
        { state: result.state },
      );
    },
  });

  pi.registerTool({
    name: "cad_finish",
    label: "Pi-CAD Finish",
    description:
      "Request workflow closure. The harness verifies READY phase, current source/artifact files, current-version evidence, and release workstream statuses. It does not judge design quality.",
    promptSnippet: "Close the workflow after Ready",
    promptGuidelines: ["Only call after cad_transition(accepted) and delivery."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const verification = await verifyCurrentArtifacts(ctx.cwd, state);
      if (verification) return errTool(`cad_finish blocked: ${verification}`);
      if (state.workflow === "analyze" && state.baselineArtifactHash) {
        const evidenceVerification = verifyEvidenceFilesForHash(ctx.cwd, state, state.baselineArtifactHash, ["visual", "geometry"]);
        if (evidenceVerification) return errTool(`cad_finish blocked: ${evidenceVerification}`);
      } else if (state.currentArtifactHash) {
        const kinds: EvidenceRef["kind"][] = (() => {
          if (state.workflow === "modify") return ["visual", "geometry", "compare"];
          if (state.workflow === "convert") {
            return /\.(step|stp)$/i.test(state.currentArtifactPath ?? "")
              ? ["visual", "geometry", "compare"]
              : ["convert"];
          }
          return ["visual", "geometry"];
        })();
        const evidenceVerification = verifyEvidenceFilesForHash(ctx.cwd, state, state.currentArtifactHash, kinds);
        if (evidenceVerification) return errTool(`cad_finish blocked: ${evidenceVerification}`);
      }
      const result = finish(state);
      if (!result.ok) return errTool(result.reason);
      await persist(pi, store, result.state, result.events);
      return okTool(
        `Workflow ${result.state.workflow} finished. taskId=${result.state.taskId}. Deliver evidence-version-consistent source and artifacts.`,
        { state: result.state },
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const store = new ProjectStateStore(ctx.cwd);
    let state = await store.load();
    if (state && state.status === "waiting_user") {
      state = resumeFromUser(state);
      await persist(pi, store, state, [{ type: "UserInputResolved", data: { phase: state.phase } }]);
    }
    if (state && state.status !== "done" && state.status !== "aborted") {
      pi.setActiveTools(toolsForPhase(state.phase));
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${await composeSystemPrompt("", state && state.status !== "done" && state.status !== "aborted" ? state : null)}`,
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
        if (!check.allowed) return { block: true, reason: `Pi-CAD ${state.mutationPolicy}: ${check.reason}` };
      }
    }
    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      if (state.mutationPolicy === "read_only" && input.command && isMutatingBash(input.command)) {
        return { block: true, reason: `Pi-CAD read_only: mutating bash command blocked (${input.command.slice(0, 80)})` };
      }
    }
    if (state.mutationPolicy === "read_only" && (event.toolName === "cad_build_step" || event.toolName === "cad_export")) {
      return { block: true, reason: "Pi-CAD read_only: mutation tools require a source phase" };
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
    if (!["build", "modify", "convert", "review", "compare"].includes(state.phase)) return;
    if (state.status !== "active") return;
    const key = `${state.taskId}:${state.phase}:${state.currentSourceHash ?? "none"}:${state.currentArtifactHash ?? "none"}`;
    if (nudgedVersions.has(key)) return;
    nudgedVersions.add(key);
    pi.sendUserMessage(
      `Pi-CAD workflow is still in ${state.phase.toUpperCase()} (${stateSummary(state)}). Continue with the next explicit cad_* action.`,
      { deliverAs: "followUp" },
    );
  });
}
