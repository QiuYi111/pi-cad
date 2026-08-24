import { canonicalDigest, jsonValue, type JsonValue } from "../../harness/canonical.ts";
import { commitRecordRef, finishRun, reviseRecordRef, transitionRun } from "../../harness/reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../../harness/run-store.ts";
import type { HarnessRunStateV7, RecordRefV7 } from "../../harness/state.ts";
import { RELEASE_WORKSTREAMS } from "../../shared/route.ts";
import { mechanicalRegistries } from "./registries.ts";

async function current(cwd: string) {
  const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!loaded) throw new Error("action requires an active v7 run");
  return loaded;
}

function recordObligation(loaded: Awaited<ReturnType<typeof current>>, type: string, revise: boolean) {
  const candidates = revise
    ? Object.values(loaded.workflow.phases).flatMap((phase) => phase.recordObligations)
    : loaded.workflow.phases[loaded.state.phase]!.recordObligations;
  const matching = candidates.filter((item) => item.type === type);
  if (matching.length !== 1) throw new Error(`expected one ${revise ? "workflow" : "current"} record obligation of type ${type}, got ${matching.length}`);
  return matching[0]!;
}

function completionEvent(type: string): string { return `${type}_committed`; }

export async function commitMechanicalRecordV7(input: {
  cwd: string;
  type: string;
  value: unknown;
  revise?: boolean;
  advance?: boolean;
}) {
  const loaded = await current(input.cwd);
  const obligation = recordObligation(loaded, input.type, input.revise === true);
  const sha256 = canonicalDigest(input.value);
  const path = `records/${input.type}/${sha256}.json`;
  const ref: RecordRefV7 = { obligationRef: obligation.ref, type: obligation.type, path, sha256, workflowHash: loaded.workflow.hash, createdAt: new Date().toISOString() };
  return new HarnessRunStoreV7(input.cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state, workflow }) => {
    let next = input.revise ? reviseRecordRef(state, workflow, ref) : commitRecordRef(state, workflow, ref);
    if (input.type === "plan" && input.value && typeof input.value === "object" && !Array.isArray(input.value)) {
      const workstreams = (input.value as { workstreams?: unknown }).workstreams;
      if (Array.isArray(workstreams)) {
        const statuses: Record<string, JsonValue> = {};
        for (const item of workstreams) {
          if (!item || typeof item !== "object" || typeof (item as any).name !== "string" || typeof (item as any).status !== "string") throw new Error("invalid release workstream status");
          statuses[(item as any).name] = (item as any).status;
        }
        next = { ...next, domainMetadata: { ...(next.domainMetadata ?? {}), workstreamStatuses: statuses }, updatedAt: new Date().toISOString() };
      }
    }
    const event = completionEvent(input.type);
    if (input.advance !== false && workflow.phases[next.phase]?.transitions[event]) next = transitionRun(next, workflow, event);
    return {
      state: next,
      event: { type: input.revise ? "RecordRevised" : "RecordCommitted", data: { obligationRef: obligation.ref, type: input.type, sha256, advancedBy: workflow.phases[state.phase]?.transitions[event] ? event : null } },
      payloads: { [path]: jsonValue(input.value) },
    };
  });
}

export async function transitionMechanicalRunV7(input: { cwd: string; event: string; note: string }) {
  const loaded = await current(input.cwd);
  if (input.event === "workstreams_structurally_closed") {
    const statuses = loaded.state.domainMetadata?.workstreamStatuses as Record<string, JsonValue> | undefined;
    const open = RELEASE_WORKSTREAMS.filter((name) => !statuses?.[name] || statuses[name] === "open");
    if (open.length) throw new Error(`release workstreams remain open: ${open.join(", ")}`);
  }
  return new HarnessRunStoreV7(input.cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state, workflow }) => ({
    state: transitionRun(state, workflow, input.event),
    event: { type: "WorkflowTransitioned", data: { event: input.event, note: input.note, from: state.phase, to: workflow.phases[state.phase]!.transitions[input.event]!.target } },
  }));
}

