import { allPhaseContracts, contractTools, phaseContract } from "../control/phase-contract.ts";
import {
  ACTIVE_PUBLIC_TOOLS,
  ACTIVE_PUBLIC_TOOL_NAMES,
  type ActivePublicTool,
  type PublicToolGroup,
} from "../shared/public-tools.ts";
import { CAD_PHASES, type CadPhase, type CadRunState } from "../shared/protocol.ts";
import {
  MATURITIES,
  obligationsOf,
  routeKey,
  type Route,
  type RouteLineage,
  type RouteStructure,
} from "../shared/route.ts";
import { compiledSpec } from "../workflows/index.ts";
import { toolsForState } from "./policies.ts";

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

export const TOOL_PURPOSES: Record<ActivePublicTool, string> = {
  cad_route: "Select the route that compiles the workflow and obligations.",
  cad_reroute: "Change route without bypassing obligations; downgrades require authority.",
  cad_commit_requirements: "Commit the first complete mission and acceptance contract.",
  cad_revise_requirements: "Replace requirements after authoritative information changes.",
  cad_commit_frame_context: "Record the interpretation of an imported coordinate frame.",
  cad_commit_plan: "Commit the implementation or investigation plan owed by this phase.",
  cad_commit_assembly_design: "Commit modules, datums, ownership, and assembly sequence.",
  cad_commit_interface_contracts: "Commit locating, DOF, fit, fastening, and access contracts.",
  cad_commit_candidate: "Build and propose source-authored CAD with automatic observations.",
  cad_submit_for_review: "Submit the immutable candidate for independent final verification.",
  cad_transition: "Apply one legal decision event from the compiled workflow.",
  cad_wait_for_user: "Pause an interactive workflow for a user-owned decision.",
  cad_defer_clarification: "Record a bounded headless assumption and continue.",
  cad_declare_blocker: "Stop honestly on missing authority or indispensable external input.",
  cad_finish: "Close a ready workflow after deterministic checks.",
  cad_commit_simulation: "Bind one immutable run/observation to a simulation case obligation.",
  cad_probe: "Inspect an artifact through a strict typed or programmable read-only probe.",
  cad_recall_observation: "Recover an observation summary, visuals, or paged detail collection.",
  cad_build_step: "Execute deterministic build123d source without accepting Project Head.",
  cad_derive_analysis_model: "Create a provenance-bound solver derivation.",
  cad_simulate: "Run a solver-native Recipe in a managed runtime; creates no Evidence.",
  cad_sim_observe: "Re-run only the observer over a frozen SimulationRun.",
  cad_optimize: "Produce a managed torch-fem optimization artifact.",
  cad_export: "Create geometry sidecars without changing Project Head.",
  cad_generate_drawing: "Generate a structured drawing from declared intent.",
  cad_render_scene: "Create presentation assets from an explicit scene specification.",
  cad_experience_search: "Search persistent historical CAD trajectories without semantic summarization.",
  cad_experience_get: "Retrieve canonical metadata for one historical trajectory.",
  cad_experience_read: "Read a bounded line range from a readable historical transcript.",
  cad_experience_find: "Find keyword occurrences within one historical transcript.",
};

export const PHASE_PURPOSES: Record<CadPhase, string> = {
  intake: "Choose the route before engineering work.",
  requirements: "Commit the authoritative mission and acceptance contract.",
  baseline: "Understand the existing design and its frame.",
  source_baseline: "Understand the source before conversion.",
  plan: "Plan modifications to a legacy part.",
  transform_plan: "Plan deterministic conversion.",
  concept: "Select a coherent hybrid-part concept.",
  system_concept: "Select the assembly architecture.",
  domain_analysis: "Resolve a bounded domain question before concept selection.",
  part_design: "Commit the part implementation plan.",
  assembly_design: "Commit module ownership, datums, and install sequence.",
  interface_design: "Commit explicit module interface contracts.",
  build: "Author and propose greenfield or hybrid CAD.",
  modify: "Author and propose legacy CAD changes.",
  convert: "Produce and propose the converted artifact.",
  review: "Interpret current part evidence and decide acceptance or regression.",
  compare: "Compare converted output to its source.",
  integration_review: "Verify the complete assembly, interfaces, interference, and simulations.",
  investigate: "Probe an artifact until the relevant cause is understood.",
  explain: "Deliver evidence-bound analysis findings.",
  audit: "Audit release workstreams and identify gaps.",
  gap_closure: "Author engineering changes that close release gaps.",
  package: "Create closure deliverables without inventing engineering intent.",
  final_review: "Verify release evidence and deliverables.",
  ready: "Perform deterministic closure checks and finish.",
  done: "Terminal completed workflow.",
};

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
  if (category === "experience") return "pi-cad-tools/references/cookbooks/experience.md";
  if (category === "control") return "pi-cad/references/cookbooks/workflow-records.md";
  if (category === "probe") return "pi-cad-tools/references/cookbooks/probe.md";
  if (category === "simulation") return "pi-cad-tools/references/cookbooks/simulation-recipes.md";
  return `pi-cad-tools/references/cookbooks/${category === "model" ? "modeling" : category}.md`;
}

