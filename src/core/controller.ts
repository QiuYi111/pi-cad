import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";

import {
  type CadPlan,
  type CadRequirements,
  type CadRunState,
  type EvidenceRef,
  type FinalReviewRef,
  type Route,
  isRoute,
  routeKey,
} from "../shared/protocol.ts";
import { CadProjectStore, hashRecord, nowIso, sha256File } from "../shared/store.ts";
import { workflowSpec } from "./state-machine.ts";
import {
  commitPhaseRecord,
  commitPlan,
  commitRequirements,
  createIntakeState,
  finish,
  deferClarification,
  declareHeadlessBlocker,
  reroute,
  reviseRequirements,
  route,
  transition,
  validateRequirementsRecord,
  waitForUser,
} from "./state-machine.ts";
import { loadPrompt } from "./context.ts";
import { verifyCurrentArtifacts, verifyEvidenceFilesForHash, verifyPresentationDeliverables } from "./evidence.ts";
import type { PersistFn } from "./auto-actions.ts";
import { runFinalReviewPreflight } from "../control/final-review/preflight.ts";
import { REVIEWER_PROMPT_VERSION, freshReviewerRunner, type ReviewerRunner } from "../control/final-review/reviewer.ts";
import { collectReviewerEvidenceIndex } from "../control/final-review/evidence-index.ts";
import {
  aggregateReviewVotes,
  type StoredReviewVote,
} from "../control/final-review/voting.ts";
import { finalReviewerEnabled, finalSubmissionAllowed } from "./policies.ts";
import {
  interactionModeFromEnvironment,
  isHeadless,
  isTerminalStatus,
} from "./interaction-mode.ts";

/** Route a failed closure review through the process's existing editable regression edge. */
function regressFinalReview(state: CadRunState, note: string) {
  for (const event of ["revise", "repair", "engineering_issue", "artifact_issue"]) {
    const result = transition(state, event, note);
    if (result.ok) return result;
  }
  return null;
}

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
  reviewerRunner?: ReviewerRunner;
}

