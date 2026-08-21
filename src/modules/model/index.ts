/**
 * MODEL module entry (refactor Phase 4/5).
 */
export {
  Build123dBackend,
  DEFAULT_MODEL_BACKEND,
  modelBackend,
  modelBackendIds,
  registerModelBackend,
  type ModelBackend,
  type ModelBuildInput,
  type ModelExportInput,
} from "./backend.ts";
export {
  buildProposal,
  convertProposal,
  finalizeCandidate,
  finalizeConversion,
  type CandidateProposal,
  type ProposalResult,
} from "./finalizer.ts";
