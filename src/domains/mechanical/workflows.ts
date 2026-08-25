import { PHASE_PURPOSES } from "../../core/agent-contract.ts";
import { contractTools, phaseContract } from "../../control/phase-contract.ts";
import type { JsonValue } from "../../harness/canonical.ts";
import type { BuiltinWorkflowResolver } from "../../harness/workflow/loader.ts";
import type { WorkflowDefinitionV1, WorkflowObligationDefinition, WorkflowPhaseDefinition } from "../../harness/workflow/types.ts";
import { CAD_PHASES, type CadPhase, type MutationPolicy } from "../../shared/protocol.ts";
import { MATURITIES, obligationsOf, routeKey, type Route, type RouteLineage, type RouteStructure } from "../../shared/route.ts";
import { compiledSpec } from "../../workflows/index.ts";

const RECORD_CLOSERS: Record<string, string> = {
  requirements: "cad_commit_requirements",
  frame_context: "cad_commit_frame_context",
  plan: "cad_commit_plan",
  assembly_design: "cad_commit_assembly_design",
  interface_contracts: "cad_commit_interface_contracts",
};

function mutationPolicy(phase: CadPhase, overrides: Partial<Record<CadPhase, MutationPolicy>>): MutationPolicy {
  if (overrides[phase]) return overrides[phase]!;
  if (["build", "modify", "convert"].includes(phase)) return "source_only";
  if (["gap_closure", "package"].includes(phase)) return "allowed";
  return "read_only";
}

function writeScopes(policy: MutationPolicy, grants: readonly string[]): string[] {
  if (policy === "allowed") return ["project:deliverable", "project:recipe", "project:source"];
  if (policy === "source_only") return ["project:deliverable", "project:recipe", "project:source"];
  return grants.includes("file_edit_recipe") ? ["project:recipe"] : [];
}

function extraActions(phase: CadPhase, acceptedPhases: CadPhase[]): string[] {
  const actions: string[] = [];
  if (!["intake", "requirements", "ready", "done"].includes(phase)) actions.push("cad_reroute");
  if (!["intake", "done"].includes(phase)) actions.push("cad_revise_requirements");
  if (!["intake", "ready", "done"].includes(phase)) actions.push("cad_defer_clarification", "cad_declare_blocker");
  if (acceptedPhases.includes(phase)) actions.push("cad_submit_for_review");
  return actions;
}

function evidenceAtSource(route: Route): WorkflowObligationDefinition[] {
  if (route.objective !== "design") return [];
  const definitions: WorkflowObligationDefinition[] = [
    { ref: "evidence:visual", type: "visual", closeWith: "cad_commit_candidate", dependsOn: ["record:requirements"] },
    { ref: "evidence:geometry", type: "geometry", closeWith: "cad_commit_candidate", dependsOn: ["record:requirements"] },
  ];
  if (route.lineage === "legacy" || route.maturity === "release") {
    definitions.push({ ref: "evidence:compare", type: "compare", closeWith: "cad_commit_candidate", dependsOn: ["record:requirements"] });
  }
  for (const key of obligationsOf(route)) {
    if (!key.startsWith("evidence:")) continue;
    const type = key.slice("evidence:".length);
    definitions.push({ ref: key, type, closeWith: "cad_commit_candidate", dependsOn: ["record:requirements"] });
  }
  return [...new Map(definitions.map((item) => [item.ref, item])).values()];
}

function recipeEvidenceForPhase(route: Route, phase: CadPhase, actions: readonly string[]): WorkflowObligationDefinition[] {
  const definitions: WorkflowObligationDefinition[] = [];
  if (obligationsOf(route).has("evidence:drawing") && actions.includes("cad_generate_drawing") && !["ready", "done"].includes(phase)) {
    definitions.push({ ref: "evidence:drawing", type: "drawing", closeWith: "cad_generate_drawing", recipeKind: "drawing", requiredOutputs: ["drawing_svg", "drawing_dxf"], dependsOn: ["record:requirements"] });
  }
  if (route.objective === "design" && route.maturity === "release" && ["audit", "gap_closure", "package", "final_review"].includes(phase) && actions.includes("cad_render_scene")) {
    definitions.push({
      ref: "evidence:presentation", type: "presentation", closeWith: "cad_render_scene", recipeKind: "presentation",
      requiredOutputs: route.structure === "assembly" ? ["hero", "turntable", "exploded", "assembly"] : ["hero", "turntable"],
      dependsOn: ["record:requirements"],
    });
  }
  return definitions;
}

