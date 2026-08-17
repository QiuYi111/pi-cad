import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { Type } from "typebox";

import {
  ALL_WORKFLOWS,
  type CadPlan,
  type CadProjectState,
  type CadRequirements,
  type CadWorkflow,
  type EvidenceRef,
} from "../shared/protocol.ts";
import { ProjectStateStore } from "../shared/store.ts";
import { workflowSpec } from "./state-machine.ts";
import {
  commitPlan,
  commitRequirements,
  finish,
  releaseWorkstreamsClosed,
  resumeFromUser,
  route,
  transition,
  waitForUser,
} from "./state-machine.ts";
import { loadPrompt } from "./context.ts";
import { verifyCurrentArtifacts, verifyEvidenceFilesForHash } from "./evidence.ts";
import type { PersistFn } from "./auto-actions.ts";

export interface ControllerDeps {
  pi: ExtensionAPI;
  persist: PersistFn;
  runBaselineAuto: (
    pi: ExtensionAPI,
    store: ProjectStateStore,
    state: CadProjectState,
    artifactRel: string,
    persist: PersistFn,
  ) => Promise<{ state: CadProjectState; images: Array<{ type: "image"; data: string; mimeType: string }>; warnings: string[] }>;
  runCandidateAuto: (
    pi: ExtensionAPI,
    store: ProjectStateStore,
    state: CadProjectState,
    source: string,
    label: string,
    persist: PersistFn,
  ) => Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }>;
  runConvertCandidateAuto: (
    pi: ExtensionAPI,
    store: ProjectStateStore,
    state: CadProjectState,
    source: string,
    label: string,
    format: string,
    output: string,
    persist: PersistFn,
  ) => Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }>;
}

