import { ipcMain } from "electron";
import { IPC } from "../../../src/shared/contracts.js";
import { DEMO_TRACE_ID, DEMO_TRACE_PATH } from "../demo-runtime.js";
import { TraceStore, assertCandidateAdoptionAllowed } from "../traces.js";
import { desktopE2E, realTraceE2E } from "../desktop-e2e.js";
import type { MainServices } from "../services.js";

let demoEvaluation: { quality: number; difficulty: number; feedback?: string } | undefined;

const demo = desktopE2E;

/** Trace list, rating, distillation, and candidate adoption. */
export function registerTracesIpc(s: MainServices) {
  ipcMain.handle(IPC.tracesList, async () => demo && !realTraceE2E ? [{ id: DEMO_TRACE_ID, path: DEMO_TRACE_PATH, title: "Folding stand", updatedAt: Date.now(), model: "openai-codex/gpt-5.6-sol", turns: 12, toolCalls: 4, tokens: 8420, ...(demoEvaluation ? { evaluation: demoEvaluation } : {}) }] : new TraceStore(await s.bridge()).list(await s.settingsStore.get()));
  ipcMain.handle(IPC.tracesRead, async (_event, path: string) => demo && !realTraceE2E ? [{ message: { role: "user", content: "Design a folding stand" } }, { message: { role: "assistant", content: [{ type: "text", text: "I checked the interfaces before building." }] } }, { message: { role: "toolResult", toolName: "ipython", content: "Model built" } }] : new TraceStore(await s.bridge()).read(await s.settingsStore.get(), path));
  ipcMain.handle(IPC.tracesRate, async (_event, paths: string[], evaluation: { quality: number; difficulty: number; feedback?: string }) => demo && !realTraceE2E
    ? (demoEvaluation = { ...evaluation }, { rated: paths.length, triggered: false, pendingTokens: 8_420, thresholdTokens: 250_000, message: "Rating saved." })
    : new TraceStore(await s.bridge()).rate(await s.settingsStore.get(), paths, evaluation));
  ipcMain.handle(IPC.tracesDistill, async (_event, paths: string[], evaluation: { quality: number; difficulty: number }) => {
    if (demo && !realTraceE2E) {
      const status = { state: "complete", processed: paths.length, total: paths.length, message: `Experience updated · quality ${evaluation.quality}/5` } as const;
      s.send(IPC.tracesDistillStatus, status);
      return status;
    }
    return new TraceStore(await s.bridge()).distill(await s.settingsStore.get(), paths, evaluation, (status) => s.send(IPC.tracesDistillStatus, status));
  });
  ipcMain.handle(IPC.tracesValidateCandidate, async (_event, jobPath: string) => new TraceStore(await s.bridge()).candidateAction(await s.settingsStore.get(), jobPath, "validate"));
  ipcMain.handle(IPC.tracesAdoptCandidate, async (_event, jobPath: string) => {
    const settings = await s.settingsStore.get();
    assertCandidateAdoptionAllowed(settings);
    return new TraceStore(await s.bridge()).candidateAction(settings, jobPath, "adopt");
  });
}