function phasesForTool(name: ActivePublicTool): CadPhase[] {
  if ((ACTIVE_PUBLIC_TOOLS.experience as readonly string[]).includes(name)) return [...CAD_PHASES];
  const base = allPhaseContracts().filter((item) => contractTools(item).includes(name)).map((item) => item.phase);
  if (name === "cad_reroute") return CAD_PHASES.filter((phase) => !["intake", "requirements", "ready", "done"].includes(phase));
  if (name === "cad_revise_requirements") return CAD_PHASES.filter((phase) => !["intake", "done"].includes(phase));
  if (name === "cad_submit_for_review") return ["review", "compare", "integration_review", "final_review"];
  if (name === "cad_defer_clarification" || name === "cad_declare_blocker") return CAD_PHASES.filter((phase) => !["intake", "ready", "done"].includes(phase));
  return base;
}

function availabilityFor(name: ActivePublicTool): string | undefined {
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

function writeScope(state: CadRunState): string {
  const grants = new Set(phaseContract(state.phase).grants);
  if (state.mutationPolicy === "allowed") return "project files allowed by policy; .pi-cad is harness-owned";
  if (state.mutationPolicy === "source_only") return "Python model sources, models/**, and simulation/**";
  if (grants.has("file_edit_recipe")) return "simulation/** only; design CAD is read-only";
  return "read-only";
}

function recommendation(state: CadRunState, missing: string[], available: string[], events: string[]): string {
  if (state.routeRequiresReassessment) return "Resolve requirements reassessment with cad_revise_requirements/cad_reroute.";
  if (state.phase === "intake") return "Call cad_route.";
  if (state.phase === "requirements" && !state.requirementsVersion) return "Call cad_commit_requirements with the complete contract.";
  if (missing.length) {
    if (missing[0].startsWith("simulation:")) return "Author or inspect the case Recipe, run simulate/observe as needed, then commit the exact valid observation to this case.";
    const tool = missing[0] === "frame_context" ? "cad_commit_frame_context" : missing[0] === "assembly_design" ? "cad_commit_assembly_design" : missing[0] === "interface_contracts" ? "cad_commit_interface_contracts" : "the dedicated cad_commit_* tool";
    return `Commit missing ${missing[0]} through ${tool}.`;
  }
  if (["build", "modify", "convert", "gap_closure"].includes(state.phase) && available.includes("cad_commit_candidate")) return "Author source/sidecar work, then call cad_commit_candidate.";
  if (state.phase === "ready") return "Call cad_finish after checking closure artifacts.";
  if (available.includes("cad_submit_for_review")) return "Call cad_submit_for_review when every obligation is current.";
  if (events.includes("accepted")) return "Interpret current evidence; accept only when every current-version obligation is satisfied.";
  return "Use the first unmet obligation or a legal event shown here; never invent a transition name.";
}

function unmetEvidenceObligations(state: CadRunState): string[] {
  const simulation = state.evidenceObligations?.simulation;
  if (!simulation || simulation.disposition !== "required") return [];
  const subjectHash = state.route?.objective === "analyze" ? state.baselineArtifactHash : state.currentArtifactHash;
  const cases = simulation.cases ?? [];
  if (!cases.length) return state.evidence.some((item) => item.kind === "simulation" && item.artifactHash === subjectHash) ? [] : ["simulation:any-current-case"];
  return cases.filter((caseItem) => !state.evidence.some((item) => item.kind === "simulation" && item.tool === caseItem.tool && item.caseId === caseItem.id && item.artifactHash === subjectHash)).map((item) => `simulation:${item.id} via ${item.tool}`);
}

export function renderCurrentActionCard(state: CadRunState, simulationCapabilities = ""): string {
  const spec = state.route ? compiledSpec(state.route) : null;
  const available = toolsForState(state).filter((name) => name.startsWith("cad_"));
  const records = spec?.phaseRecords[state.phase] ?? [];
  const committed = new Set(state.phaseRecords ?? []);
  const missing = records.filter((record) => !committed.has(record));
  const unmetEvidence = unmetEvidenceObligations(state);
  const allMissing = [...missing, ...unmetEvidence];
  const transitions = spec?.transitions[state.phase] ?? {};
  const legal = Object.keys(transitions).filter((event) => !event.endsWith("_committed"));
  const commitOnly = Object.keys(transitions).filter((event) => event.endsWith("_committed"));
  const lines = [
    "## Pi-CAD Current Action Card (authoritative)", "",
    `Route / phase / status: ${state.route ? routeKey(state.route) : "unset"} / ${state.phase} / ${state.status}`,
    `Phase purpose: ${PHASE_PURPOSES[state.phase]}`,
    `Allowed writes: ${writeScope(state)}`, "", "Available Pi-CAD tools:",
    ...(available.length ? available.map((name) => `- ${name}: ${TOOL_PURPOSES[name as ActivePublicTool] ?? "Use its registered schema."}`) : ["- none"]), "",
    `Required records here: ${records.join(", ") || "none"}`,
    `Unmet records here: ${missing.join(", ") || "none"}`,
    `Unmet Evidence obligations: ${unmetEvidence.join(", ") || "none"}`,
    `Current evidence bindings: ${state.evidence.map((item) => `${item.kind}${item.caseId ? `:${item.caseId}` : ""}@${item.artifactHash.slice(0, 12)}`).join(", ") || "none"}`,
    `Current artifact: ${state.currentArtifactPath ?? "none"}${state.currentArtifactHash ? ` @ ${state.currentArtifactHash.slice(0, 12)}` : ""}`, "",
    "Legal cad_transition events:",
    ...(legal.length ? legal.map((event) => `- ${event} → ${transitions[event]}: ${eventDefinition(event).meaning}`) : ["- none"]),
    ...(commitOnly.length ? ["", `Commit-only events (never pass to cad_transition): ${commitOnly.join(", ")}`] : []), "",
    `Blocked guards: ${state.blocker ? `${state.blocker.type}: ${state.blocker.reason}; needed=${state.blocker.needed}` : state.routeRequiresReassessment ? "route reassessment required" : state.status === "waiting_user" ? "waiting for user" : "none"}`,
    `Recommended next action: ${recommendation(state, allMissing, available, legal)}`,
  ];
  if (simulationCapabilities.trim()) lines.push("", simulationCapabilities.trim());
  return lines.join("\n");
}

export function transitionFailureDetails(state: CadRunState, attemptedEvent: string) {
  const spec = state.route ? compiledSpec(state.route) : null;
  const row = spec?.transitions[state.phase] ?? {};
  const committed = new Set(state.phaseRecords ?? []);
  const unmetObligations = [...(spec?.phaseRecords[state.phase] ?? []).filter((record) => !committed.has(record)), ...unmetEvidenceObligations(state)];
  const allowedEvents = Object.entries(row).filter(([event]) => !event.endsWith("_committed")).map(([event, target]) => ({ event, meaning: eventDefinition(event).meaning, target }));
  const allowedCommitTools = [
    ...Object.keys(row).filter((event) => event.endsWith("_committed")).map((event) => event === "plan_committed" ? "cad_commit_plan" : event === "assembly_design_committed" ? "cad_commit_assembly_design" : event === "interface_contracts_committed" ? "cad_commit_interface_contracts" : "dedicated cad_commit_* tool"),
    ...(unmetObligations.some((item) => item.startsWith("simulation:")) && toolsForState(state).includes("cad_commit_simulation") ? ["cad_commit_simulation"] : []),
  ];
  return {
    phase: state.phase,
    attemptedEvent,
    allowedEvents,
    unmetObligations,
    allowedCommitTools,
    suggestedActions: [recommendation(state, unmetObligations, toolsForState(state), allowedEvents.map((item) => item.event))],
  };
}
