import type { AuthorityDomain } from "../authority/domain.ts";
import { currentAuthorization } from "../agent-api/authorization.ts";
import { bootstrapAgentApiContracts } from "../agent-api/bootstrap.ts";
import { handleAgentApi } from "../agent-api/handlers.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";

/**
 * The Mechanical Pack, wired into the authority sidecar. This is the only
 * place that joins src/authority to the Mechanical domain and its Agent API.
 */
export const mechanicalAuthorityDomain: AuthorityDomain = {
  registries: mechanicalRegistries,
  requirementsReviewProfile: "mechanical.requirements-review",
  prepare: bootstrapAgentApiContracts,
  handleAgentApi,
  currentAuthorization,
};