function okTool(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function errTool(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

async function guardState(store: CadProjectStore): Promise<CadRunState | null> {
  const state = await store.load();
  if (!state || isTerminalStatus(state.status)) return null;
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

async function loadCurrentRequirements(store: CadProjectStore, state: CadRunState): Promise<CadRequirements | null> {
  if (state.requirementsVersion) {
    try {
      return await store.readRequirementsVersion<CadRequirements>(state.requirementsVersion);
    } catch {
      return null;
    }
  }
  const run = store.run(state.runId);
  try {
    return JSON.parse(await readFile(join(run.recordsDir, "requirements.json"), "utf-8")) as CadRequirements;
  } catch {
    return null;
  }
}

function validateInputDeclarations(record: CadRequirements, cwd: string): string | null {
  for (const [index, input] of (record.inputs ?? []).entries()) {
    if (typeof input !== "string" || !input.trim()) return `requirements.inputs[${index}] must be a non-empty path`;
    if (!/\.(step|stp)$/i.test(input)) {
      return `requirements.inputs[${index}] must reference a .step or .stp artifact`;
    }
    const absolute = resolve(cwd, input);
    const rel = relative(resolve(cwd), absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) return `requirements.inputs[${index}] escapes the project root`;
    if (existsSync(absolute)) {
      const real = realpathSync(absolute);
      const realRel = relative(realpathSync(cwd), real);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        return `requirements.inputs[${index}] resolves outside the project root`;
      }
    }
  }
  return null;
}

async function verifyCurrentFinalReview(cwd: string, state: CadRunState): Promise<string | null> {
  const review = state.finalReview;
  if (!review || review.verdict !== "pass") return "current independent reviewer PASS is missing";
  if (review.artifactHash !== state.currentArtifactHash) return "review PASS belongs to a different artifact";
  if (review.requirementsHash !== state.requirementsVersion || review.assertionsHash !== state.assertionsVersion) {
    return "review PASS belongs to a different requirements contract";
  }
  const path = resolve(cwd, review.path);
  if (!existsSync(path)) return `review report is missing: ${review.path}`;
  if (await sha256File(path) !== review.sha256) return `review report hash changed: ${review.path}`;
  return null;
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

const AssertionExpectationSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("exact"),
      value: Type.Number(),
      unit: Type.Optional(Type.String()),
      tolerance: Type.Optional(Type.Number({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("range"),
      min: Type.Optional(Type.Number()),
      max: Type.Optional(Type.Number()),
      unit: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("boolean"), expected: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("relation"), description: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

const AcceptanceAssertionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    mustRef: Type.String({ pattern: "^M[1-9][0-9]*$" }),
    statement: Type.String({
      minLength: 1,
      description: "Observable acceptance claim about the completed deliverable; never describe feature history, pre-operation construction geometry, or removed geometry",
    }),
    binding: Type.Object(
      {
        subject: Type.String({
          minLength: 1,
          description: "Entity observable in the completed deliverable",
        }),
        quantity: Type.String({ minLength: 1 }),
        reference: Type.Optional(Type.String({
          minLength: 1,
          description: "Reference observable or derivable from the completed deliverable, not an intermediate or removed entity",
        })),
        direction: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    expectation: AssertionExpectationSchema,
    canonicalCheck: Type.Optional(
      Type.Object(
        {
          field: Type.Enum({
            bbox_x: "bbox.x",
            bbox_y: "bbox.y",
            bbox_z: "bbox.z",
            volume: "volume",
            surfaceArea: "surfaceArea",
            solidCount: "solidCount",
            occurrenceCount: "occurrenceCount",
            cylinderCount: "cylinderCount",
          }),
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
      "Maturity adds closure obligations you must satisfy before the run can finish (manufacturing owes drawing evidence, release owes presentation evidence). Route to the maturity the request actually implies — over-routing blocks closure.",
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
          interactionMode: interactionModeFromEnvironment(),
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
    name: "cad_reroute",
    label: "Pi-CAD Reroute",
    description:
      "Change the route mid-process. Autonomous when the new route only adds obligations (e.g. part -> assembly); any obligation drop (downgrade) needs the one-time authorityToken the harness issued after the user answered your cad_wait_for_user pause. Reroute never grants progress: the harness resumes at the earliest phase with unmet obligations.",
    promptSnippet: "Reroute mid-process; downgrades need user-issued authority",
    promptGuidelines: [
      "Call when the task's true shape differs from the routed one (part turned out to be an assembly, maturity was over-estimated).",
      "Autonomous upgrades apply immediately and resume at the earliest unmet phase.",
      "For a downgrade: this call records the request and fails; ask the user with cad_wait_for_user; when they agree they must run /cad-approve-reroute themselves (an ordinary reply issues nothing); the command issues a one-time authorityToken bound to exactly the approved route; re-run cad_reroute with it.",
      "Never claim the user approved a downgrade — only the /cad-approve-reroute token counts, and it works for the approved route only.",
      "There is no target phase: the harness decides where the run resumes.",
    ],
    parameters: Type.Object(
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
        reason: Type.String({ description: "What changed about the task's shape and why the new route fits" }),
        authorityToken: Type.Optional(Type.String({ description: "One-time harness-issued downgrade authority" })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const nextRoute = buildRoute(params);
      if (typeof nextRoute === "string") return errTool(nextRoute);
      if (!isRoute(nextRoute)) return errTool("invalid route");
      const result = reroute(state, nextRoute, params.reason, params.authorityToken);
      if (!result.ok) {
        if (result.requiresAuthority) {
          // Record the pending reroute so the user can approve it with
          // /cad-approve-reroute. A request for a DIFFERENT route voids any
          // outstanding approval (it was granted for another request); a
          // re-request of the same approved route keeps its token.
          const sameAsApproved =
            Boolean(state.rerouteAuthorityToken) &&
            state.rerouteAuthorityRoute === routeKey(nextRoute);
          let pending: CadRunState = {
            ...state,
            pendingReroute: { route: nextRoute, reason: params.reason },
            ...(sameAsApproved
              ? {}
              : { rerouteAuthorityToken: null, rerouteAuthorityRoute: null }),
          };
          const events: Array<{ type: string; data?: unknown }> = [
            {
              type: "RerouteAuthorityRequested",
              data: { route: routeKey(nextRoute), reason: params.reason },
            },
          ];
          if (isHeadless(state)) {
            const blocked = declareHeadlessBlocker(pending, {
              type: "user_authority",
              reason: `reroute to ${routeKey(nextRoute)} drops obligations`,
              needed: "explicit user approval through /cad-approve-reroute",
            });
            if (blocked.ok) {
              pending = blocked.state;
              events.push(...blocked.events);
            }
          }
          await deps.persist(pi, store, pending, events);
          return errTool(
            isHeadless(state)
              ? `${result.reason}. Headless workflow is now BLOCKED_USER; user approval cannot be fabricated.`
              : `${result.reason}.\n\nPending reroute recorded: ${routeKey(nextRoute)}. Ask the user (cad_wait_for_user); when they agree, they must run /cad-approve-reroute themselves — an ordinary reply issues nothing. The command issues a one-time authorityToken bound to exactly this route, shown in the state summary.`,
          );
        }
        return errTool(result.reason);
      }
      if (state.routeRequiresReassessment && workflowSpec(result.state)?.requiresBaselineInput) {
        const requirements = await loadCurrentRequirements(store, state);
        const baselineInput = requirements
          ? (requirements.inputs ?? []).find((item) => /\.(step|stp)$/i.test(item))
          : null;
        let blocker: CadRunState["blocker"] | undefined;
        if (!baselineInput) {
          blocker = {
            type: "external_input",
            reason: "the revised route requires a baseline STEP that is not available",
            needed: "provide a readable project-contained .step/.stp baseline input",
            createdAt: nowIso(),
          };
        } else {
          try {
            await sha256File(resolve(ctx.cwd, baselineInput));
          } catch {
            blocker = {
              type: "external_input",
              reason: `the revised route baseline is unavailable: ${baselineInput}`,
              needed: `provide a readable baseline at ${baselineInput}`,
              createdAt: nowIso(),
            };
          }
        }
        if (blocker) {
          const blocked: CadRunState = { ...result.state, status: "blocked_external", blocker };
          await deps.persist(pi, store, blocked, result.events);
          return errTool(`Route was reassessed, but execution is BLOCKED_EXTERNAL: ${blocker.needed}`, { state: blocked });
        }
        await deps.persist(pi, store, result.state, result.events);
        const baseline = await deps.runBaselineAuto(pi, store, result.state, baselineInput!, deps.persist);
        return {
          content: [{ type: "text", text: `Rerouted ${routeKey(state.route!)} -> ${routeKey(nextRoute)} and rebound baseline ${baselineInput}.` }, ...baseline.images],
          details: { state: baseline.state },
        };
      }
      await deps.persist(pi, store, result.state, result.events);
      return okTool(
        [
          `Rerouted ${routeKey(state.route!)} -> ${routeKey(nextRoute)} (authority: ${result.events[0].data?.authority}).`,
          `Harness resumed at ${result.state.phase.toUpperCase()} — the earliest phase with unmet obligations. No progress was granted.`,
          "",
          await loadPrompt(result.state.phase),
        ].join("\n"),
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
      "Before any candidate exists, preregister one or more assertions for every Must using stable M1/M2/... references. Geometry assertions state only facts observable on the completed deliverable, never modeling order, feature history, pre-cut construction geometry, or removed entities. Translate procedural instructions into final dimensions and relationships that an independent reviewer can establish from the final artifact without source history.",
      "Set canonicalCheck only when the Must truly maps to a global digest field; do not guess a bbox axis from prose. If binding.direction explicitly names global X/Y/Z for a numeric extent, the matching bbox canonicalCheck is mandatory.",
      "For legacy/hybrid lineages, analyze, and convert, list supplied STEP/STP files in inputs.",
      "Fully specified greenfield part tasks may commit with zero extra questions.",
      "Follow the authoritative interaction-mode policy in the system context. In HEADLESS mode record material ambiguity in deferredClarifications with an explicit fallback; in INTERACTIVE mode ask the user when the decision is theirs.",
      "Use cad_revise_requirements when later authoritative information changes this committed task definition.",
      "Physical CAD tasks default to REAL/BUILDABLE/FUNCTIONAL; only commit a mockup brief after the user explicitly downgraded maturity.",
    ],
    parameters: Type.Object({
      goal: Type.String(),
      deliverables: Type.Array(Type.String(), { minItems: 1 }),
      must: Type.Array(Type.String(), { default: [] }),
      assertions: Type.Array(AcceptanceAssertionSchema, { default: [] }),
      preferences: Type.Array(Type.String(), { default: [] }),
      assumptions: Type.Array(Type.String(), { default: [] }),
      openUnknowns: Type.Array(Type.String(), { default: [] }),
      deferredClarifications: Type.Optional(Type.Array(Type.Object({
        question: Type.String(),
        reason: Type.String(),
        alternatives: Type.Array(Type.String(), { minItems: 2 }),
        fallback: Type.String(),
        impact: Type.String(),
      }))),
      inputs: Type.Optional(Type.Array(Type.String())),
      evidenceObligations: Type.Optional(EvidenceObligationsSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      if (state.requirementsVersion) return errTool("requirements are already committed; use cad_revise_requirements");
      const record = params as unknown as CadRequirements;
      const validationFailure = validateRequirementsRecord(state, record) ?? validateInputDeclarations(record, ctx.cwd);
      if (validationFailure) {
        return errTool(`invalid requirements record: ${validationFailure}. The workflow state is unchanged.`);
      }
      const result = commitRequirements(state, record);
      if (!result.ok) return errTool(result.reason);
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
        await store.writeRequirementsVersion(next.requirementsVersion!, record);
        await store.writeRecord("requirements", record);
        await deps.persist(pi, store, next, result.events);
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
      await store.writeRequirementsVersion(next.requirementsVersion!, record);
      await store.writeRecord("requirements", record);
      await deps.persist(pi, store, next, result.events);
      return okTool(
        `Requirements committed (${next.requirementsVersion?.slice(0, 12)}). Harness phase is now ${next.phase.toUpperCase()}.\n\n${await loadPrompt(next.phase)}`,
        { state: next, requirementsVersion: next.requirementsVersion },
      );
    },
  });

  pi.registerTool({
    name: "cad_revise_requirements",
    label: "Pi-CAD Revise Requirements",
    description:
      "Replace the active requirements with a materially revised authoritative task definition, invalidate dependent conclusions, and either confirm the current route or lock engineering until cad_reroute.",
    promptSnippet: "Revise authoritative requirements before rerouting or continuing engineering",
    promptGuidelines: [
      "Call when a replacement specification, user correction, or new authoritative engineering fact materially changes the task definition.",
      "Supply the complete replacement requirements record, not a patch.",
      "Set routeAssessment=unchanged only after checking objective, lineage, structure, and maturity against the new requirements.",
      "Set routeAssessment=changed when cad_reroute must follow; the harness locks all downstream engineering until reroute succeeds.",
      "A missing declared baseline blocks execution after the new requirements become canonical; it never restores the obsolete version.",
    ],
    parameters: Type.Object({
      goal: Type.String(),
      deliverables: Type.Array(Type.String(), { minItems: 1 }),
      must: Type.Array(Type.String(), { default: [] }),
      assertions: Type.Array(AcceptanceAssertionSchema, { default: [] }),
      preferences: Type.Array(Type.String(), { default: [] }),
      assumptions: Type.Array(Type.String(), { default: [] }),
      openUnknowns: Type.Array(Type.String(), { default: [] }),
      deferredClarifications: Type.Optional(Type.Array(Type.Object({
        question: Type.String(),
        reason: Type.String(),
        alternatives: Type.Array(Type.String(), { minItems: 2 }),
        fallback: Type.String(),
        impact: Type.String(),
      }))),
      inputs: Type.Optional(Type.Array(Type.String())),
      evidenceObligations: Type.Optional(EvidenceObligationsSchema),
      reason: Type.String({ minLength: 1 }),
      routeAssessment: Type.Object({
        outcome: Type.Enum({ unchanged: "unchanged", changed: "changed" }),
        reason: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow with committed requirements.");
      const { reason, routeAssessment, ...recordParams } = params;
      const record = recordParams as unknown as CadRequirements;
      const inputFailure = validateInputDeclarations(record, ctx.cwd);
      if (inputFailure) return errTool(`invalid requirements record: ${inputFailure}. The canonical requirements are unchanged.`);
      const previous = await loadCurrentRequirements(store, state);
      if (!previous) return errTool("current immutable requirements record is missing or corrupt");

      const declaredBaseline = (record.inputs ?? []).find((item) => /\.(step|stp)$/i.test(item));
      const baselineInput = declaredBaseline;
      const spec = workflowSpec(state);
      let baselineIdentityChanged = declaredBaseline !== state.baselineArtifactPath;
      let externalBlocker: { reason: string; needed: string } | undefined;
      let baselineAvailable = false;
      if (routeAssessment.outcome === "unchanged" && spec?.requiresBaselineInput && !baselineInput) {
        externalBlocker = {
          reason: "the revised authoritative requirements require a baseline STEP that is not available",
          needed: "provide a readable project-contained .step/.stp baseline input",
        };
      } else if (baselineInput) {
        try {
          const baselineHash = await sha256File(resolve(ctx.cwd, baselineInput));
          // Hash identity, not path spelling, controls whether frame_context
          // can survive the revision.
          baselineIdentityChanged = baselineHash !== state.baselineArtifactHash;
          baselineAvailable = true;
        } catch {
          baselineIdentityChanged = true;
          if (routeAssessment.outcome === "unchanged" && spec?.requiresBaselineInput) {
            externalBlocker = {
              reason: `the revised authoritative baseline is unavailable: ${baselineInput}`,
              needed: `provide a readable baseline at ${baselineInput}`,
            };
          }
        }
      }

      const result = reviseRequirements(state, previous, record, {
        reason,
        routeAssessment,
        baselineIdentityChanged,
        externalBlocker,
      });
      if (!result.ok) return errTool(result.reason);

      if (result.events[0]?.type === "RequirementsRevised") {
        await store.writeRequirementsVersion(result.state.requirementsVersion!, record);
      }
      await deps.persist(pi, store, result.state, result.events);

      if (
        routeAssessment.outcome === "unchanged" &&
        spec?.requiresBaselineInput &&
        baselineInput && baselineAvailable &&
        result.state.status === "active"
      ) {
        const baseline = await deps.runBaselineAuto(pi, store, result.state, baselineInput, deps.persist);
        const text = [
          `Requirements revised (${result.state.requirementsVersion?.slice(0, 12)}); route confirmed unchanged.`,
          `Baseline ${baselineInput} was rebound and observed for the new requirements version.`,
          ...(baseline.warnings.length ? [`warnings: ${baseline.warnings.join("; ")}`] : []),
          "",
          await loadPrompt(baseline.state.phase),
        ].join("\n");
        return { content: [{ type: "text", text }, ...baseline.images], details: { state: baseline.state } };
      }

      if (result.state.status === "blocked_external") {
        return errTool(
          `Requirements V${result.state.requirementsVersion?.slice(0, 12)} are canonical, but execution is BLOCKED_EXTERNAL: ${result.state.blocker?.needed}`,
          { state: result.state },
        );
      }
      return okTool(
        routeAssessment.outcome === "changed"
          ? `Requirements revised (${result.state.requirementsVersion?.slice(0, 12)}). Route reassessment lock is active: ${routeAssessment.reason} Call cad_reroute before downstream engineering.`
          : `Requirements revised (${result.state.requirementsVersion?.slice(0, 12)}); route confirmed unchanged. Harness resumed at ${result.state.phase.toUpperCase()}.\n\n${await loadPrompt(result.state.phase)}`,
        { state: result.state, requirementsVersion: result.state.requirementsVersion },
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
    name: "cad_commit_frame_context",
    label: "Pi-CAD Commit Frame Context",
    description:
      "Record the coordinate-frame mapping of a user-supplied artifact during the baseline phase. Mandatory before baseline_understood. Interactive runs record user-confirmed/provided/declined handling; headless runs may record an honest assumed_headless mapping as clarification debt.",
    promptSnippet: "Record the coordinate frame mapping (with its disposition)",
    promptGuidelines: [
      "In INTERACTIVE mode, default to disposition=confirmed and ask one focused question. In HEADLESS mode, never ask or claim confirmation; use assumed_headless with a best-effort evidence-based mapping when the frame matters.",
      "Record the mapping in the user's functional words (which way is up in the machine, where the load comes from, which face locates against what).",
      "already_provided only when the user stated the mapping unprompted earlier in this conversation — cite it in howConfirmed.",
      "not_applicable only when coordinates carry through verbatim AND direction is never referenced (pure format conversion); still record your best reading of the file's axes.",
      "user_declined only when you actually asked and the user declined; say so in howConfirmed. Never guess from how the part sits in the file or from axis names alone.",
    ],
    parameters: Type.Object(
      {
        disposition: Type.Enum({
          confirmed: "confirmed",
          already_provided: "already_provided",
          not_applicable: "not_applicable",
          user_declined: "user_declined",
          assumed_headless: "assumed_headless",
        }, {
          description:
            "confirmed: you asked and the user answered. already_provided: the user stated the mapping unprompted earlier. not_applicable: coordinates carry through and direction is irrelevant. user_declined: the user explicitly declined. assumed_headless: no user turn exists, so a best-effort mapping is recorded as clarification debt.",
        }),
        axes: Type.Array(
          Type.Object(
            {
              axis: Type.Enum({ x: "x", y: "y", z: "z" }),
              mapsTo: Type.String({
                minLength: 1,
                description: "Functional meaning of this artifact axis, in the user's words",
              }),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 3,
            description:
              "All three artifact axes must be mapped — including not_applicable/declined records (a best-effort reading of the file's own axes, honestly attributed)",
          },
        ),
        howConfirmed: Type.String({
          minLength: 1,
          description:
            "What the user pointed at or said when confirming; for other dispositions, why that disposition applies (e.g. which earlier message stated the mapping)",
        }),
        notes: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const axes = new Set(params.axes.map((axis) => axis.axis));
      if (axes.size !== 3) {
        return errTool("axes must map each of x, y, z exactly once");
      }
      if (params.disposition === "confirmed" && params.howConfirmed.trim().length < 3) {
        return errTool("disposition=confirmed requires howConfirmed to state what the user pointed at or said");
      }
      if (
        isHeadless(state) &&
        (params.disposition === "confirmed" || params.disposition === "user_declined")
      ) {
        return errTool(
          "headless mode cannot claim user confirmation or refusal; use already_provided, genuinely not_applicable, or assumed_headless",
        );
      }
      if (!isHeadless(state) && params.disposition === "assumed_headless") {
        return errTool("assumed_headless frame disposition is only valid in headless mode");
      }
      let recordState = state;
      const extraEvents: Array<{ type: string; data?: unknown }> = [];
      if (params.disposition === "assumed_headless") {
        const fallback = params.axes.map((axis) => `${axis.axis}=${axis.mapsTo}`).join(", ");
        const deferred = deferClarification(state, {
          question: "How do the artifact's local axes map to functional reality?",
          reason: params.howConfirmed,
          alternatives: [
            `Use the evidence-based provisional mapping: ${fallback}`,
            "Wait for a user-confirmed functional mapping",
          ],
          fallback,
          impact: params.notes?.trim() || "Directional interpretation may need revision when user context becomes available.",
          affectsContract: false,
        });
        if (!deferred.ok) return errTool(deferred.reason);
        recordState = deferred.state;
        extraEvents.push(...deferred.events);
      }
      const result = commitPhaseRecord(recordState, "frame_context", params);
      if (!result.ok) return errTool(result.reason);
      await store.writeRecord("frame_context", params);
      await deps.persist(pi, store, result.state, [...extraEvents, ...result.events]);
      return okTool(
        `Frame context recorded (${params.disposition}: ${params.howConfirmed.slice(0, 80)}). Phase remains ${result.state.phase.toUpperCase()}; call cad_transition(baseline_understood) when the baseline is understood.`,
        { state: result.state },
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
    name: "cad_submit_for_review",
    label: "Pi-CAD Submit for Independent Review",
    description:
      "Submit the current immutable candidate for deterministic preflight and a fresh, read-only, cad_probe-only final verification transaction. PASS alone advances the final closure edge to READY.",
    promptSnippet: "Submit the completed candidate for independent evidence-backed final verification",
    promptGuidelines: [
      "Use only when the current accepted transition targets READY; intermediate engineering handoffs still use cad_transition.",
      "Do not provide self-authored checks or justification. The reviewer receives canonical Mission, preregistered Assertions, current visuals/digest/evidence, and cad_probe only.",
      "FAIL or UNRESOLVED leaves the phase unchanged; revise the candidate or explicitly revise a suspect requirements contract before submitting again.",
    ],
    parameters: Type.Object(
      { summary: Type.Optional(Type.String({ description: "Optional terse submission label; not acceptance evidence" })) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      if (!finalReviewerEnabled()) {
        return errTool("cad_submit_for_review is disabled by PI_CAD_FINAL_REVIEWER=0");
      }
      if (!finalSubmissionAllowed(state)) {
        return errTool(`cad_submit_for_review is only valid on a final closure edge; current phase is ${state.phase}`);
      }
      const spec = workflowSpec(state);
      const artifactVerification = await verifyCurrentArtifacts(ctx.cwd, state);
      if (artifactVerification) return errTool(`review preflight blocked: ${artifactVerification}`);
      if (!state.currentArtifactHash) return errTool("review preflight blocked: current artifact hash is not bound");
      const evidenceVerification = await verifyEvidenceFilesForHash(
        ctx.cwd,
        state,
        state.currentArtifactHash,
        acceptedEvidenceKinds(state),
      );
      if (evidenceVerification) return errTool(`review preflight blocked: ${evidenceVerification}`);
      if (state.evidenceObligations?.simulation?.disposition === "required") {
        const simulationVerification = await verifyEvidenceFilesForHash(
          ctx.cwd,
          state,
          state.currentArtifactHash,
          ["simulation"],
        );
        if (simulationVerification) return errTool(`review preflight blocked: ${simulationVerification}`);
      }
      const presentationVerification = await verifyPresentationDeliverables(ctx.cwd, state);
      if (presentationVerification) return errTool(`review preflight blocked: ${presentationVerification}`);
      const closureGuard = spec?.completionGuard?.(state);
      if (closureGuard) return errTool(`review preflight blocked: ${closureGuard}`);
      const requirements = await loadCurrentRequirements(store, state);
      if (!requirements || !state.requirementsVersion || !state.assertionsVersion) {
        return errTool("review preflight blocked: canonical requirements/assertions record is missing");
      }
      const preflight = await runFinalReviewPreflight(ctx.cwd, state, requirements);
      if (preflight.contradictions.length > 0) {
        const regressed = regressFinalReview(state, "deterministic final-review preflight contradiction");
        const nextState = regressed?.state ?? state;
        await deps.persist(pi, store, nextState, [{
          type: "FinalReviewPreflightFailed",
          data: { contradictions: preflight.contradictions, artifactHash: state.currentArtifactHash },
        }, ...(regressed?.events ?? [])]);
        return errTool(
          `Independent review not started: deterministic preflight found ${preflight.contradictions.length} contradiction(s).${regressed ? ` Returned to editable ${regressed.state.phase.toUpperCase()}.` : ""}\n${preflight.contradictions.map((item) => `- ${item.assertionId}: ${item.finding}`).join("\n")}`,
          { state: nextState, preflight },
        );
      }
      let reviewer;
      try {
        reviewer = await (deps.reviewerRunner ?? freshReviewerRunner).run(ctx, state, requirements, preflight);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reviewer = {
          result: {
            verdict: "unresolved" as const,
            assertionChecks: requirements.assertions.map((assertion) => ({
              assertionId: assertion.id,
              verdict: "unresolved" as const,
              finding: `reviewer failed safely: ${message}`,
              evidenceRefs: [],
            })),
            semanticObjections: [],
            summary: `reviewer failed safely: ${message}`,
          },
          evidenceIndex: collectReviewerEvidenceIndex(state),
          probeCalls: 0,
          usage: [],
          reviewerModel: "unavailable",
          probeEvidence: [],
        };
      }
      const createdAt = nowIso();
      const priorReports = await store.listReviewsNewestFirst<{
        sourceHash?: string;
        requirementsHash?: string;
        assertionsHash?: string;
        result?: { verdict?: string };
      }>();
      const history: StoredReviewVote[] = priorReports.flatMap(({ path, data }) => {
        const verdict = data.result?.verdict;
        if (
          !data.requirementsHash ||
          !data.assertionsHash ||
          (verdict !== "pass" && verdict !== "fail" && verdict !== "unresolved")
        ) return [];
        return [{
          path: store.relative(path),
          sourceHash: data.sourceHash,
          requirementsHash: data.requirementsHash,
          assertionsHash: data.assertionsHash,
          verdict,
        }];
      });
      const aggregate = aggregateReviewVotes(
        {
          sourceHash: state.currentSourceHash,
          requirementsHash: state.requirementsVersion,
          assertionsHash: state.assertionsVersion,
        },
        reviewer.result.verdict,
        history,
      );
      const report = {
        version: 2,
        createdAt,
        submissionSummary: params.summary,
        sourceHash: state.currentSourceHash,
        requirementsHash: state.requirementsVersion,
        assertionsHash: state.assertionsVersion,
        artifactHash: state.currentArtifactHash,
        evidenceSnapshotHash: reviewer.evidenceIndex.snapshotHash,
        evidenceIndex: reviewer.evidenceIndex,
        reviewerModel: reviewer.reviewerModel,
        reviewerPromptVersion: REVIEWER_PROMPT_VERSION,
        probeCalls: reviewer.probeCalls,
        probeEvidence: reviewer.probeEvidence,
        usage: reviewer.usage,
        preflight,
        result: reviewer.result,
        aggregate,
      };
      const reportPath = await store.writeReview(report);
      const finalReview: FinalReviewRef = {
        path: store.relative(reportPath),
        sha256: await sha256File(reportPath),
        sourceHash: state.currentSourceHash,
        artifactHash: state.currentArtifactHash,
        requirementsHash: state.requirementsVersion,
        assertionsHash: state.assertionsVersion,
        evidenceSnapshotHash: reviewer.evidenceIndex.snapshotHash,
        individualVerdict: reviewer.result.verdict,
        verdict: aggregate.verdict,
        reviewerModel: reviewer.reviewerModel,
        reviewerPromptVersion: REVIEWER_PROMPT_VERSION,
        createdAt,
      };
      const reviewedState: CadRunState = { ...state, finalReview, updatedAt: createdAt };
      const reviewEvent = {
        type: "FinalReviewCompleted",
        data: {
          individualVerdict: reviewer.result.verdict,
          verdict: aggregate.verdict,
          votes: { pass: aggregate.pass, fail: aggregate.fail },
          report: finalReview.path,
          artifactHash: state.currentArtifactHash,
          probeCalls: reviewer.probeCalls,
        },
      };
      if (aggregate.verdict !== "pass") {
        const regressed = regressFinalReview(
          reviewedState,
          `independent final review aggregate ${aggregate.verdict}`,
        );
        const nextState = regressed?.state ?? reviewedState;
        await deps.persist(pi, store, nextState, [reviewEvent, ...(regressed?.events ?? [])]);
        const findings = reviewer.result.assertionChecks
          .filter((check) => check.verdict !== "pass")
          .map((check) => `- ${check.assertionId} ${check.verdict.toUpperCase()}: ${check.finding}`);
        return errTool(
          `Independent final review ${aggregate.verdict.toUpperCase()} (current vote ${reviewer.result.verdict.toUpperCase()}; recent votes PASS ${aggregate.pass}, FAIL ${aggregate.fail}).${regressed ? ` Returned to editable ${regressed.state.phase.toUpperCase()}.` : ` Phase remains ${state.phase.toUpperCase()}.`}\nReport: ${finalReview.path}\n${findings.join("\n") || reviewer.result.summary}`,
          { state: nextState, finalReview, result: reviewer.result, aggregate },
        );
      }
      const accepted = transition(reviewedState, "accepted", "independent final review aggregate PASS");
      if (!accepted.ok) {
        await deps.persist(pi, store, reviewedState, [reviewEvent]);
        return errTool(`review PASS could not close workflow: ${accepted.reason}`, { state: reviewedState, finalReview });
      }
      if (
        spec?.updatesHeadOnAccept &&
        accepted.state.currentArtifactPath &&
        accepted.state.currentArtifactHash &&
        /\.(step|stp)$/i.test(accepted.state.currentArtifactPath)
      ) {
        await store.updateHead({
          sourcePath: accepted.state.currentSourcePath,
          sourceHash: accepted.state.currentSourceHash,
          artifactPath: store.relative(accepted.state.currentArtifactPath),
          artifactHash: accepted.state.currentArtifactHash,
          evidence: accepted.state.evidence,
        });
      }
      await deps.persist(pi, store, accepted.state, [reviewEvent, ...accepted.events]);
      return okTool(
        `Independent final review PASS (current vote ${reviewer.result.verdict.toUpperCase()}; recent votes PASS ${aggregate.pass}, FAIL ${aggregate.fail}). Phase is now READY.\nReport: ${finalReview.path}\n\n${await loadPrompt("ready")}`,
        { state: accepted.state, finalReview, result: reviewer.result, aggregate },
      );
    },
  });

  pi.registerTool({
    name: "cad_transition",
    label: "Pi-CAD Transition",
    description:
      "Express an explicit workflow transition. Harness validates only procedural guards and workflow transition legality.",
    promptSnippet: "Move the current workflow with an explicit transition event",
    promptGuidelines: [
      "Intermediate accepted transitions require you to interpret current evidence; a final edge to READY requires cad_submit_for_review.",
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
        // The transition table is authoritative for where acceptance
        // leads: "ready" CLOSES the run; any other target (audit, when a
        // release suffix follows the design core) merely continues the
        // process. Closure deliverables (presentation, workstreams) gate
        // the closure only — the design review must not demand release
        // artifacts it cannot even produce in that phase.
        const acceptedTarget = spec.transitions[state.phase]?.accepted ?? "ready";
        const isClosureAcceptance = acceptedTarget === "ready";
        if (isClosureAcceptance && finalReviewerEnabled()) {
          return errTool("final acceptance requires cad_submit_for_review; cad_transition(accepted) cannot enter READY directly");
        }
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
        if (isClosureAcceptance) {
          const presentationVerification = await verifyPresentationDeliverables(ctx.cwd, state);
          if (presentationVerification) return errTool(`cannot accept: ${presentationVerification}`);
          const guard = spec.completionGuard?.(state);
          if (guard) return errTool(`cannot accept: ${guard}`);
        }
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
      // Head commits only when acceptance CLOSES the run (phase becomes
      // ready). A design-review accepted that hands into a release suffix
      // must not move the head: if the audit/gap_closure then fails or the
      // user aborts, "abort leaves the project head unchanged" still holds.
      if (
        params.event === "accepted" &&
        result.state.phase === "ready" &&
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
      "Pause the workflow for a user decision that is theirs to make, not yours. The next user turn restores the same phase.",
    promptSnippet: "Pause the workflow for a required user decision",
    promptGuidelines: [
      "Ask one decision per pause and give your recommended answer.",
      "Use this only for decisions the user must make: scope, cost, risk, or authority the harness structurally requires (e.g. a maturity downgrade).",
      "In interactive mode, pause for a material specification ambiguity when competing answers change topology, interfaces, placement, or final extents. Do not pause for ordinary implementation judgment. In headless mode, record deferredClarifications in the requirements commit and continue with its explicit fallback.",
      "Before pausing over missing evidence, check whether you can produce it yourself (e.g. drawing evidence via cadctl drawing through bash) or reroute to the maturity the request actually implies.",
    ],
    parameters: Type.Object({ reason: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      if (isHeadless(state)) {
        return errTool(
          "HEADLESS mode cannot wait for a user. Use cad_defer_clarification for an engineering fallback or cad_declare_blocker for user-owned authority.",
        );
      }
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
    name: "cad_defer_clarification",
    label: "Pi-CAD Record Headless Clarification",
    description:
      "Record a material engineering ambiguity with alternatives and an explicit fallback, then continue without waiting for a user. A committed acceptance contract is immutable; affectsContract is rejected after its first commit.",
    promptSnippet: "Record headless clarification debt and continue with an explicit fallback",
    promptGuidelines: [
      "Use only for engineering interpretation ambiguities, never to fabricate user authority.",
      "Set affectsContract=true only before the first requirements commit. After commit, repair against the frozen contract or declare a user-authority blocker.",
      "After recording a non-contract fallback, continue the current workflow immediately.",
    ],
    parameters: Type.Object({
      question: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      alternatives: Type.Array(Type.String({ minLength: 1 }), { minItems: 2 }),
      fallback: Type.String({ minLength: 1 }),
      impact: Type.String({ minLength: 1 }),
      affectsContract: Type.Boolean(),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const result = deferClarification(state, params);
      if (!result.ok) return errTool(result.reason);
      await deps.persist(pi, store, result.state, result.events);
      return okTool(
        params.affectsContract
          ? "Headless clarification recorded. Acceptance may change; returned to REQUIREMENTS for explicit re-commit."
          : `Headless clarification recorded. Continue in ${result.state.phase.toUpperCase()} using the fallback.`,
        { state: result.state, clarification: result.state.deferredClarifications?.at(-1) },
      );
    },
  });

  pi.registerTool({
    name: "cad_declare_blocker",
    label: "Pi-CAD Declare Headless Blocker",
    description:
      "End a headless workflow honestly when progress requires user-owned authority or unavailable external input that must not be invented.",
    promptSnippet: "Declare a structured headless blocker instead of waiting or fabricating consent",
    promptGuidelines: [
      "Use user_authority only for decisions owned by the user: permission, scope, cost, risk acceptance, or obligation downgrade.",
      "Use external_input for indispensable external facts such as unavailable loads, materials, boundary conditions, or credentials.",
      "Do not use this for an engineering interpretation you can resolve with a documented fallback.",
    ],
    parameters: Type.Object({
      type: Type.Enum({ user_authority: "user_authority", external_input: "external_input" }),
      reason: Type.String({ minLength: 1 }),
      needed: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const result = declareHeadlessBlocker(state, params);
      if (!result.ok) return errTool(result.reason);
      await deps.persist(pi, store, result.state, result.events);
      return okTool(
        `Headless workflow terminated as ${result.state.status?.toUpperCase()}: ${params.reason}`,
        { state: result.state, blocker: result.state.blocker },
      );
    },
  });

  pi.registerTool({
    name: "cad_finish",
    label: "Pi-CAD Finish",
    description:
      "Request workflow closure. Harness verifies READY, files, evidence, and release workstreams. It does not judge design quality.",
    promptSnippet: "Close the workflow after Ready",
    promptGuidelines: ["Only call after cad_submit_for_review has produced READY (analyze routes keep their existing findings-delivered closure)."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const store = new CadProjectStore(ctx.cwd);
      const state = await guardState(store);
      if (!state) return errTool("No active Pi-CAD workflow. Call cad_route first.");
      const verification = await verifyCurrentArtifacts(ctx.cwd, state);
      if (verification) return errTool(`cad_finish blocked: ${verification}`);
      const spec = workflowSpec(state);
      if (finalReviewerEnabled() && state.route?.objective !== "analyze") {
        const reviewVerification = await verifyCurrentFinalReview(ctx.cwd, state);
        if (reviewVerification) return errTool(`cad_finish blocked: ${reviewVerification}`);
      }
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
        const finishPresentation = await verifyPresentationDeliverables(ctx.cwd, state);
        if (finishPresentation) return errTool(`cad_finish blocked: ${finishPresentation}`);
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
