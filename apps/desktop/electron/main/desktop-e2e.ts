import type { ThinkingLevel } from "../../src/shared/contracts.js";

// Desktop E2E switches. Read once at startup from the environment or argv; the
// fake runtimes and fixtures they select live beside the real handlers.
export const desktopE2E = process.env.PI_CAD_DESKTOP_E2E === "1" || process.argv.includes("--pi-cad-e2e");
export const desktopE2EOpenStep = process.env.PI_CAD_DESKTOP_E2E_OPEN_STEP
  || process.argv.find((argument) => argument.startsWith("--pi-cad-e2e-open-step="))?.slice("--pi-cad-e2e-open-step=".length);
export const desktopE2ERejectThinking = Number(
  process.env.PI_CAD_DESKTOP_E2E_REJECT_THINKING
  || process.argv.find((argument) => argument.startsWith("--pi-cad-e2e-reject-thinking="))?.slice("--pi-cad-e2e-reject-thinking=".length)
  || 0,
);
export const desktopE2ESlowThinking = Number(
  process.env.PI_CAD_DESKTOP_E2E_SLOW_THINKING
  || process.argv.find((argument) => argument.startsWith("--pi-cad-e2e-slow-thinking="))?.slice("--pi-cad-e2e-slow-thinking=".length)
  || 0,
);
export const desktopE2ERevertThinking = (
  process.env.PI_CAD_DESKTOP_E2E_REVERT_THINKING
  || process.argv.find((argument) => argument.startsWith("--pi-cad-e2e-revert-thinking="))?.slice("--pi-cad-e2e-revert-thinking=".length)
) as ThinkingLevel | undefined;
export const testOpenSteps = process.argv
  .filter((argument) => argument.startsWith("--pi-cad-test-open-step="))
  .map((argument) => argument.slice("--pi-cad-test-open-step=".length));
export const testExportStep = process.argv.find((argument) => argument.startsWith("--pi-cad-test-export-step="))?.slice("--pi-cad-test-export-step=".length);
export const realTraceE2E = desktopE2E && process.env.PI_CAD_DESKTOP_E2E_REAL_TRACES === "1";
/**
 * The desktop E2E suite drives fake Prime turns. Workflow and artifact state
 * still comes from the real authority unless the suite asks for the stub, so
 * the conversation-scoped projection is exercised end to end.
 */
const e2eWorkflowAuthority = process.env.PI_CAD_DESKTOP_E2E_WORKFLOW_AUTHORITY === "1"
  || process.argv.includes("--pi-cad-e2e-workflow-authority");
export const stubWorkflowProjection = desktopE2E && !e2eWorkflowAuthority;
export const authE2E = desktopE2E || process.env.PI_CAD_DESKTOP_E2E_AUTH === "1" || process.argv.includes("--pi-cad-e2e-auth");
