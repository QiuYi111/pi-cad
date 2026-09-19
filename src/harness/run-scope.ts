import { AsyncLocalStorage } from "node:async_hooks";

import {
  HarnessProjectStoreV7,
  HarnessRunStoreV7,
  type LoadedHarnessRunV7,
  type ProjectConversationBindingV1,
} from "./run-store.ts";
import {
  isRunId,
  isSessionId,
  parseConversationBinding,
  type ConversationBindingV1,
} from "../integrations/prime/workflow-binding.ts";
import type { RegistrySet } from "./registry.ts";

/**
 * Ownership split for workflow lifecycle state:
 *
 * - the project owns shared engineering assets (run registry, Project HEAD,
 *   promoted artifacts);
 * - a Prime conversation owns its workflow binding;
 * - a run owns workflow state.
 *
 * A conversation binding lives in the Prime transcript as a hidden
 * `pi-cad.workflow-binding` custom entry. The sidecar never treats
 * `project.currentRunId` or `project.promotedRunId` as *this conversation's*
 * run: an unbound conversation has no run at all.
 */
export { WORKFLOW_BINDING_CUSTOM_TYPE, bindingFromTranscriptEntries, parseConversationBinding } from "../integrations/prime/workflow-binding.ts";
export type { ConversationBindingV1 } from "../integrations/prime/workflow-binding.ts";

/** `sessionId`/`runId` travel on every conversation-scoped sidecar request. */
export interface RunScopeV1 {
  sessionId: string | null;
  runId: string | null;
}

export function projectBindingToConversation(binding: ProjectConversationBindingV1, sessionId: string): ConversationBindingV1 {
  return { schema: 1, sessionId, runId: binding.runId, workflowHash: binding.workflowHash, boundAt: binding.boundAt };
}

const scopeStorage = new AsyncLocalStorage<RunScopeV1>();

/** Run one authority request inside its own conversation scope. */
export function runWithRunScope<T>(scope: RunScopeV1 | null | undefined, body: () => T): T {
  return scope ? scopeStorage.run(scope, body) : body();
}

export function activeRunScope(): RunScopeV1 | undefined {
  return scopeStorage.getStore();
}

/**
 * The single run-resolution chokepoint. Unscoped callers keep the
 * project-global pointer; a conversation-scoped caller sees only its own run.
 */
export async function resolveActiveRun(cwd: string, registries?: RegistrySet): Promise<LoadedHarnessRunV7 | null> {
  const scope = scopeStorage.getStore();
  if (!scope) return new HarnessProjectStoreV7(cwd).currentRun(registries);
  if (!scope.runId) return null;
  return new HarnessRunStoreV7(cwd, scope.runId).load(registries);
}

export async function requireActiveRun(cwd: string, registries?: RegistrySet): Promise<LoadedHarnessRunV7> {
  const loaded = await resolveActiveRun(cwd, registries);
  if (loaded) return loaded;
  if (scopeStorage.getStore()) throw new Error("this Prime conversation has no bound Pi-CAD workflow run; call cad.workflow.start()");
  throw new Error("no active Pi-CAD v7 run");
}

/** Request fields that carry a conversation identity over the sidecar wire. */
export interface RunScopeRequestV1 {
  sessionId?: unknown;
  runId?: unknown;
  binding?: unknown;
}

/**
 * Resolve the scope of one sidecar/Agent API request.
 *
 * The transcript binding is the durable authority. The project conversation
 * registry only resolves stateless clients (the Python kernel socket) that
 * can name their Prime session but cannot read the transcript. A binding
 * written by a newer `workflow.start()` always wins over an older assertion.
 */
export async function resolveRequestScope(cwd: string, request: RunScopeRequestV1): Promise<RunScopeV1 | undefined> {
  const sessionId = isSessionId(request.sessionId) ? request.sessionId : null;
  if (!sessionId) return isRunId(request.runId) ? { sessionId: null, runId: request.runId } : undefined;

  const asserted = parseConversationBinding(request.binding, sessionId)
    ?? (isRunId(request.runId) ? { schema: 1 as const, sessionId, runId: request.runId, workflowHash: "", boundAt: "" } : null);
  const project = new HarnessProjectStoreV7(cwd);
  const stored = await project.conversationBinding(sessionId);
  if (stored && (!asserted || stored.boundAt > asserted.boundAt)) return { sessionId, runId: stored.runId };
  if (!asserted) return { sessionId, runId: null };
  const run = await new HarnessRunStoreV7(cwd, asserted.runId).load();
  if (!run) return { sessionId, runId: null };
  const effective: ProjectConversationBindingV1 = { runId: run.state.runId, workflowHash: run.workflow.hash, boundAt: asserted.boundAt || new Date().toISOString() };
  if (!stored || stored.runId !== effective.runId || stored.boundAt !== effective.boundAt) await project.bindConversation(sessionId, effective);
  return { sessionId, runId: effective.runId };
}

/** Bind a freshly started run to the conversation that started it. */
export async function bindConversationRun(cwd: string, sessionId: string, run: LoadedHarnessRunV7, boundAt = new Date().toISOString()): Promise<ConversationBindingV1> {
  const binding: ProjectConversationBindingV1 = { runId: run.state.runId, workflowHash: run.workflow.hash, boundAt };
  await new HarnessProjectStoreV7(cwd).bindConversation(sessionId, binding);
  return projectBindingToConversation(binding, sessionId);
}
