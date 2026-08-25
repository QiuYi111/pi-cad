import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import {
  authorize,
  PermissionEngineV7,
  requireAuthorization,
  type Authorization,
  type Operation,
  type OperationAuthority,
} from "../harness/permissions.ts";
import { HarnessProjectStoreV7 } from "../harness/run-store.ts";
import { bootstrapAgentApiContracts } from "./bootstrap.ts";

/** Resolve the active immutable run and make the single capability decision. */
export async function currentAuthorization(
  cwd: string,
  operation: Operation,
  authority: OperationAuthority = "author",
): Promise<Authorization | null> {
  bootstrapAgentApiContracts();
  const active = await new HarnessProjectStoreV7(cwd).currentRun(mechanicalRegistries);
  if (!active) return null;
  return authorize(
    operation,
    active.state,
    active.workflow,
    new PermissionEngineV7(mechanicalRegistries, active.registryContract),
    authority,
  );
}

export async function requireCurrentAuthorization(
  cwd: string,
  operation: Operation,
  authority: OperationAuthority = "author",
): Promise<Extract<Authorization, { allowed: true }>> {
  const decision = await currentAuthorization(cwd, operation, authority);
  if (!decision) throw new Error(`${operation} requires an active Pi-CAD workflow; call cad.workflow.start()`);
  requireAuthorization(decision);
  return decision;
}
