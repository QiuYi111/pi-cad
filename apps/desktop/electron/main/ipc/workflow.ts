import { ipcMain } from "electron";
import type { WorkflowDocument } from "../../../src/shared/contracts.js";
import { IPC } from "../../../src/shared/contracts.js";
import { WorkflowStore } from "../workflows.js";
import { desktopE2E, stubWorkflowProjection } from "../desktop-e2e.js";
import type { MainServices } from "../services.js";

const demoWorkflow: WorkflowDocument = { id: "mechanical.default", version: "2.0.0", description: "Plan, build, and review an engineering result", editable: true, phases: ["plan", "cook", "final", "done"].map((id, index) => ({ id, title: id, purpose: `Complete ${id}`, status: index < 1 ? "complete" : index === 1 ? "active" : "pending", transitions: [], capabilities: id === "plan" ? ["codex_generate_image", "workspace.commit"] : [], obligations: [] })), raw: "id: mechanical.default\nversion: 2.0.0\nworkflow:\n  phases:\n    plan: {}\n", sourcePath: "/home/demo/.pi-cad/workflows/mechanical-default.yaml" };
const demoNakedWorkflow: WorkflowDocument = { id: "mechanical.naked", version: "1.0.0", description: "Full tools with no prescribed workflow", phases: [{ id: "work", title: "work", purpose: "Complete the engineering task", status: "active", transitions: [], capabilities: ["cad_build_step", "cad_commit", "cad_simulate", "codex_generate_image"], obligations: [] }], raw: "", sourcePath: "/runtime/workflow-packages/mechanical/naked.yaml" };

const demo = desktopE2E;

/** Workflow packages and the current workflow projection. */
export function registerWorkflowIpc(s: MainServices) {
  ipcMain.handle(IPC.workflowList, async () => demo ? [demoWorkflow, demoNakedWorkflow] : new WorkflowStore(await s.bridge()).list(await s.settingsStore.get()));
  ipcMain.handle(IPC.workflowCurrent, async () => stubWorkflowProjection ? {
    workflowId: demoWorkflow.id, workflowVersion: demoWorkflow.version, workflowHash: "demo", runId: "e2e", phase: "concept", status: "active",
    phaseHistory: ["grilling", "spec", "concept"], phases: demoWorkflow.phases, authoritative: false,
  } : new WorkflowStore(await s.bridge()).current(await s.settingsStore.get(), s.projectedConversation()));
  ipcMain.handle(IPC.workflowSave, async (_event, document: WorkflowDocument) => demo ? document : new WorkflowStore(await s.bridge()).save(await s.settingsStore.get(), document));
  ipcMain.handle(IPC.workflowDelete, async (_event, document: WorkflowDocument) => demo ? undefined : new WorkflowStore(await s.bridge()).delete(await s.settingsStore.get(), document));
  ipcMain.handle(IPC.workflowAdoptionPolicy, async () => new WorkflowStore(await s.bridge()).adoptionPolicy(await s.settingsStore.get()));
  ipcMain.handle(IPC.workflowAdopt, async (_event, id: string, version: string) => new WorkflowStore(await s.bridge()).adopt(await s.settingsStore.get(), id, version));
}
