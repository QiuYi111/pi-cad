import { PermissionEngineV7 } from "../../harness/permissions.ts";
import { unmetPhaseObligations } from "../../harness/reducer.ts";
import { HarnessProjectStoreV7, type LoadedHarnessRunV7 } from "../../harness/run-store.ts";
import { mechanicalRegistries } from "./registries.ts";

const WRITE_ROOTS: Readonly<Record<string, readonly string[]>> = {
  "project:source": ["models/", "src/", "design/"],
  "project:recipe": ["recipes/", "simulation/"],
  "project:deliverable": ["build/", "drawings/", "presentation/", "exports/"],
};

export interface MechanicalActionRecoveryV1 {
  schema: 1;
  phase: string;
  status: string;
  purpose: string;
  enabledActions: string[];
  allowedTransitions: Array<{ event: string; target: string; authority?: string }>;
  unmetObligations: string[];
  writeScopes: string[];
  allowedWriteRoots: string[];
  suggestedCall?: { tool: string; input: Record<string, unknown>; reason: string };
}

function suggestedCall(loaded: LoadedHarnessRunV7, enabledActions: string[], unmet: string[]) {
  const phase = loaded.workflow.phases[loaded.state.phase]!;
  const obligation = [...phase.recordObligations, ...phase.evidenceObligations]
    .find((item) => unmet.includes(item.ref) && enabledActions.includes(item.closeWith));
  if (obligation) return { tool: obligation.closeWith, input: {}, reason: `close ${obligation.ref}` };
  if (phase.reviewProfile && enabledActions.includes("cad_submit_for_review")) {
    return { tool: "cad_submit_for_review", input: {}, reason: `run ${phase.reviewProfile}` };
  }
  const transitions = Object.entries(phase.transitions);
  if (transitions.length === 1 && enabledActions.includes("cad_transition")) {
    return { tool: "cad_transition", input: { event: transitions[0]![0], note: `Complete ${phase.purpose}` }, reason: `only legal transition to ${transitions[0]![1].target}` };
  }
  if (enabledActions.includes("cad_commit_candidate")) return { tool: "cad_commit_candidate", input: {}, reason: "commit the current source-built candidate" };
  if (enabledActions.includes("cad_finish")) return { tool: "cad_finish", input: {}, reason: "finish the closed workflow" };
  return undefined;
}

export function mechanicalActionRecoveryV7(loaded: LoadedHarnessRunV7): MechanicalActionRecoveryV1 {
  const phase = loaded.workflow.phases[loaded.state.phase]!;
  const enabledActions = new PermissionEngineV7(mechanicalRegistries, loaded.registryContract)
    .enabledActions(loaded.state, loaded.workflow);
  const unmetObligations = unmetPhaseObligations(loaded.state, loaded.workflow);
  const writeScopes = [...phase.writeScopes];
  return {
    schema: 1,
    phase: loaded.state.phase,
    status: loaded.state.status,
    purpose: phase.purpose,
    enabledActions,
    allowedTransitions: Object.entries(phase.transitions).map(([event, transition]) => ({
      event,
      target: transition.target,
      ...(transition.authority ? { authority: transition.authority } : {}),
    })),
    unmetObligations,
    writeScopes,
    allowedWriteRoots: writeScopes.flatMap((scope) => [...(WRITE_ROOTS[scope] ?? [])]),
    suggestedCall: suggestedCall(loaded, enabledActions, unmetObligations),
  };
}

export function renderMechanicalActionRecoveryV7(loaded: LoadedHarnessRunV7): string {
  return `## Pi-CAD Current Action (authoritative, refreshed)\n${JSON.stringify(mechanicalActionRecoveryV7(loaded))}`;
}

export async function loadMechanicalActionRecoveryV7(cwd: string): Promise<MechanicalActionRecoveryV1 | null> {
  const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  return loaded ? mechanicalActionRecoveryV7(loaded) : null;
}

