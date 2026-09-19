import type { AppSettings } from "../../src/shared/contracts.js";
import { withCanonicalProjectEnvironment, type RuntimeBridge } from "./runtime-bridge.js";

interface AgentApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string };
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
export function conversationFields(sessionId?: string): Record<string, string> {
  return sessionId ? { sessionId } : {};
}

export class AgentApiClient {
  constructor(private readonly bridge: RuntimeBridge) {}

  async request<T>(settings: AppSettings, body: Record<string, unknown>, timeout = 60_000): Promise<T> {
    const { piCadRepo, projectPath } = await this.bridge.resolveRuntimePaths(settings);
    if (!projectPath) throw new Error("Choose a project before reading Reify state.");
    const node = await this.bridge.commandPath("node");
    const { stdout } = await this.bridge.pipe(
      await withCanonicalProjectEnvironment(this.bridge, projectPath, [node, `${piCadRepo}/scripts/pi-cad-agent-api.mjs`, "agent-api", projectPath]),
      JSON.stringify({ schema: 1, ...body }),
      timeout,
    );
    const response = JSON.parse(stdout) as AgentApiEnvelope<T>;
    if (!response.ok) throw new Error(response.error?.message || "Reify rejected the request.");
    return response.result as T;
  }
}
