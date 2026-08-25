import { randomUUID } from "node:crypto";
import { buildRegistryContract } from "../../harness/registry-contract.ts";
import { replaceWorkflowSnapshot } from "../../harness/reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7, type LoadedHarnessRunV7 } from "../../harness/run-store.ts";
import { compileWorkflowDefinition } from "../../harness/workflow/compiler.ts";
import { isRoute, obligationsOf, routeKey, type Route } from "../../shared/route.ts";
import { mechanicalRegistries } from "./registries.ts";
import { mechanicalPlanCWorkflowDefinition, mechanicalWorkflowDefinition } from "./workflows.ts";

function routeFromState(loaded: LoadedHarnessRunV7): Route | null {
  const route = loaded.state.domainMetadata?.route;
  return isRoute(route) ? route : null;
}

function isMonotoneReroute(before: Route, after: Route): boolean {
  const next = obligationsOf(after);
  return [...obligationsOf(before)].every((obligation) => next.has(obligation));
}

export async function cadRouteV7(input: { cwd: string; route: Route; reason: string; commitStyle?: "semantic" | "workspace" }): Promise<LoadedHarnessRunV7> {
  if (!isRoute(input.route)) throw new Error("invalid Mechanical route");
  const project = new HarnessProjectStoreV7(input.cwd);
  const loaded = await project.currentRun(mechanicalRegistries);
  if (!loaded) throw new Error("cad_route requires an active v7 intake run");
  if (loaded.workflow.id !== "mechanical/intake" || loaded.state.phase !== "intake") throw new Error("cad_route is legal only in Mechanical intake");
  const definition = input.commitStyle === "workspace" ? mechanicalPlanCWorkflowDefinition(input.route) : mechanicalWorkflowDefinition(input.route);
  const successor = compileWorkflowDefinition(definition, mechanicalRegistries);
  const contract = buildRegistryContract(mechanicalRegistries);
  const state = replaceWorkflowSnapshot({ state: loaded.state, predecessor: loaded.workflow, successor, registryContract: contract, reason: input.reason });
  state.domainMetadata = { ...(state.domainMetadata ?? {}), route: input.route as never };
  return new HarnessRunStoreV7(input.cwd, state.runId).replaceWorkflow({ expectedGeneration: loaded.head.generation, state, workflow: successor, registryContract: contract, event: { type: "WorkflowReplaced", data: { action: "cad_route", route: routeKey(input.route), reason: input.reason } } });
}

export async function cadRerouteV7(input: { cwd: string; route: Route; reason: string }): Promise<LoadedHarnessRunV7> {
  if (!isRoute(input.route)) throw new Error("invalid Mechanical route");
  const project = new HarnessProjectStoreV7(input.cwd);
  const loaded = await project.currentRun(mechanicalRegistries);
  if (!loaded) throw new Error("cad_reroute requires an active v7 run");
  const before = routeFromState(loaded);
  if (!before) throw new Error("active v7 workflow has no Mechanical route metadata");
  if (routeKey(before) === routeKey(input.route)) throw new Error("reroute target equals current route");
  const monotone = isMonotoneReroute(before, input.route);
  const authorityKind = "mechanical.reroute.downgrade";
  const targetKey = routeKey(input.route);
  const authorityIndex = loaded.state.authorities.findIndex((item) => item.kind === authorityKind && !item.consumedAt && (item.scope as any)?.route === targetKey);
  if (!monotone && authorityIndex < 0) {
    await new HarnessRunStoreV7(input.cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: {
        ...state,
        status: state.interactionMode === "headless" ? "blocked_user" : "waiting_user",
        blocker: { type: "user_authority", reason: `reroute to ${targetKey} removes obligations`, needed: `approve exact route ${targetKey} with /cad-approve-reroute` },
        domainMetadata: { ...(state.domainMetadata ?? {}), pendingReroute: { route: input.route as never, routeKey: targetKey, reason: input.reason } },
        updatedAt: new Date().toISOString(),
      },
      event: { type: "RerouteAuthorityRequested", data: { route: targetKey, reason: input.reason } },
    }));
    throw new Error(`reroute removes obligations and requires authority: exact user approval for ${targetKey}`);
  }
  const successor = compileWorkflowDefinition(mechanicalWorkflowDefinition(input.route), mechanicalRegistries);
  const contract = buildRegistryContract(mechanicalRegistries);
  const authority = monotone ? undefined : loaded.state.authorities[authorityIndex]!.id;
  const state = replaceWorkflowSnapshot({
    state: loaded.state,
    predecessor: loaded.workflow,
    successor,
    registryContract: contract,
    reason: input.reason,
    ...(authority ? { authority } : {}),
    preserveCompatibleObligations: true,
  });
  state.domainMetadata = { ...(state.domainMetadata ?? {}), route: input.route as never };
  if (authority) state.authorities = state.authorities.map((item) => item.id === authority ? { ...item, consumedAt: new Date().toISOString() } : item);
  return new HarnessRunStoreV7(input.cwd, state.runId).replaceWorkflow({ expectedGeneration: loaded.head.generation, state, workflow: successor, registryContract: contract, event: { type: "WorkflowReplaced", data: { action: "cad_reroute", before: routeKey(before), after: routeKey(input.route), reason: input.reason, monotone, ...(authority ? { authority } : {}) } } });
}

export async function approveMechanicalRerouteV7(cwd: string): Promise<LoadedHarnessRunV7> {
  const loaded = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!loaded) throw new Error("No active v7 workflow");
  const pending = loaded.state.domainMetadata?.pendingReroute as { routeKey?: unknown } | undefined;
  if (typeof pending?.routeKey !== "string") throw new Error("No pending v7 reroute to approve");
  const id = `authority-${randomUUID()}`;
  return new HarnessRunStoreV7(cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
    state: {
      ...state,
      status: "active", blocker: undefined,
      authorities: [...state.authorities, { id, kind: "mechanical.reroute.downgrade", scope: { route: pending.routeKey! }, issuedAt: new Date().toISOString() }],
      domainMetadata: { ...(state.domainMetadata ?? {}), pendingReroute: null },
      updatedAt: new Date().toISOString(),
    },
    event: { type: "RerouteAuthorityIssued", data: { authority: id, route: pending.routeKey } },
  }));
}
