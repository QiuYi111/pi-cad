import { allPhaseContracts, contractTools, phaseContract } from "../domains/mechanical/phase-contract.ts";
import { PHASE_PURPOSES, TOOL_PURPOSES } from "../domains/mechanical/purposes.ts";
import {
  ACTIVE_PUBLIC_TOOLS,
  ACTIVE_PUBLIC_TOOL_NAMES,
  type ActivePublicTool,
  type PublicToolGroup,
} from "../shared/public-tools.ts";
import { CAD_PHASES, type CadPhase } from "../shared/protocol.ts";
import {
  MATURITIES,
  obligationsOf,
  routeKey,
  type Route,
  type RouteLineage,
  type RouteStructure,
} from "../shared/route.ts";
import { compiledSpec } from "../workflows/index.ts";

export interface ToolContract {
  name: ActivePublicTool;
  category: PublicToolGroup;
  purpose: string;
  inputSchema: unknown;
  phases: CadPhase[];
  availability?: string;
  writes: string[];
  produces: string[];
  lifecycle: string;
  success: string;
  failures: string[];
  cookbook: string;
}

export interface AgentPhaseContract {
  phase: CadPhase;
  purpose: string;
  mutationPolicy: string;
  grants: string[];
  tools: string[];
  requiredRecords: string[];
  events: Array<{ event: string; meaning: string; targets: CadPhase[] }>;
}

export interface TransitionEventContract {
  event: string;
  meaning: string;
  useWhen: string;
  doNotUseWhen: string;
  occurrences: Array<{ route: string; phase: CadPhase; target: CadPhase }>;
}

export interface ObligationContract {
  key: string;
  closeWith: string;
  invalidatedBy: string;
  recovery: string;
}

export interface AgentContract {
  schema: 1;
  architecture: {
    layers: Array<{ name: string; responsibility: string }>;
    invariants: string[];
  };
  tools: ToolContract[];
  phases: AgentPhaseContract[];
  events: TransitionEventContract[];
  obligations: ObligationContract[];
}

type EventDefinition = { meaning: string; useWhen: string; doNotUseWhen: string };

const EVENT_DEFINITIONS: Record<string, EventDefinition> = {
  baseline_understood: { meaning: "The bound baseline and frame are understood.", useWhen: "Baseline observations and frame record are current.", doNotUseWhen: "Baseline, frame, or required observations are missing." },
  plan_committed: { meaning: "The plan record was committed by its dedicated tool.", useWhen: "cad_commit_plan emitted it.", doNotUseWhen: "Never call cad_transition with it." },
  assembly_design_committed: { meaning: "The assembly record was committed.", useWhen: "cad_commit_assembly_design emitted it.", doNotUseWhen: "Never call cad_transition with it." },
  interface_contracts_committed: { meaning: "The interface records were committed.", useWhen: "cad_commit_interface_contracts emitted it.", doNotUseWhen: "Never call cad_transition with it." },
  revise: { meaning: "Return to source work for a bounded CAD, sidecar, or analysis-input revision.", useWhen: "Source-authored content must change without revisiting architecture.", doNotUseWhen: "Recipe/observer-only changes are allowed in simulation-capable review phases." },
  local_geometry_issue: { meaning: "A concrete local candidate-geometry defect needs source repair.", useWhen: "Evidence identifies a real geometry defect.", doNotUseWhen: "Do not use for Recipe, environment, or external-input failures." },
  intent_issue: { meaning: "The legacy modification plan misunderstood intent.", useWhen: "The intended change must be replanned.", doNotUseWhen: "Do not use for local implementation defects." },
  interface_or_detail_issue: { meaning: "Interface/detail contracts require redesign.", useWhen: "Locating, fit, access, or fastening intent is wrong.", doNotUseWhen: "Do not use for local solid defects." },
  architecture_issue: { meaning: "The part or assembly decomposition is wrong.", useWhen: "Module ownership or architecture must change.", doNotUseWhen: "Do not use for local geometry or solver failures." },
  accepted: { meaning: "Current evidence supports phase acceptance.", useWhen: "All current-version obligations and guards are satisfied.", doNotUseWhen: "Final closure uses cad_submit_for_review when active." },
  repair: { meaning: "The converted output needs another conversion pass.", useWhen: "Comparison found a conversion defect.", doNotUseWhen: "Do not use after verified equivalence." },
  more_probe: { meaning: "Continue with another targeted observation.", useWhen: "A specific unresolved question remains.", doNotUseWhen: "Do not repeat an identical probe without a new question or subject." },
  cause_understood: { meaning: "Evidence is sufficient to explain the condition.", useWhen: "Cause and limits are supported.", doNotUseWhen: "Material hypotheses remain untested." },
  findings_delivered: { meaning: "The evidence-bound analysis was delivered.", useWhen: "Required evidence and cases are closed.", doNotUseWhen: "Do not bypass required simulation evidence." },
  domain_work_needed: { meaning: "A bounded domain analysis is needed.", useWhen: "A physical question changes the concept.", doNotUseWhen: "Do not use for ordinary implementation judgment." },
  explore_more: { meaning: "Continue concept exploration.", useWhen: "Material alternatives remain.", doNotUseWhen: "Do not loop without a discriminating question." },
  direction_selected: { meaning: "The concept is ready for detailed design.", useWhen: "Tradeoffs and assumptions are recorded.", doNotUseWhen: "A required domain question remains." },
  domain_question_answered: { meaning: "The bounded domain question is answered.", useWhen: "Analysis can inform concept selection.", doNotUseWhen: "The question is unresolved or externally blocked." },
  audit_complete: { meaning: "Release workstreams were audited and classified.", useWhen: "Statuses are complete.", doNotUseWhen: "Workstreams remain unassessed." },
  workstreams_structurally_closed: { meaning: "Every release workstream has a non-open status.", useWhen: "Each is complete, not applicable, or blocked external.", doNotUseWhen: "Do not equate missing evidence with completion." },
  package_prepared: { meaning: "Closure deliverables are ready for review.", useWhen: "Package artifacts and provenance exist.", doNotUseWhen: "Package contents are missing or stale." },
  artifact_issue: { meaning: "Closure packaging artifacts need repair.", useWhen: "Engineering is acceptable but package output is defective.", doNotUseWhen: "Do not use for an engineering defect." },
  engineering_issue: { meaning: "Final review found an engineering gap.", useWhen: "Design or evidence must change.", doNotUseWhen: "Do not use for presentation-only defects." },
};