export function mechanicalWorkflowDefinition(route: Route): WorkflowDefinitionV1 {
  const spec = compiledSpec(route);
  const transitions = new Map<CadPhase, Record<string, { target: string }>>();
  const add = (from: CadPhase, event: string, target: CadPhase) => {
    const row = transitions.get(from) ?? {};
    const existing = row[event];
    if (existing && existing.target !== target) throw new Error(`Mechanical adapter transition conflict: ${from}.${event}`);
    row[event] = { target };
    transitions.set(from, row);
  };
  add("requirements", "requirements_committed", spec.nextAfterRequirements);
  for (const [from, row] of Object.entries(spec.transitions) as Array<[CadPhase, Record<string, CadPhase>]>) {
    for (const [event, target] of Object.entries(row)) add(from, event, target);
  }
  for (const [from, target] of Object.entries(spec.planNext) as Array<[CadPhase, CadPhase]>) add(from, "plan_committed", target);
  for (const from of spec.planStayPhases) add(from, "plan_committed", from);
  for (const from of spec.sourcePhases) add(from, "candidate_committed", spec.sourcePhaseReviews?.[from] ?? spec.candidateReviewPhase);
  add("ready", "finished", "done");

  const reachable = new Set<CadPhase>();
  const queue: CadPhase[] = ["requirements"];
  while (queue.length) {
    const phase = queue.shift()!;
    if (reachable.has(phase)) continue;
    reachable.add(phase);
    queue.push(...Object.values(transitions.get(phase) ?? {}).map((item) => item.target as CadPhase));
  }
  const sourceEvidence = evidenceAtSource(route);
  const phases: Record<string, WorkflowPhaseDefinition> = {};
  for (const phase of CAD_PHASES.filter((item) => reachable.has(item))) {
    const grantIds = [...phaseContract(phase).grants];
    const actions = [...new Set([...contractTools(phaseContract(phase)), ...extraActions(phase, spec.acceptedPhases)])].sort();
    const recordTypes = phase === "requirements" ? ["requirements"] : [...(spec.phaseRecords[phase] ?? [])];
    const recordObligations: WorkflowObligationDefinition[] = recordTypes.map((type) => ({
      ref: type === "requirements" ? "record:requirements" : `record:${type}:${phase}`,
      type,
      closeWith: RECORD_CLOSERS[type]!,
      ...(type !== "requirements" ? { dependsOn: ["record:requirements"] } : {}),
    }));
    if (actions.includes("cad_commit_plan")) {
      recordObligations.push({
        ref: `record:plan:${phase}`, type: "plan", closeWith: "cad_commit_plan", dependsOn: ["record:requirements"],
        ...(spec.planNext[phase] || phase === "audit" ? {} : { required: false }),
      });
    }
    const isSource = spec.sourcePhases.includes(phase);
    const providers = ["kernel.current-action", "mechanical.mission"];
    if (grantIds.includes("observe")) providers.push("mechanical.observations");
    if (grantIds.includes("simulate")) providers.push("mechanical.runtime-availability");
    phases[phase] = {
      purpose: PHASE_PURPOSES[phase],
      actions,
      grants: grantIds,
      writeScopes: writeScopes(mutationPolicy(phase, spec.mutationPolicies ?? {}), grantIds),
      recordObligations,
      evidenceObligations: [...(isSource ? sourceEvidence : []), ...recipeEvidenceForPhase(route, phase, actions)],
      contextProviders: providers,
      hooks: isSource ? ["mechanical.candidate.observe"] : [],
      ...(spec.acceptedPhases.includes(phase) ? { reviewProfile: phase === "final_review" ? "mechanical.final-review" : "mechanical.design-review" } : {}),
      transitions: Object.fromEntries(Object.entries(transitions.get(phase) ?? {}).map(([event, value]) => [event, {
        ...value,
        ...(["revise", "repair", "engineering_issue", "artifact_issue"].includes(event) ? {} : { requiresPhaseObligations: true }),
      }])),
      ...(phase === "done" ? { terminal: true } : {}),
    };
  }
  return {
    schema: 1,
    id: `mechanical/${routeKey(route)}`,
    version: "1.0.0",
    parametersSchema: { type: "object", additionalProperties: false },
    initialPhase: "requirements",
    phases,
  };
}