function okTool(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function errTool(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

async function guardState(store: ProjectStateStore): Promise<CadProjectState | null> {
  const state = await store.load();
  if (!state || state.status === "done" || state.status === "aborted") return null;
  return state;
}

async function baselineArtifactCandidate(
  record: CadRequirements,
  cwd: string,
): Promise<string | null> {
  return (
    (record.inputs ?? []).find((input) => /\.(step|stp)$/i.test(input)) ?? null
  );
}

function acceptedEvidenceKinds(state: CadProjectState): EvidenceRef["kind"][] {
  const spec = workflowSpec(state);
  return spec?.acceptedEvidence(state) ?? ["visual", "geometry"];
}

const WORKFLOW_ENUM = Type.Enum(
  Object.fromEntries(ALL_WORKFLOWS.map((wf) => [wf, wf])) as Record<CadWorkflow, CadWorkflow>,
);

export function registerControlTools(pi: ExtensionAPI, deps: ControllerDeps): void {
  pi.registerTool({
    name: "cad_route",
    label: "Pi-CAD Route",
    description:
      "Route the current CAD task into one of seven workflows. Routing is the Agent's semantic decision; the harness only validates the route name.",
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
      await deps.persist(pi, store, result.state, result.events);
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
      "Commit the current maturity working brief. For baseline workflows the harness automatically binds and inspects supplied STEP inputs.",
    promptSnippet: "Commit the working brief and enter the next workflow phase",
    promptGuidelines: [
      "Do not commit before shared understanding is reached.",
      "For analyze/modify/hybrid/convert, list supplied STEP/STP files in inputs.",
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
      const spec = workflowSpec(next);
      const baselineInput = await baselineArtifactCandidate(record, ctx.cwd);
      if (spec?.requiresBaselineInput && !baselineInput) {
        return errTool(
          `${next.workflow} workflow requires requirements.inputs[] to reference an existing .step/.stp baseline artifact.`,
        );
      }
      if (baselineInput) {
        const baselineAbs = resolve(ctx.cwd, baselineInput);
        if (!existsSync(baselineAbs)) {
          return errTool(`requirements.inputs references missing artifact: ${baselineInput}`);
        }
        const baseline = await deps.runBaselineAuto(pi, store, next, baselineInput, deps.persist);
        next = baseline.state;
        const text = [
          `Requirements committed. Harness bound baseline artifact ${baselineInput} and auto-inspected it.`,
          ...(baseline.warnings.length ? [`warnings: ${baseline.warnings.join("; ")}`] : []),
          "",
          await loadPrompt(next.phase),
        ].join("\n");
        return { content: [{ type: "text", text }, ...baseline.images], details: { state: next } };
      }
      await deps.persist(pi, store, next, result.events);
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
      "Commit plan/design intent, or record release workstream statuses. The harness checks schema and transition only.",
    promptSnippet: "Commit protected interfaces, planned changes, datums, review plan, or release workstream status",
    promptGuidelines: [
      "Use in plan/intent/transform_plan to enter the source phase.",
      "Use in release audit/gap_closure/package to record workstream statuses.",
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
      await deps.persist(pi, store, result.state, result.events);
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
      "Commit authored build123d sources, or a STEP conversion in convert workflow. The harness runs build/visual/geometry/compare automatically.",
    promptSnippet: "Commit model source or conversion; harness observes and binds evidence automatically",
    promptGuidelines: [
      "Only call from build, modify, or convert phases.",
      "In convert workflow with STEP/STP source, provide format and optional output.",
    ],
    parameters: Type.Object({
      sources: Type.Array(Type.String(), { minItems: 1 }),
      label: Type.String({ minLength: 1 }),
      format: Type.Optional(Type.String()),
      output: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const source = params.sources[0];
      const sourceExt = extname(source).toLowerCase();
      if (
        state.phase === "convert" &&
        [".step", ".stp"].includes(sourceExt)
      ) {
        if (!params.format) {
          return errTool("convert workflow with a STEP/STP source requires format (step, stl, glb, brep) and optional output");
        }
        const output =
          params.output ??
          `${source.replace(/\.(step|stp)$/i, "")}.${params.format}`;
        const result = await deps.runConvertCandidateAuto(
          pi,
          store,
          state,
          source,
          params.label,
          params.format,
          output,
          deps.persist,
        );
        if (!result.ok) return errTool(result.text ?? "conversion failed", result.details);
        return {
          content: [{ type: "text", text: result.text ?? "" }, ...(result.images ?? [])],
          details: result.details,
        };
      }
      const result = await deps.runCandidateAuto(pi, store, state, source, params.label, deps.persist);
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
      "Express an explicit workflow transition. Harness validates only procedural guards and workflow transition legality.",
    promptSnippet: "Move the current workflow with an explicit transition event",
    promptGuidelines: [
      "accepted requires you have personally interpreted current evidence.",
      "baseline_understood requires bound baseline visual and geometry evidence.",
      "release accepted requires all workstream statuses to be complete/not_applicable/blocked_external.",
    ],
    parameters: Type.Object({
      event: Type.String(),
      note: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");

      const spec = workflowSpec(state);
      if (params.event === "accepted" && spec?.acceptedPhases.includes(state.phase)) {
        if (state.workflow === "release" && state.phase === "final_review") {
          const closed = releaseWorkstreamsClosed(state);
          if (closed) return errTool(`cannot accept: ${closed}`);
        } else {
          const verification = await verifyCurrentArtifacts(ctx.cwd, state);
          if (verification) return errTool(`cannot accept: ${verification}`);
          if (!state.currentArtifactHash) return errTool("cannot accept: current artifact hash is not bound");
          const evidenceVerification = verifyEvidenceFilesForHash(
            ctx.cwd,
            state,
            state.currentArtifactHash,
            acceptedEvidenceKinds(state),
          );
          if (evidenceVerification) return errTool(`cannot accept: ${evidenceVerification}`);
        }
      }
      if (
        params.event === "baseline_understood" &&
        (state.phase === "baseline" || state.phase === "source_baseline") &&
        state.baselineArtifactHash
      ) {
        const verification = verifyEvidenceFilesForHash(
          ctx.cwd,
          state,
          state.baselineArtifactHash,
          ["visual", "geometry"],
        );
        if (verification) return errTool(`cannot leave baseline: ${verification}`);
      }

      const result = transition(state, params.event, params.note);
      if (!result.ok) return errTool(result.reason);
      await deps.persist(pi, store, result.state, result.events);
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
      "Pause the workflow for a user decision. The next user turn restores the same phase.",
    promptSnippet: "Pause the workflow for a required user decision",
    promptGuidelines: ["Ask one decision per pause and give your recommended answer."],
    parameters: Type.Object({ reason: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const result = waitForUser(state, params.reason);
      if (!result.ok) return errTool(result.reason);
      await deps.persist(pi, store, result.state, result.events);
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
      "Request workflow closure. Harness verifies READY, files, evidence, and release workstreams. It does not judge design quality.",
    promptSnippet: "Close the workflow after Ready",
    promptGuidelines: ["Only call after cad_transition(accepted) and delivery."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const store = new ProjectStateStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const verification = await verifyCurrentArtifacts(ctx.cwd, state);
      if (verification) return errTool(`cad_finish blocked: ${verification}`);
      const spec = workflowSpec(state);
      if (state.workflow === "analyze" && state.baselineArtifactHash) {
        const evidenceVerification = verifyEvidenceFilesForHash(
          ctx.cwd,
          state,
          state.baselineArtifactHash,
          ["visual", "geometry"],
        );
        if (evidenceVerification) return errTool(`cad_finish blocked: ${evidenceVerification}`);
      } else if (state.currentArtifactHash) {
        const evidenceVerification = verifyEvidenceFilesForHash(
          ctx.cwd,
          state,
          state.currentArtifactHash,
          spec?.finishEvidence(state) ?? ["visual", "geometry"],
        );
        if (evidenceVerification) return errTool(`cad_finish blocked: ${evidenceVerification}`);
      }
      const result = finish(state);
      if (!result.ok) return errTool(result.reason);
      await deps.persist(pi, store, result.state, result.events);
      return okTool(
        `Workflow ${result.state.workflow} finished. taskId=${result.state.taskId}. Deliver evidence-version-consistent source and artifacts.`,
        { state: result.state },
      );
    },
  });
}
