import { canonicalDigest, jsonValue } from "../canonical.ts";
import type { RegistrySet } from "../registry.ts";
import type { WorkflowDefinitionV1, WorkflowObligationDefinition, WorkflowPhaseDefinition, WorkflowSnapshotV1 } from "./types.ts";

const ID = /^[a-z][a-z0-9_]*(?:[.:/-][a-z0-9_]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const SCOPE = /^(?:project|run):[a-z][a-z0-9_-]*$/;

function exactKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${where} has unknown fields: ${unknown.join(", ")}`);
}

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${where} must be a string array`);
  if (new Set(value).size !== value.length) throw new Error(`${where} contains duplicates`);
  return [...value].sort();
}

function obligation(value: unknown, where: string): WorkflowObligationDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const raw = value as Record<string, unknown>;
  exactKeys(raw, ["ref", "type", "closeWith", "recipeKind", "requiredOutputs", "required", "dependsOn"], where);
  for (const key of ["ref", "type", "closeWith"] as const) if (typeof raw[key] !== "string" || !raw[key]) throw new Error(`${where}.${key} is required`);
  if (raw.recipeKind !== undefined && (typeof raw.recipeKind !== "string" || !raw.recipeKind)) throw new Error(`${where}.recipeKind must be a string`);
  const dependsOn = raw.dependsOn === undefined ? undefined : stringArray(raw.dependsOn, `${where}.dependsOn`);
  const requiredOutputs = raw.requiredOutputs === undefined ? undefined : stringArray(raw.requiredOutputs, `${where}.requiredOutputs`);
  if (requiredOutputs?.length && !raw.recipeKind) throw new Error(`${where}.requiredOutputs requires recipeKind`);
  if (raw.required !== undefined && typeof raw.required !== "boolean") throw new Error(`${where}.required must be boolean`);
  return { ref: raw.ref as string, type: raw.type as string, closeWith: raw.closeWith as string, ...(raw.recipeKind ? { recipeKind: raw.recipeKind as string } : {}), ...(requiredOutputs?.length ? { requiredOutputs } : {}), ...(raw.required === false ? { required: false } : {}), ...(dependsOn?.length ? { dependsOn } : {}) };
}