function workspaceCommitLabel(ref: string): string {
  return ref.replace(/^record:/, "").replaceAll(":", "-").replaceAll("_", "-");
}

/**
 * Prime/Plan C projection of the Mechanical process. The route and transition
 * graph stay identical, while semantic record tools become generic workspace
 * commits and candidate evidence is closed by the managed model build.
 */
export function mechanicalPlanCWorkflowDefinition(route: Route): WorkflowDefinitionV1 {
  const source = mechanicalWorkflowDefinition(route);
  const labels = new Map<string, string>();
  for (const phase of Object.values(source.phases)) {
    for (const obligation of phase.recordObligations) labels.set(obligation.ref, workspaceCommitLabel(obligation.ref));
  }
  const dependency = (ref: string) => labels.get(ref) ?? ref;
  return {
    ...source,
    id: `${source.id}/plan-c`,
    phases: Object.fromEntries(Object.entries(source.phases).map(([phaseId, phase]) => {
      const candidatePhase = phase.actions.includes("cad_commit_candidate");
      const records = phase.recordObligations.map((obligation) => ({
        ...obligation,
        ref: labels.get(obligation.ref)!,
        type: "workspace_commit",
        closeWith: "cad_commit",
        ...(obligation.dependsOn ? { dependsOn: obligation.dependsOn.map(dependency) } : {}),
      }));
      if (candidatePhase) records.push({
        ref: `candidate-${phaseId.replaceAll("_", "-")}`,
        type: "workspace_commit",
        closeWith: "cad_commit",
        dependsOn: labels.has("record:requirements") ? [labels.get("record:requirements")!] : [],
      });
      const actions = [...new Set(phase.actions.map((action) =>
        Object.values(RECORD_CLOSERS).includes(action) || action === "cad_commit_candidate" ? "cad_commit" : action,
      ).concat(candidatePhase ? ["cad_build_step"] : [], Object.keys(phase.transitions).length ? ["transition"] : []))];
      return [phaseId, {
        ...phase,
        ...(["concept", "system_concept"].includes(phaseId)
          ? { grants: [...new Set([...phase.grants, "image_generate"])] }
          : {}),
        actions,
        recordObligations: records,
        evidenceObligations: phase.evidenceObligations.map((obligation) => ({
          ...obligation,
          ...(obligation.closeWith === "cad_commit_candidate" && ["visual", "geometry"].includes(obligation.type) ? { closeWith: "cad_build_step" } : {}),
          ...(obligation.dependsOn ? { dependsOn: obligation.dependsOn.map(dependency) } : {}),
        })),
      }];
    })),
  };
}

export function mechanicalIntakeWorkflow(): WorkflowDefinitionV1 {
  return {
    schema: 1,
    id: "mechanical/intake",
    version: "1.0.0",
    parametersSchema: { type: "object", additionalProperties: false },
    initialPhase: "intake",
    phases: {
      intake: {
        purpose: PHASE_PURPOSES.intake,
        actions: ["cad_route"],
        grants: ["file_read", "route"],
        writeScopes: [], recordObligations: [], evidenceObligations: [],
        contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true,
      },
    },
  };
}

function allRoutes(): Route[] {
  const routes: Route[] = [{ objective: "analyze" }, { objective: "convert" }];
  for (const lineage of ["greenfield", "legacy", "hybrid"] as RouteLineage[]) {
    for (const structure of ["part", "assembly"] as RouteStructure[]) {
      for (const maturity of MATURITIES) routes.push({ objective: "design", lineage, structure, maturity });
    }
  }
  return routes;
}

export function mechanicalBuiltinWorkflows(): ReadonlyMap<string, BuiltinWorkflowResolver> {
  const entries: Array<[string, BuiltinWorkflowResolver]> = [["builtin:mechanical/intake@1", () => mechanicalIntakeWorkflow()]];
  for (const route of allRoutes()) entries.push([`builtin:mechanical/${routeKey(route)}@1`, (_parameters: Record<string, JsonValue>) => mechanicalWorkflowDefinition(route)]);
  return new Map(entries);
}

export const MECHANICAL_ROUTES = Object.freeze(allRoutes());
