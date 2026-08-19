import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { Type } from "typebox";

import {
  type CadPlan,
  type CadRequirements,
  type CadRunState,
  type EvidenceRef,
  type Route,
  isRoute,
  routeKey,
} from "../shared/protocol.ts";
import { CadProjectStore } from "../shared/store.ts";
import { workflowSpec } from "./state-machine.ts";
import {
  commitPhaseRecord,
  commitPlan,
  commitRequirements,
  createIntakeState,
  finish,
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
    store: CadProjectStore,
    state: CadRunState,
    artifactRel: string,
    persist: PersistFn,
  ) => Promise<{ state: CadRunState; images: Array<{ type: "image"; data: string; mimeType: string }>; warnings: string[] }>;
  runCandidateAuto: (
    pi: ExtensionAPI,
    store: CadProjectStore,
    state: CadRunState,
    source: string,
    label: string,
    persist: PersistFn,
  ) => Promise<{ ok: boolean; text?: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; details?: unknown }>;
  runConvertCandidateAuto: (
    pi: ExtensionAPI,
    store: CadProjectStore,
    state: CadRunState,
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

async function guardState(store: CadProjectStore): Promise<CadRunState | null> {
  const state = await store.load();
  if (!state || state.status === "done" || state.status === "aborted") return null;
  return state;
}

async function baselineArtifactCandidate(
  record: CadRequirements,
  cwd: string,
  store: CadProjectStore,
): Promise<string | null> {
  const input = (record.inputs ?? []).find((item) => /\.(step|stp)$/i.test(item));
  if (input) return input;
  const project = await store.loadProject();
  const head = project?.head.artifactPath;
  return head && /\.(step|stp)$/i.test(head) ? head : null;
}

function acceptedEvidenceKinds(state: CadRunState): EvidenceRef["kind"][] {
  const spec = workflowSpec(state);
  return spec?.acceptedEvidence(state) ?? ["visual", "geometry"];
}

/**
 * Route parameter schemas. Cross-field rules are enforced fail-closed in the
 * backend after structural validation: objective=design requires the full
 * tuple, analyze/convert must not carry it.
 */
const RouteParamsSchema = Type.Object(
  {
    objective: Type.Enum({ analyze: "analyze", convert: "convert", design: "design" }),
    lineage: Type.Optional(Type.Enum({ greenfield: "greenfield", legacy: "legacy", hybrid: "hybrid" })),
    structure: Type.Optional(Type.Enum({ part: "part", assembly: "assembly" })),
    maturity: Type.Optional(
      Type.Enum({
        prototype: "prototype",
        engineering: "engineering",
        manufacturing: "manufacturing",
        release: "release",
      }),
    ),
    reason: Type.String({ description: "Why this route matches the task, decided level by level" }),
  },
  { additionalProperties: false },
);

/**
 * Strict evidence-obligations schema, shared by requirements and plan.
 *
 * additionalProperties: false at EVERY level: a typo like "casez" must fail
 * closed at the tool boundary. Silently dropping it would degrade a
 * case-scoped obligation back to the legacy "any simulation evidence
 * satisfies required" semantics.
 */
const SimulationCaseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    tool: Type.Enum({
      cad_simulate: "cad_simulate",
      cad_simulate_flow: "cad_simulate_flow",
      cad_simulate_thermal: "cad_simulate_thermal",
    }),
  },
  { additionalProperties: false },
);