function phase(value: unknown, phaseId: string, registries: RegistrySet): WorkflowPhaseDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`phase ${phaseId} must be an object`);
  const raw = value as Record<string, unknown>;
  exactKeys(raw, ["purpose", "guidance", "recommendedTemplates", "recommendedSkills", "actions", "grants", "writeScopes", "recordObligations", "evidenceObligations", "contextProviders", "hooks", "reviewProfile", "transitions", "terminal"], `phase ${phaseId}`);
  if (typeof raw.purpose !== "string" || !raw.purpose.trim()) throw new Error(`phase ${phaseId}.purpose is required`);
  if (raw.guidance !== undefined && (typeof raw.guidance !== "string" || !raw.guidance.trim())) throw new Error(`phase ${phaseId}.guidance must be a non-empty string`);
  const recommendedTemplates = raw.recommendedTemplates === undefined ? undefined : stringArray(raw.recommendedTemplates, `phase ${phaseId}.recommendedTemplates`);
  const recommendedSkills = raw.recommendedSkills === undefined ? undefined : stringArray(raw.recommendedSkills, `phase ${phaseId}.recommendedSkills`);
  const actions = stringArray(raw.actions ?? [], `phase ${phaseId}.actions`);
  const grants = stringArray(raw.grants ?? [], `phase ${phaseId}.grants`);
  const writeScopes = stringArray(raw.writeScopes ?? [], `phase ${phaseId}.writeScopes`);
  const contextProviders = stringArray(raw.contextProviders ?? [], `phase ${phaseId}.contextProviders`);
  const hooks = stringArray(raw.hooks ?? [], `phase ${phaseId}.hooks`);
  for (const id of actions) registries.actions.require(id);
  for (const id of grants) registries.grants.require(id);
  for (const id of contextProviders) registries.contextProviders.require(id);
  for (const id of hooks) registries.hooks.require(id);
  if (raw.reviewProfile !== undefined) {
    if (typeof raw.reviewProfile !== "string" || !raw.reviewProfile) throw new Error(`phase ${phaseId}.reviewProfile must be a string`);
    registries.reviewProfiles.require(raw.reviewProfile);
  }
  const allowedScopes = new Set(grants.flatMap((id) => {
    const schema = registries.grants.require(id).contract.schema as Record<string, unknown>;
    return Array.isArray(schema.maxWriteScopes) ? schema.maxWriteScopes.filter((item): item is string => typeof item === "string") : [];
  }));
  for (const scope of writeScopes) {
    if (!SCOPE.test(scope)) throw new Error(`phase ${phaseId} has invalid write scope: ${scope}`);
    if (!allowedScopes.has(scope)) throw new Error(`phase ${phaseId} write scope exceeds its grants: ${scope}`);
  }
  const recordObligations = (raw.recordObligations ?? []) as unknown[];
  const evidenceObligations = (raw.evidenceObligations ?? []) as unknown[];
  if (!Array.isArray(recordObligations) || !Array.isArray(evidenceObligations)) throw new Error(`phase ${phaseId} obligations must be arrays`);
  const records = recordObligations.map((item, index) => obligation(item, `phase ${phaseId}.recordObligations[${index}]`));
  const evidence = evidenceObligations.map((item, index) => obligation(item, `phase ${phaseId}.evidenceObligations[${index}]`));
  for (const item of records) {
    registries.recordTypes.require(item.type);
    registries.actions.require(item.closeWith);
    if (!actions.includes(item.closeWith)) throw new Error(`phase ${phaseId} cannot close ${item.ref}: action ${item.closeWith} is not enabled`);
    if (item.recipeKind || item.requiredOutputs) throw new Error(`record obligation ${item.ref} cannot declare Recipe requirements`);
  }
  for (const item of evidence) {
    registries.evidenceTypes.require(item.type);
    registries.actions.require(item.closeWith);
    if (!actions.includes(item.closeWith)) throw new Error(`phase ${phaseId} cannot close ${item.ref}: action ${item.closeWith} is not enabled`);
    if (item.recipeKind) registries.recipeKinds.require(item.recipeKind);
  }
  if (!raw.transitions || typeof raw.transitions !== "object" || Array.isArray(raw.transitions)) throw new Error(`phase ${phaseId}.transitions must be an object`);
  const transitions: WorkflowPhaseDefinition["transitions"] = {};
  for (const [event, candidate] of Object.entries(raw.transitions as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ID.test(event) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`phase ${phaseId} has invalid transition ${event}`);
    const transition = candidate as Record<string, unknown>;
    exactKeys(transition, ["target", "authority", "terminalStatus", "requiresPhaseObligations", "reviewVerdicts", "requiresVisited", "forbidsVisited", "invalidate"], `phase ${phaseId}.transitions.${event}`);
    if (typeof transition.target !== "string" || !transition.target) throw new Error(`phase ${phaseId}.transitions.${event}.target is required`);
    if (transition.authority !== undefined && (typeof transition.authority !== "string" || !transition.authority)) throw new Error(`phase ${phaseId}.transitions.${event}.authority must be a string`);
    if (transition.authority && grants.some((grant) => grant === transition.authority || grant === `authority:${transition.authority}`)) throw new Error(`phase ${phaseId} attempts to self-grant authority ${transition.authority}`);
    if (transition.terminalStatus !== undefined && (typeof transition.terminalStatus !== "string" || !transition.terminalStatus)) throw new Error(`phase ${phaseId}.transitions.${event}.terminalStatus must be a string`);
    if (transition.requiresPhaseObligations !== undefined && typeof transition.requiresPhaseObligations !== "boolean") throw new Error(`phase ${phaseId}.transitions.${event}.requiresPhaseObligations must be boolean`);
    const reviewVerdicts = transition.reviewVerdicts === undefined ? undefined : stringArray(transition.reviewVerdicts, `phase ${phaseId}.transitions.${event}.reviewVerdicts`);
    if (reviewVerdicts?.some((verdict) => !["pass", "fail", "unresolved"].includes(verdict))) throw new Error(`phase ${phaseId}.transitions.${event}.reviewVerdicts contains an invalid verdict`);
    if (reviewVerdicts?.length && !raw.reviewProfile) throw new Error(`phase ${phaseId}.transitions.${event}.reviewVerdicts requires reviewProfile`);
    const requiresVisited = transition.requiresVisited === undefined ? undefined : stringArray(transition.requiresVisited, `phase ${phaseId}.transitions.${event}.requiresVisited`);
    const forbidsVisited = transition.forbidsVisited === undefined ? undefined : stringArray(transition.forbidsVisited, `phase ${phaseId}.transitions.${event}.forbidsVisited`);
    const invalidate = transition.invalidate === undefined ? undefined : stringArray(transition.invalidate, `phase ${phaseId}.transitions.${event}.invalidate`);
    transitions[event] = {
      target: transition.target as string,
      ...(transition.authority ? { authority: transition.authority as string } : {}),
      ...(transition.terminalStatus ? { terminalStatus: transition.terminalStatus as string } : {}),
      ...(transition.requiresPhaseObligations === true ? { requiresPhaseObligations: true } : {}),
      ...(reviewVerdicts?.length ? { reviewVerdicts: reviewVerdicts as Array<"pass" | "fail" | "unresolved"> } : {}),
      ...(requiresVisited?.length ? { requiresVisited } : {}),
      ...(forbidsVisited?.length ? { forbidsVisited } : {}),
      ...(invalidate?.length ? { invalidate } : {}),
    };
  }
  if (raw.terminal !== undefined && typeof raw.terminal !== "boolean") throw new Error(`phase ${phaseId}.terminal must be boolean`);
  if (raw.terminal === true && Object.keys(transitions).length) throw new Error(`terminal phase ${phaseId} cannot have transitions`);
  return {
    purpose: raw.purpose.trim(),
    ...(raw.guidance ? { guidance: (raw.guidance as string).trim() } : {}),
    ...(recommendedTemplates?.length ? { recommendedTemplates } : {}),
    ...(recommendedSkills?.length ? { recommendedSkills } : {}),
    actions, grants, writeScopes,
    recordObligations: records.sort((a, b) => a.ref.localeCompare(b.ref)),
    evidenceObligations: evidence.sort((a, b) => a.ref.localeCompare(b.ref)),
    contextProviders, hooks,
    ...(raw.reviewProfile ? { reviewProfile: raw.reviewProfile as string } : {}),
    transitions,
    ...(raw.terminal === true ? { terminal: true } : {}),
  };
}