function eventDefinition(event: string): EventDefinition {
  return EVENT_DEFINITIONS[event] ?? {
    meaning: `Workflow decision ${event}.`,
    useWhen: "The current action card exposes it and its guards are satisfied.",
    doNotUseWhen: "It is absent from the current action card.",
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

function categoryOf(name: ActivePublicTool): PublicToolGroup {
  for (const [category, names] of Object.entries(ACTIVE_PUBLIC_TOOLS) as Array<[PublicToolGroup, readonly ActivePublicTool[]]>) {
    if (names.includes(name)) return category;
  }
  throw new Error(`active tool has no category: ${name}`);
}

function cookbookFor(category: PublicToolGroup): string {
  if (category === "control") return "pi-cad/references/cookbooks/workflow-records.md";
  if (category === "probe") return "pi-cad-tools/references/cookbooks/probe.md";
  if (category === "simulation") return "pi-cad-tools/references/cookbooks/simulation-recipes.md";
  return `pi-cad-tools/references/cookbooks/${category === "model" ? "modeling" : category}.md`;
}

function phasesForTool(name: ActivePublicTool): CadPhase[] {
  const base = allPhaseContracts().filter((item) => contractTools(item).includes(name)).map((item) => item.phase);
  if (name === "cad_reroute") return CAD_PHASES.filter((phase) => !["intake", "requirements", "ready", "done"].includes(phase));
  if (name === "cad_revise_requirements") return CAD_PHASES.filter((phase) => !["intake", "done"].includes(phase));
  if (name === "cad_submit_for_review") return ["review", "compare", "integration_review", "final_review"];
  if (name === "cad_defer_clarification" || name === "cad_declare_blocker") return CAD_PHASES.filter((phase) => !["intake", "ready", "done"].includes(phase));
  return base;
}

function availabilityFor(name: ActivePublicTool): string | undefined {
  if (name === "cad_start") return "Only when no active run exists; Mechanical tasks normally start with cad_route.";
  if (name === "cad_revise_requirements") return "After the first requirements commit.";
  if (name === "cad_submit_for_review") return "Only on a final accepted edge when independent review is enabled.";
  if (name === "cad_defer_clarification" || name === "cad_declare_blocker") return "Headless workflows only.";
  if (name === "cad_wait_for_user") return "Interactive workflows only.";
  return undefined;
}

export function buildAgentContract(inputSchemas: Partial<Record<ActivePublicTool, unknown>> = {}): AgentContract {
  const occurrences = new Map<string, TransitionEventContract["occurrences"]>();
  const phaseEvents = new Map<CadPhase, Map<string, Set<CadPhase>>>();
  const phaseRecords = new Map<CadPhase, Set<string>>();
  const obligationKeys = new Set<string>();

  for (const route of allRoutes()) {
    const spec = compiledSpec(route);
    for (const key of obligationsOf(route)) obligationKeys.add(key);
    for (const [phase, records] of Object.entries(spec.phaseRecords) as Array<[CadPhase, string[]]>) {
      const set = phaseRecords.get(phase) ?? new Set<string>();
      records.forEach((record) => set.add(record));
      phaseRecords.set(phase, set);
    }
    for (const [phase, row] of Object.entries(spec.transitions) as Array<[CadPhase, Record<string, CadPhase>]>) {
      const events = phaseEvents.get(phase) ?? new Map<string, Set<CadPhase>>();
      for (const [event, target] of Object.entries(row)) {
        const targets = events.get(event) ?? new Set<CadPhase>();
        targets.add(target);
        events.set(event, targets);
        occurrences.set(event, [...(occurrences.get(event) ?? []), { route: routeKey(route), phase, target }]);
      }
      phaseEvents.set(phase, events);
    }
  }

  const tools = ACTIVE_PUBLIC_TOOL_NAMES.map((name): ToolContract => {
    const category = categoryOf(name);
    return {
      name,
      category,
      purpose: TOOL_PURPOSES[name],
      inputSchema: inputSchemas[name] ?? { schemaSource: `liveToolRegistration:${name}`, failClosed: true },
      phases: phasesForTool(name),
      ...(availabilityFor(name) ? { availability: availabilityFor(name) } : {}),
      writes: category === "probe" ? ["run-owned observation storage only"] : category === "simulation" ? ["simulation/** and run-owned simulation storage"] : category === "control" ? ["workflow state, records, and journal"] : ["outputs allowed by current phase policy"],
      produces: name === "cad_simulate" ? ["SimulationRun", "ObservationSnapshot"] : name === "cad_sim_observe" ? ["ObservationSnapshot"] : name === "cad_commit_simulation" ? ["Simulation EvidenceRef"] : name === "cad_probe" ? ["Immutable ObservationSnapshot"] : ["Declared tool artifact or canonical workflow state"],
      lifecycle: category === "simulation" || name === "cad_commit_simulation" ? "author Recipe → simulate → optional re-observe → inspect → commit" : category === "probe" ? "resolve subject → observe → inspect summary → recall details when needed" : "Use only when exposed by the action card; inspect returned state/artifacts.",
      success: "The declared state/artifact operation completed; engineering PASS still requires workflow review.",
      failures: ["Reject invalid or phase-inapplicable input.", "Follow structured suggestedActions; never guess event or retry names."],
      cookbook: cookbookFor(category),
    };
  });

  const phases = CAD_PHASES.map((phase): AgentPhaseContract => {
    const contract = phaseContract(phase);
    return {
      phase,
      purpose: PHASE_PURPOSES[phase],
      mutationPolicy: ["build", "modify", "convert"].includes(phase) ? "source_only" : ["gap_closure", "package"].includes(phase) ? "allowed" : "read_only",
      grants: [...contract.grants],
      tools: contractTools(contract),
      requiredRecords: [...(phaseRecords.get(phase) ?? [])].sort(),
      events: [...(phaseEvents.get(phase) ?? [])].map(([event, targets]) => ({ event, meaning: eventDefinition(event).meaning, targets: [...targets].sort() })),
    };
  });

  const events = [...occurrences.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([event, items]) => ({ event, ...eventDefinition(event), occurrences: items }));
  const obligations = [...obligationKeys].sort().map((key): ObligationContract => {
    if (key.startsWith("record:")) return { key, closeWith: "The dedicated cad_commit_* tool.", invalidatedBy: "Requirements/reroute or review regression.", recovery: "Re-enter the owning phase and recommit the full record." };
    if (key.startsWith("evidence:")) return { key, closeWith: "The owning capability's evidence lifecycle.", invalidatedBy: "Artifact, requirements, input, case, or provenance change.", recovery: "Re-run against the current artifact and recommit when required." };
    if (key.startsWith("workstream:")) return { key, closeWith: "A truthful non-open release status.", invalidatedBy: "Requirements or release package change.", recovery: "Re-audit and regenerate affected outputs." };
    return { key, closeWith: "The current action card and owning cookbook.", invalidatedBy: "Authoritative state change.", recovery: "Return to the earliest owning phase." };
  });

  return {
    schema: 1,
    architecture: {
      layers: [
        { name: "Control Plane", responsibility: "Compile routes, enforce phases/obligations, and bind Evidence." },
        { name: "Context Runtime", responsibility: "Project canonical state, action cards, observation memory, and compaction." },
        { name: "Observation Layer", responsibility: "Return bounded semantic context plus immutable detail." },
        { name: "Capability Modules", responsibility: "MODEL, PROBE, SIMULATE, optimization, and deliverable execution." },
        { name: "Skills/Cookbooks", responsibility: "Teach operation and authoring without duplicating runtime state." },
      ],
      invariants: [
        "Project Head changes only through accepted workflow closure.",
        "Tool success is not engineering acceptance.",
        "Observations are immutable and hash-bound.",
        "Simulation creates Evidence only through cad_commit_simulation.",
        "The current action card is authoritative for tools, writes, obligations, and events.",
      ],
    }, tools, phases, events, obligations,
  };
}
