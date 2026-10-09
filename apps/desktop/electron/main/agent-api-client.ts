import type { AppSettings } from "../../src/shared/contracts.js";
import { withCanonicalProjectEnvironment, type RuntimeBridge } from "./runtime-bridge.js";

interface AgentApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string; code?: string; target?: string; detail?: Record<string, unknown>; hints?: string[] };
}

/** An Agent API error with its stable code, target and detail (for example TRANSFER_CHECK_FAILED). */
export class AgentApiError extends Error {
  constructor(message: string, readonly code?: string, readonly target?: string, readonly detail?: Record<string, unknown>, readonly hints?: string[]) {
    super(message);
    this.name = "AgentApiError";
  }
}

/**
 * The Desktop reads workflow and artifact state as one Prime conversation.
 *
 * A Desktop process cannot read a Prime transcript, so it names its
 * conversation by Prime's session id and lets the authority resolve that
 * conversation's own workflow binding. No session id means no conversation,
 * and a conversation the authority has no binding for stays unbound: the
 * Desktop never falls back to the project current/promoted run and never
 * shows another conversation's workflow state.
 */
export type ConversationScope = string | null | undefined;

/**
 * The conversation one Desktop request belongs to.
 *
 * - a session id names the Prime conversation the window shows;
 * - `null` is a Desktop window whose conversation has no Prime session yet
 *   (the click on "new conversation" before its first prompt): the window is
 *   still conversation-scoped, so the authority answers it as unbound and it
 *   never inherits the project's current run;
 * - `undefined` names no conversation at all, which only a headless or
 *   packaged-smoke caller may do, and keeps the legacy project-global pointer.
 */
export function conversationFields(scope: ConversationScope): Record<string, string | null> {
  return scope === undefined ? {} : { sessionId: scope };
}

export class AgentApiClient {
  constructor(private readonly bridge: RuntimeBridge) {}

  async request<T>(settings: AppSettings, body: Record<string, unknown>, timeout = 60_000): Promise<T> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) throw new Error("Choose a project before reading Reify state.");
    const node = await this.bridge.commandPath("node");
    let stdout: string;
    try {
      ({ stdout } = await this.bridge.pipe(
        await withCanonicalProjectEnvironment(this.bridge, projectPath, [node, `${piCadRepo}/scripts/pi-cad-agent-api.mjs`, "agent-api", projectPath]),
        JSON.stringify({ schema: 1, ...body }),
        timeout,
      ));
    } catch (error) {
      // The Agent API exits non-zero on a request error but still prints the error envelope on stdout. Without it the
      // user would only see stderr, which is usually a Node warning.
      const printed = (error as { stdout?: unknown }).stdout;
      if (typeof printed !== "string" || !printed.trim().startsWith("{")) throw error;
      stdout = printed;
    }
    const response = JSON.parse(stdout) as AgentApiEnvelope<T>;
    if (!response.ok) {
      const error = response.error;
      throw new AgentApiError(error?.message || "Reify rejected the request.", error?.code, error?.target, error?.detail, error?.hints);
    }
    return response.result as T;
  }
}