const EvidenceObligationsSchema = Type.Object(
  {
    simulation: Type.Optional(
      Type.Object(
        {
          disposition: Type.Enum({
            required: "required",
            optional: "optional",
            not_applicable: "not_applicable",
            blocked_external: "blocked_external",
          }),
          rationale: Type.Optional(Type.String()),
          cases: Type.Optional(
            Type.Array(SimulationCaseSchema, {
              minItems: 1,
              description:
                "Opaque simulation cases: the harness only checks that each interpreter invocation produced current-version evidence; it never interprets what a case means",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * Fail-closed cross-field validation of route params: design requires the
 * full tuple, analyze/convert must not carry any of it. Returns the Route
 * or an error string.
 */
function buildRoute(
  params: Record<string, string | undefined>,
): Route | string {
  const { objective, lineage, structure, maturity } = params;
  if (objective === "analyze" || objective === "convert") {
    if (lineage !== undefined || structure !== undefined || maturity !== undefined) {
      return `${objective} routes take no lineage/structure/maturity; those belong to objective=design`;
    }
    return { objective } as Route;
  }
  if (objective !== "design") return `unsupported objective: ${objective}`;
  if (!lineage || !structure || !maturity) {
    return "objective=design requires lineage, structure, and maturity together";
  }
  return { objective: "design", lineage, structure, maturity } as Route;
}

/**
 * Assembly design record (whitepaper 7.3): the four architecture questions.
 * Strict at every level — unknown fields fail closed at the tool boundary.
 */
const AssemblyDesignRecordSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
    modules: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1 }),
          purpose: Type.String({ minLength: 1 }),
          envelopeMm: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number()])),
          notes: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, description: "An assembly has at least two modules" },
    ),
    datums: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1 }),
          kind: Type.Enum({ primary: "primary", secondary: "secondary", tertiary: "tertiary" }),
          definedBy: Type.String({ minLength: 1, description: "Physical features that realize this datum" }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    sequence: Type.Array(
      Type.Object(
        {
          step: Type.Number(),
          installs: Type.Array(Type.String(), { minItems: 1 }),
          notes: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, description: "Install order; each step names the modules it installs" },
    ),
    envelopes: Type.Optional(
      Type.Array(
        Type.Object(
          {
            module: Type.String(),
            bboxMm: Type.Tuple([
              Type.Number(),
              Type.Number(),
              Type.Number(),
              Type.Number(),
              Type.Number(),
              Type.Number(),
            ]),
            massKg: Type.Optional(Type.Number()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * Interface contracts record (whitepaper 7.4): one entry per A↔B pair with
 * the ten contract items.
 */
const InterfaceContractsRecordSchema = Type.Object(
  {
    contracts: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          a: Type.String({ minLength: 1, description: "Module on side A" }),
          b: Type.String({ minLength: 1, description: "Module on side B" }),
          purpose: Type.String({ minLength: 1 }),
          locating: Type.String({ minLength: 1, description: "Locating scheme: which features/datums locate A against B" }),
          dof: Type.String({ minLength: 1, description: "Which degrees of freedom the interface constrains" }),
          fasteners: Type.String({ minLength: 1, description: "Fastener plan (type, size, count) or 'none/integral'" }),
          fits: Type.String({ minLength: 1, description: "Fits and tolerances at the locating features" }),
          assemblyDirection: Type.String({ minLength: 1, description: "Direction the parts approach along" }),
          toolAccess: Type.String({ minLength: 1, description: "Tool access for fastening/inspection" }),
          notes: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export function registerControlTools(pi: ExtensionAPI, deps: ControllerDeps): void {
  pi.registerTool({
    name: "cad_route",
    label: "Pi-CAD Route",
    description:
      "Route the current CAD task by its hierarchical description: objective (analyze/convert/design), and for design the lineage, structure, and maturity. The harness compiles the process from the route; there is no shortcut past obligations.",
    promptSnippet: "Choose the route: objective → lineage → structure → maturity, in one call",
    promptGuidelines: [
      "Call cad_route from intake before any CAD mutation.",
      "Decide the full hierarchy in one turn: objective first, then (design only) lineage, structure, maturity.",
      "objective=analyze: read-only diagnosis and explanation of an existing artifact.",
      "objective=convert: STEP/GLB/mesh/format or hierarchy conversion.",
      "objective=design: lineage greenfield (nothing exists yet) / legacy (change a complete existing design) / hybrid (retained legacy interfaces plus free new modules).",
      "structure=assembly whenever the deliverable is more than one part; maturity is the reality floor (prototype is still REAL/BUILDABLE/FUNCTIONAL).",
    ],
    parameters: RouteParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      await store.migrate();
      const project = await store.ensureProject();
      let state = await store.load();
      const nextRoute: Route = buildRoute(params);
      if (typeof nextRoute === "string") return errTool(nextRoute);
      if (!isRoute(nextRoute)) return errTool("invalid route");
      if (!state) {
        const existingRunId = await store.currentRunId();
        const run = existingRunId
          ? store.run(existingRunId)
          : await store.createRun();
        await run.ensureDirs();
        state = createIntakeState({
          runId: run.runId,
          projectId: project.projectId,
        });
        const head = project.head;
        if (head.artifactPath) {
          state = {
            ...state,
            baselineSourcePath: head.sourcePath,
            baselineSourceHash: head.sourceHash,
            baselineArtifactPath: head.artifactPath,
            baselineArtifactHash: head.artifactHash,
          };
        }
        if (nextRoute.objective === "design" && nextRoute.maturity === "release" && head.artifactPath) {
          state = {
            ...state,
            currentSourcePath: head.sourcePath,
            currentSourceHash: head.sourceHash,
            currentArtifactPath: head.artifactPath,
            currentArtifactHash: head.artifactHash,
          };
        }
        await run.save(state);
        await run.appendEvent("RunStarted", { runId: run.runId, projectId: project.projectId });
      }
      const result = route(state, nextRoute, params.reason);
      if (!result.ok) return errTool(result.reason);
      await deps.persist(pi, store, result.state, result.events);
      return okTool(
        `Routed to ${routeKey(nextRoute)}. Harness state is now authoritative.\n\n${await loadPrompt("requirements")}`,
        { state: result.state },
      );
    },
  });

  pi.registerTool({
    name: "cad_commit_requirements",
    label: "Pi-CAD Commit Requirements",
    description:
      "Commit the working brief. Maturity lives on the route, not here. For baseline-binding routes the harness automatically binds and inspects supplied STEP inputs.",
    promptSnippet: "Commit the working brief and enter the next process phase",
    promptGuidelines: [
      "Do not commit before shared understanding is reached.",
      "For legacy/hybrid lineages, analyze, and convert, list supplied STEP/STP files in inputs.",
      "Fully specified greenfield part tasks may commit with zero extra questions.",
      "Physical CAD tasks default to REAL/BUILDABLE/FUNCTIONAL; only commit a mockup brief after the user explicitly downgraded maturity.",
    ],
    parameters: Type.Object({
      goal: Type.String(),
      deliverables: Type.Array(Type.String(), { minItems: 1 }),
      must: Type.Array(Type.String(), { default: [] }),
      preferences: Type.Array(Type.String(), { default: [] }),
      assumptions: Type.Array(Type.String(), { default: [] }),
      openUnknowns: Type.Array(Type.String(), { default: [] }),
      inputs: Type.Optional(Type.Array(Type.String())),
      evidenceObligations: Type.Optional(EvidenceObligationsSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const record = params as unknown as CadRequirements;
      const result = commitRequirements(state, record);
      if (!result.ok) return errTool(result.reason);
      await store.writeRecord("requirements", record);
      let next = result.state;
      const spec = workflowSpec(next);
      const baselineInput = await baselineArtifactCandidate(record, ctx.cwd, store);
      if (spec?.requiresBaselineInput && !baselineInput) {
        return errTool(
          `${next.route ? routeKey(next.route) : "route"} requires requirements.inputs[] to reference an existing .step/.stp baseline artifact.`,
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
      "Use in part_design/plan/transform_plan to enter the source phase.",
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
      evidenceObligations: Type.Optional(EvidenceObligationsSchema),
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
      const store = new CadProjectStore(ctx.cwd);
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
    name: "cad_commit_assembly_design",
    label: "Pi-CAD Commit Assembly Design",
    description:
      "Commit the assembly design record (modules, datums, sequence, envelopes) and move from assembly_design to interface_design. This record is an obligation of assembly routes; there is no transition that skips it.",
    promptSnippet: "Commit the assembly architecture record",
    promptGuidelines: [
      "Answer all four architecture questions before committing: modules, datums, assembly sequence, envelopes.",
      "The record is the design's skeleton — later interface contracts and parts are checked against it.",
    ],
    parameters: AssemblyDesignRecordSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const result = commitPhaseRecord(state, "assembly_design", params);
      if (!result.ok) return errTool(result.reason);
      await store.writeRecord("assembly_design", params);
      await deps.persist(pi, store, result.state, result.events);
      return okTool(
        `Assembly design committed (${result.state.phaseRecords?.length ?? 0} phase records). Phase is now ${result.state.phase.toUpperCase()}.\n\n${await loadPrompt(result.state.phase)}`,
        { state: result.state },
      );
    },
  });

  pi.registerTool({
    name: "cad_commit_interface_contracts",
    label: "Pi-CAD Commit Interface Contracts",
    description:
      "Commit the A↔B interface contracts (locating, DOF, fasteners, fits, direction, tool access) and move from interface_design to part_design. Obligatory for assembly routes at engineering maturity and above.",
    promptSnippet: "Commit the interface contract records",
    promptGuidelines: [
      "One contract per interface pair, with locating scheme and constrained DOF stated explicitly.",
      "Interfaces must name the assembly datum each side locates against.",
    ],
    parameters: InterfaceContractsRecordSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const result = commitPhaseRecord(state, "interface_contracts", params);
      if (!result.ok) return errTool(result.reason);
      await store.writeRecord("interface_contracts", params);
      await deps.persist(pi, store, result.state, result.events);
      return okTool(
        `Interface contracts committed (${params.contracts.length} pairs). Phase is now ${result.state.phase.toUpperCase()}.\n\n${await loadPrompt(result.state.phase)}`,
        { state: result.state },
      );
    },
  });

  pi.registerTool({
    name: "cad_commit_candidate",
    label: "Pi-CAD Commit Candidate",
    description:
      "Commit authored build123d sources, or a STEP conversion in convert routes. The harness runs build/visual/geometry/assembly/compare automatically.",
    promptSnippet: "Commit model source or conversion; harness observes and binds evidence automatically",
    promptGuidelines: [
      "Call only when the current phase exposes cad_commit_candidate as an active tool.",
      "In convert routes with STEP/STP source, provide format and optional output.",
      "In release gap_closure, commit the revised engineering source; the harness compares against the project head automatically.",
    ],
    parameters: Type.Object({
      sources: Type.Array(Type.String(), { minItems: 1 }),
      label: Type.String({ minLength: 1 }),
      format: Type.Optional(Type.String()),
      output: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const source = params.sources[0];
      const sourceExt = extname(source).toLowerCase();
      if (
        state.phase === "convert" &&
        [".step", ".stp"].includes(sourceExt)
      ) {
        if (!params.format) {
          return errTool("convert route with a STEP/STP source requires format (step, stl, glb, brep) and optional output");
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
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");

      const spec = workflowSpec(state);
      if (params.event === "accepted" && spec?.acceptedPhases.includes(state.phase)) {
        const verification = await verifyCurrentArtifacts(ctx.cwd, state);
        if (verification) return errTool(`cannot accept: ${verification}`);
        if (!state.currentArtifactHash) {
          return errTool("cannot accept: current artifact hash is not bound");
        }
        const evidenceVerification = await verifyEvidenceFilesForHash(
          ctx.cwd,
          state,
          state.currentArtifactHash,
          acceptedEvidenceKinds(state),
        );
        if (evidenceVerification) return errTool(`cannot accept: ${evidenceVerification}`);
        if (state.evidenceObligations?.simulation?.disposition === "required") {
          const simVerification = await verifyEvidenceFilesForHash(
            ctx.cwd,
            state,
            state.currentArtifactHash,
            ["simulation"],
          );
          if (simVerification) return errTool(`cannot accept: ${simVerification}`);
        }
        const guard = spec.completionGuard?.(state);
        if (guard) return errTool(`cannot accept: ${guard}`);
      }
      if (
        params.event === "baseline_understood" &&
        (state.phase === "baseline" || state.phase === "source_baseline") &&
        state.baselineArtifactHash
      ) {
        const verification = await verifyEvidenceFilesForHash(
          ctx.cwd,
          state,
          state.baselineArtifactHash,
          ["visual", "geometry"],
        );
        if (verification) return errTool(`cannot leave baseline: ${verification}`);
      }

      const result = transition(state, params.event, params.note);
      if (!result.ok) return errTool(result.reason);
      if (
        params.event === "accepted" &&
        spec?.updatesHeadOnAccept &&
        result.state.currentArtifactPath &&
        result.state.currentArtifactHash &&
        /\.(step|stp)$/i.test(result.state.currentArtifactPath)
      ) {
        await store.updateHead({
          sourcePath: result.state.currentSourcePath,
          sourceHash: result.state.currentSourceHash,
          artifactPath: store.relative(result.state.currentArtifactPath),
          artifactHash: result.state.currentArtifactHash,
          evidence: result.state.evidence,
        });
      }
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
      const store = new CadProjectStore(ctx.cwd);
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
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const verification = await verifyCurrentArtifacts(ctx.cwd, state);
      if (verification) return errTool(`cad_finish blocked: ${verification}`);
      const spec = workflowSpec(state);
      if (state.route?.objective === "analyze" && state.baselineArtifactHash) {
        const analyzeKinds: EvidenceRef["kind"][] =
          state.evidenceObligations?.simulation?.disposition === "required"
            ? ["visual", "geometry", "simulation"]
            : ["visual", "geometry"];
        const evidenceVerification = await verifyEvidenceFilesForHash(
          ctx.cwd,
          state,
          state.baselineArtifactHash,
          analyzeKinds,
        );
        if (evidenceVerification) return errTool(`cad_finish blocked: ${evidenceVerification}`);
      } else if (state.currentArtifactHash) {
        const evidenceVerification = await verifyEvidenceFilesForHash(
          ctx.cwd,
          state,
          state.currentArtifactHash,
          spec?.finishEvidence(state) ?? ["visual", "geometry"],
        );
        if (evidenceVerification) return errTool(`cad_finish blocked: ${evidenceVerification}`);
        if (state.evidenceObligations?.simulation?.disposition === "required") {
          const simVerification = await verifyEvidenceFilesForHash(
            ctx.cwd,
            state,
            state.currentArtifactHash,
            ["simulation"],
          );
          if (simVerification) return errTool(`cad_finish blocked: ${simVerification}`);
        }
      }
      const result = finish(state);
      if (!result.ok) return errTool(result.reason);
      await deps.persist(pi, store, result.state, result.events);
      await store.setCurrentRun(null);
      return okTool(
        `Run ${result.state.runId} (${result.state.route ? routeKey(result.state.route) : "unset"}) finished. Project head is unchanged unless this run accepted a new candidate.`,
        { state: result.state },
      );
    },
  });
}