export async function deferMechanicalClarificationV7(input: {
  cwd: string;
  question: string;
  reason: string;
  alternatives: string[];
  fallback: string;
  impact: string;
  affectsContract: boolean;
}) {
  const loaded = await current(input.cwd);
  if (loaded.state.interactionMode !== "headless") throw new Error("cad_defer_clarification is only valid in headless mode");
  if (input.affectsContract && loaded.state.records["record:requirements"]) throw new Error("a committed requirements contract cannot be changed by deferred clarification; revise requirements explicitly");
  return new HarnessRunStoreV7(input.cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state }) => {
    const existing = state.domainMetadata?.deferredClarifications;
    const clarifications = Array.isArray(existing) ? [...existing] : [];
    const clarification = jsonValue({ phase: state.phase, question: input.question, reason: input.reason, alternatives: input.alternatives, fallback: input.fallback, impact: input.impact, affectsContract: input.affectsContract, createdAt: new Date().toISOString() });
    clarifications.push(clarification);
    return {
      state: { ...state, domainMetadata: { ...(state.domainMetadata ?? {}), deferredClarifications: clarifications }, updatedAt: new Date().toISOString() },
      event: { type: "ClarificationDeferred", data: clarification },
    };
  });
}

export async function waitMechanicalRunV7(input: { cwd: string; reason: string }) {
  const loaded = await current(input.cwd);
  if (loaded.state.interactionMode !== "interactive") throw new Error("headless v7 run cannot wait for user");
  return new HarnessRunStoreV7(input.cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
    state: { ...state, status: "waiting_user", blocker: { type: "user_decision", reason: input.reason, needed: input.reason }, updatedAt: new Date().toISOString() },
    event: { type: "WaitingForUser", data: { reason: input.reason } },
  }));
}

export async function blockMechanicalRunV7(input: { cwd: string; status: "blocked_user" | "blocked_external"; type: string; reason: string; needed: string }) {
  const loaded = await current(input.cwd);
  return new HarnessRunStoreV7(input.cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
    state: { ...state, status: input.status, blocker: { type: input.type, reason: input.reason, needed: input.needed }, updatedAt: new Date().toISOString() },
    event: { type: input.status === "blocked_user" ? "BlockedUser" : "BlockedExternal", data: { type: input.type, reason: input.reason, needed: input.needed } },
  }));
}

export async function finishMechanicalRunV7(input: { cwd: string }) {
  const loaded = await current(input.cwd);
  const finished = await new HarnessRunStoreV7(input.cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state, workflow }) => ({
    state: finishRun(state, workflow),
    event: { type: "RunFinished", data: { runId: state.runId } },
  }));
  await new HarnessProjectStoreV7(input.cwd).promoteCompletedRun(finished.state.runId, mechanicalRegistries);
  return finished;
}

export async function resumeMechanicalRunV7(cwd: string): Promise<HarnessRunStateV7 | null> {
  const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!loaded || loaded.state.status !== "waiting_user") return null;
  const next = await new HarnessRunStoreV7(cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
    state: { ...state, status: "active", blocker: undefined, updatedAt: new Date().toISOString() },
    event: { type: "UserInputResolved", data: { phase: state.phase } },
  }));
  return next.state;
}

export async function abortMechanicalRunV7(cwd: string): Promise<HarnessRunStateV7 | null> {
  const project = new HarnessProjectStoreV7(cwd);
  const loaded = await project.currentRun(mechanicalRegistries);
  if (!loaded) return null;
  const aborted = await new HarnessRunStoreV7(cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
    state: { ...state, status: "aborted", blocker: undefined, updatedAt: new Date().toISOString() },
    event: { type: "RunAborted", data: { runId: state.runId } },
  }));
  await project.deselectRun(loaded.state.runId, "user abort");
  return aborted.state;
}
