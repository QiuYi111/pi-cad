/**
 * The generated fault space, one module per real boundary. Consumers import
 * from here; the boundary files stay the single place each fault is defined.
 */
export * from "./process.ts";
export * from "./storage.ts";
export * from "./credentials.ts";
export * from "./network.ts";
export * from "./race.ts";

import {
  killKernelDuringBuild,
  pauseKernelDuringBuild,
  killAuthorityDuringBuild,
  pauseAuthorityDuringBuild,
  killIdleKernel,
  killKernelChild,
  killRuntimeDuringBuild,
  pauseRuntimeDuringBuild,
  restartRuntimeDuringBuild,
  killPrimeRuntime,
  cpuPressure,
} from "./process.ts";
import { missingRunStateFile, unreadableRunStateFile, partialStateWrite, missingDesktopProjection } from "./storage.ts";
import { providerCredentialExpired, providerCredentialDropped, providerCredentialBlanked } from "./credentials.ts";
import {
  providerTimeout,
  providerReset,
  providerLatency,
  providerStreamCut,
  providerRateLimited,
  providerServerError,
} from "./network.ts";
import {
  raceUserActionDuringKernelFault,
  raceTwoConversationsBuild,
  raceRestartDuringTransition,
  raceLegalOrderSwap,
  raceRepeatSubmitDuringFault,
  raceCrossConversationFault,
} from "./race.ts";
import type { ReifyFaultDefinition } from "../types.ts";


// The generated space, grouped by the boundary each fault really hits.
// ---------------------------------------------------------------------------

/** Prime / runtime / kernel / worker process and resource faults. */
export const processFaultDefinitions: ReifyFaultDefinition[] = [
  killKernelDuringBuild,
  pauseKernelDuringBuild,
  killAuthorityDuringBuild,
  pauseAuthorityDuringBuild,
  killIdleKernel,
  killKernelChild,
  killRuntimeDuringBuild,
  pauseRuntimeDuringBuild,
  restartRuntimeDuringBuild,
  killPrimeRuntime,
  cpuPressure,
];

/** Real files and real state the product reads and writes. */
export const fileStateFaultDefinitions: ReifyFaultDefinition[] = [
  missingRunStateFile,
  unreadableRunStateFile,
  partialStateWrite,
  missingDesktopProjection,
];

/** Provider / OAuth boundary. */
export const providerFaultDefinitions: ReifyFaultDefinition[] = [
  providerCredentialExpired,
  providerCredentialDropped,
  providerCredentialBlanked,
  providerTimeout,
  providerReset,
  providerLatency,
  providerStreamCut,
  providerRateLimited,
  providerServerError,
];

/** Multi-step timing combinations, not single-step faults. */
export const raceFaultDefinitions: ReifyFaultDefinition[] = [
  raceUserActionDuringKernelFault,
  raceTwoConversationsBuild,
  raceRestartDuringTransition,
  raceLegalOrderSwap,
  raceRepeatSubmitDuringFault,
  raceCrossConversationFault,
];

export const reifyFaultDefinitions: ReifyFaultDefinition[] = [
  ...processFaultDefinitions,
  ...fileStateFaultDefinitions,
  ...providerFaultDefinitions,
  ...raceFaultDefinitions,
];

/** Which boundary each fault really hits, for the CLI and the docs. */
export const FAULT_BOUNDARIES: Record<string, "process" | "file-state" | "provider-oauth" | "race"> = Object.fromEntries([
  ...processFaultDefinitions.map((fault) => [fault.name, "process"] as const),
  ...fileStateFaultDefinitions.map((fault) => [fault.name, "file-state"] as const),
  ...providerFaultDefinitions.map((fault) => [fault.name, "provider-oauth"] as const),
  ...raceFaultDefinitions.map((fault) => [fault.name, "race"] as const),
]);
