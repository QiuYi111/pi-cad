import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerKernelActionTool, registerMechanicalActionTool } from "../domains/mechanical/register-action.ts";

import { type CadRequirements, type Route, isRoute, routeKey } from "../shared/protocol.ts";
import { finalReviewerEnabled } from "./policies.ts";
import { interactionModeFromEnvironment } from "../shared/interaction-mode.ts";
import { CadStartParamsSchema, cadStart } from "../harness/kernel.ts";
import { cadRerouteV7, cadRouteV7 } from "../domains/mechanical/actions-v7.ts";
import { mechanicalBuiltinWorkflows } from "../domains/mechanical/workflows.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import {
  blockMechanicalRunV7,
  commitMechanicalRecordV7,
  deferMechanicalClarificationV7,
  finishMechanicalRunV7,
  transitionMechanicalRunV7,
  waitMechanicalRunV7,
} from "../domains/mechanical/control-actions-v7.ts";
import { commitMechanicalCandidateV7 } from "../domains/mechanical/candidate-actions-v7.ts";
import { runFreshReviewV7 } from "../harness/review.ts";
import { mechanicalReviewProfile } from "../domains/mechanical/review-profile.ts";
import { mechanicalReviewExecutorV7 } from "../domains/mechanical/review-executor-v7.ts";
import {
  okTool,
  errTool,
  validateInputDeclarations,
  buildRoute,
} from "../domains/mechanical/tool-schemas.ts";
import { MECHANICAL_ACTION_PARAMETERS } from "../domains/mechanical/action-schemas.ts";

