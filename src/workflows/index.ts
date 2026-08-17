import { analyzeWorkflow } from "./analyze.ts";
import { convertWorkflow } from "./convert.ts";
import { greenfieldWorkflow } from "./greenfield.ts";
import { hybridWorkflow } from "./hybrid.ts";
import { modifyWorkflow } from "./modify.ts";
import { quickWorkflow } from "./quick.ts";
import { releaseWorkflow } from "./release.ts";
import type { WorkflowSpec } from "./types.ts";
import type { CadWorkflow } from "../shared/protocol.ts";

export const WORKFLOW_SPECS: Record<CadWorkflow, WorkflowSpec> = {
  quick: quickWorkflow,
  analyze: analyzeWorkflow,
  modify: modifyWorkflow,
  greenfield: greenfieldWorkflow,
  hybrid: hybridWorkflow,
  convert: convertWorkflow,
  release: releaseWorkflow,
};

export type { WorkflowSpec };
export {
  analyzeWorkflow,
  convertWorkflow,
  greenfieldWorkflow,
  hybridWorkflow,
  modifyWorkflow,
  quickWorkflow,
  releaseWorkflow,
};
