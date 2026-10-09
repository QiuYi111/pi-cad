import type { Authorization, Operation, OperationAuthority } from "../harness/permissions.ts";
import type { RegistrySet } from "../harness/registry.ts";
import type { AgentApiRequest } from "./protocol.ts";

/**
 * What the authority sidecar needs from the domain it guards. Authority owns
 * the sockets, role allow-lists, reviewer admission and the completion gate;
 * the domain owns its registries, its review profile, and the handlers and
 * permission engine behind each Agent API operation. Only the composition
 * point (src/composition) builds one, so nothing under src/authority names a
 * domain.
 */
export interface AuthorityDomain {
  /** Workflow, action, record, evidence and review-profile registries. */
  readonly registries: RegistrySet;
  /** The review profile whose reviewer may return clarification_required. */
  readonly requirementsReviewProfile: string;
  /** Pins the domain's action contracts before a request is served. Idempotent. */
  prepare(): void;
  /** Serves one Agent API operation that authority does not handle itself. */
  handleAgentApi(cwd: string, request: AgentApiRequest, authority: OperationAuthority): Promise<unknown>;
  /** The single capability decision for the active run. */
  currentAuthorization(cwd: string, operation: Operation, authority: OperationAuthority): Promise<Authorization | null>;
}