export function registerControlTools(pi: ExtensionAPI): void {
  registerKernelActionTool(pi, {
    name: "cad_start",
    label: "Pi-CAD Start v7 Workflow",
    description: "Start the project-selected immutable v7 workflow. Mechanical tasks normally use cad_route, which starts the intake workflow automatically.",
    promptSnippet: "Start the selected generic v7 workflow explicitly",
    promptGuidelines: ["Use for a project-selected custom workflow; Mechanical routing can begin directly with cad_route."],
    parameters: CadStartParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await cadStart({ cwd: ctx.cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: params.reason, interactionMode: params.interactionMode ?? interactionModeFromEnvironment() });
        return okTool(`Started v7 workflow ${loaded.workflow.id}@${loaded.workflow.version}; phase=${loaded.state.phase}.`, { state: loaded.state, workflow: loaded.workflow });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_route,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const nextRoute: Route = buildRoute(params);
      if (typeof nextRoute === "string") return errTool(nextRoute);
      if (!isRoute(nextRoute)) return errTool("invalid route");
      const project = new (await import("../harness/run-store.ts")).HarnessProjectStoreV7(ctx.cwd);
      const activeV7 = await project.currentRun(mechanicalRegistries);
      if (!activeV7 || ["done", "aborted", "blocked_external", "budget_exhausted"].includes(activeV7.state.status)) {
        await cadStart({ cwd: ctx.cwd, registries: mechanicalRegistries, builtins: mechanicalBuiltinWorkflows(), reason: params.reason, interactionMode: interactionModeFromEnvironment() });
      }
      const loaded = await cadRouteV7({ cwd: ctx.cwd, route: nextRoute, reason: params.reason });
      return okTool(`Routed v7 workflow to ${routeKey(nextRoute)}.`, { state: loaded.state, workflow: loaded.workflow });
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_reroute,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const nextRoute = buildRoute(params);
      if (typeof nextRoute === "string") return errTool(nextRoute);
      if (!isRoute(nextRoute)) return errTool("invalid route");
      try {
        const loaded = await cadRerouteV7({ cwd: ctx.cwd, route: nextRoute, reason: params.reason });
        return okTool(`Rerouted v7 workflow to ${routeKey(nextRoute)}.`, { state: loaded.state, workflow: loaded.workflow });
      } catch (error) {
        return errTool(error instanceof Error ? error.message : String(error));
      }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_commit_requirements,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const inputFailure = validateInputDeclarations(params as unknown as CadRequirements, ctx.cwd);
      if (inputFailure) return errTool(`invalid requirements record: ${inputFailure}`);
      try {
        const loaded = await commitMechanicalRecordV7({ cwd: ctx.cwd, type: "requirements", value: params });
        return okTool(`Requirements committed to v7 (${loaded.state.records["record:requirements"]?.sha256.slice(0, 12)}). Phase is now ${loaded.state.phase.toUpperCase()}.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_revise_requirements,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { reason, routeAssessment, ...record } = params;
      const inputFailure = validateInputDeclarations(record as unknown as CadRequirements, ctx.cwd);
      if (inputFailure) return errTool(`invalid requirements record: ${inputFailure}`);
      try {
        const loaded = await commitMechanicalRecordV7({ cwd: ctx.cwd, type: "requirements", value: record, revise: true, advance: false });
        return okTool(`Requirements revised in v7 (${reason}); dependent records/evidence were invalidated. Route assessment: ${routeAssessment.outcome}.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });


  registerMechanicalActionTool(pi, {
    name: "cad_commit_plan",
    label: "Pi-CAD Commit Plan",
    description:
      "Commit plan/design intent, or record release workstream statuses. The harness checks schema and transition only.",
    promptSnippet: "Commit protected interfaces, planned changes, datums, review plan, or release workstream status",
    promptGuidelines: [
      "Use in part_design/plan/transform_plan to enter the source phase.",
      "Use in release audit/gap_closure/package to record workstream statuses.",
    ],
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_commit_plan,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await commitMechanicalRecordV7({ cwd: ctx.cwd, type: "plan", value: params });
        return okTool(`Plan committed to v7. Phase is now ${loaded.state.phase.toUpperCase()}.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_commit_frame_context,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await commitMechanicalRecordV7({ cwd: ctx.cwd, type: "frame_context", value: params });
        return okTool(`Frame context committed to v7. Phase is now ${loaded.state.phase.toUpperCase()}.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
    name: "cad_commit_assembly_design",
    label: "Pi-CAD Commit Assembly Design",
    description:
      "Commit the assembly design record (modules, datums, sequence, envelopes) and move from assembly_design to interface_design. This record is an obligation of assembly routes; there is no transition that skips it.",
    promptSnippet: "Commit the assembly architecture record",
    promptGuidelines: [
      "Answer all four architecture questions before committing: modules, datums, assembly sequence, envelopes.",
      "The record is the design's skeleton — later interface contracts and parts are checked against it.",
    ],
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_commit_assembly_design,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await commitMechanicalRecordV7({ cwd: ctx.cwd, type: "assembly_design", value: params });
        return okTool(`Assembly design committed to v7. Phase is now ${loaded.state.phase.toUpperCase()}.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
    name: "cad_commit_interface_contracts",
    label: "Pi-CAD Commit Interface Contracts",
    description:
      "Commit the A↔B interface contracts (locating, DOF, fasteners, fits, direction, tool access) and move from interface_design to part_design. Obligatory for assembly routes at engineering maturity and above.",
    promptSnippet: "Commit the interface contract records",
    promptGuidelines: [
      "One contract per interface pair, with locating scheme and constrained DOF stated explicitly.",
      "Interfaces must name the assembly datum each side locates against.",
    ],
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_commit_interface_contracts,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await commitMechanicalRecordV7({ cwd: ctx.cwd, type: "interface_contracts", value: params });
        return okTool(`Interface contracts committed to v7. Phase is now ${loaded.state.phase.toUpperCase()}.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_commit_candidate,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await commitMechanicalCandidateV7({ cwd: ctx.cwd, sources: params.sources, label: params.label, ...(params.format ? { format: params.format } : {}), ...(params.output ? { output: params.output } : {}) });
        return {
          content: [{ type: "text", text: `Candidate ${params.label} committed to v7; artifactHash=${result.proposal.artifactHash.slice(0, 12)}; phase=${result.loaded.state.phase}${result.pending.length ? `; remaining obligations=${result.pending.join(",")}` : ""}.` }, ...result.images],
          details: { state: result.loaded.state, proposal: result.proposal },
        };
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_submit_for_review,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!finalReviewerEnabled()) return errTool("cad_submit_for_review is disabled by PI_CAD_FINAL_REVIEWER=0");
      try {
        const active = await new (await import("../harness/run-store.ts")).HarnessProjectStoreV7(ctx.cwd).currentRun(mechanicalRegistries);
        if (!active) return errTool("No active v7 workflow.");
        const profileId = active.workflow.phases[active.state.phase]!.reviewProfile;
        if (profileId !== "mechanical.design-review" && profileId !== "mechanical.final-review") return errTool(`cad_submit_for_review is not enabled for phase ${active.state.phase}`);
        const reviewed = await runFreshReviewV7({ cwd: ctx.cwd, workflowRunId: active.state.runId, registries: mechanicalRegistries, profile: mechanicalReviewProfile(profileId), executor: mechanicalReviewExecutorV7(ctx) });
        if (reviewed.state.latestReview?.verdict !== "pass") return errTool(`Independent v7 review ${reviewed.state.latestReview?.verdict ?? "unresolved"}; phase remains ${reviewed.state.phase}.`, { state: reviewed.state, review: reviewed.state.latestReview });
        const advanced = await transitionMechanicalRunV7({ cwd: ctx.cwd, event: "accepted", note: params.summary ?? "fresh independent review PASS" });
        return okTool(`Independent v7 review PASS. Phase is now ${advanced.state.phase.toUpperCase()}.`, { state: advanced.state, review: reviewed.state.latestReview });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_transition,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await transitionMechanicalRunV7({ cwd: ctx.cwd, event: params.event, note: params.note });
        return okTool(`Transition ${params.event} accepted by v7. Phase is now ${loaded.state.phase.toUpperCase()}.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_wait_for_user,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await waitMechanicalRunV7({ cwd: ctx.cwd, reason: params.reason });
        return okTool(`v7 workflow paused in ${loaded.state.phase}.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_defer_clarification,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await deferMechanicalClarificationV7({ cwd: ctx.cwd, ...params });
        return okTool(`Headless clarification recorded in v7; continue in ${loaded.state.phase.toUpperCase()} using the fallback.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
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
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_declare_blocker,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await blockMechanicalRunV7({ cwd: ctx.cwd, status: params.type === "user_authority" ? "blocked_user" : "blocked_external", type: params.type, reason: params.reason, needed: params.needed });
        return okTool(`v7 workflow blocked as ${loaded.state.status.toUpperCase()}: ${params.reason}`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerMechanicalActionTool(pi, {
    name: "cad_finish",
    label: "Pi-CAD Finish",
    description:
      "Request workflow closure. Harness verifies READY, files, evidence, and release workstreams. It does not judge design quality.",
    promptSnippet: "Close the workflow after Ready",
    promptGuidelines: ["Only call after cad_submit_for_review has produced READY (analyze routes keep their existing findings-delivered closure)."],
    parameters: MECHANICAL_ACTION_PARAMETERS.cad_finish,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const loaded = await finishMechanicalRunV7({ cwd: ctx.cwd });
        return okTool(`v7 workflow finished. Status is ${loaded.state.status.toUpperCase()}.`, { state: loaded.state });
      } catch (error) { return errTool(error instanceof Error ? error.message : String(error)); }
    },
  });
}