export function compileWorkflowDefinition(value: unknown, registries: RegistrySet): WorkflowSnapshotV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflow must be an object");
  const raw = value as Record<string, unknown>;
  exactKeys(raw, ["schema", "id", "version", "parametersSchema", "initialPhase", "phases"], "workflow");
  if (raw.schema !== 1) throw new Error("unsupported workflow schema");
  if (typeof raw.id !== "string" || !ID.test(raw.id)) throw new Error("workflow.id is invalid");
  if (typeof raw.version !== "string" || !VERSION.test(raw.version)) throw new Error("workflow.version is invalid");
  if (typeof raw.initialPhase !== "string" || !ID.test(raw.initialPhase)) throw new Error("workflow.initialPhase is invalid");
  if (!raw.phases || typeof raw.phases !== "object" || Array.isArray(raw.phases)) throw new Error("workflow.phases must be an object");
  const phases: Record<string, WorkflowPhaseDefinition> = {};
  for (const [id, definition] of Object.entries(raw.phases as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ID.test(id)) throw new Error(`invalid phase ID: ${id}`);
    phases[id] = phase(definition, id, registries);
  }
  if (!phases[raw.initialPhase]) throw new Error(`initial phase does not exist: ${raw.initialPhase}`);
  for (const [id, definition] of Object.entries(phases)) {
    for (const [event, transition] of Object.entries(definition.transitions)) {
      if (!phases[transition.target]) throw new Error(`transition target does not exist: ${id}.${event} -> ${transition.target}`);
      for (const visited of [...(transition.requiresVisited ?? []), ...(transition.forbidsVisited ?? [])]) {
        if (!phases[visited]) throw new Error(`transition phase-history condition does not exist: ${id}.${event} -> ${visited}`);
      }
    }
  }
  const obligationRefs = new Set(Object.values(phases).flatMap((item) => [...item.recordObligations, ...item.evidenceObligations]).map((item) => item.ref));
  for (const [id, definition] of Object.entries(phases)) for (const [event, transition] of Object.entries(definition.transitions)) {
    for (const ref of transition.invalidate ?? []) if (!obligationRefs.has(ref)) throw new Error(`transition invalidation ref does not exist: ${id}.${event} -> ${ref}`);
  }
  for (const [id, definition] of Object.entries(phases)) {
    for (const item of [...definition.recordObligations, ...definition.evidenceObligations]) {
      for (const dependency of item.dependsOn ?? []) {
        if (!obligationRefs.has(dependency)) throw new Error(`obligation dependency does not exist: ${id}.${item.ref} -> ${dependency}`);
        if (dependency === item.ref) throw new Error(`obligation cannot depend on itself: ${item.ref}`);
      }
    }
  }
  const reachable = new Set<string>();
  const queue = [raw.initialPhase];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...Object.values(phases[id]!.transitions).map((transition) => transition.target));
  }
  const unreachable = Object.keys(phases).filter((id) => !reachable.has(id));
  if (unreachable.length) throw new Error(`workflow contains unreachable phases: ${unreachable.join(", ")}`);
  if (![...reachable].some((id) => phases[id]!.terminal)) throw new Error("workflow has no reachable terminal phase");
  const body: WorkflowDefinitionV1 = {
    schema: 1,
    id: raw.id,
    version: raw.version,
    parametersSchema: jsonValue(raw.parametersSchema ?? { type: "object", additionalProperties: false }),
    initialPhase: raw.initialPhase,
    phases,
  };
  return { ...body, hash: canonicalDigest(body) };
}
