import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { PI_CAD_OWNED_TOOLS } from "../core/policies.ts";
import { registeredMechanicalActionTools } from "../domains/mechanical/register-action.ts";
import { authorizeMechanicalToolV7 } from "../domains/mechanical/tool-policy-v7.ts";
import { selectKernelEngine } from "../harness/engine-router.ts";

export const CODE_MODE_PREFLIGHT_PROTOCOL = "@howaboua/pi-codex-conversion/code-mode-preflight/v1";
export const CODE_MODE_PREFLIGHT_REQUEST = `${CODE_MODE_PREFLIGHT_PROTOCOL}/request`;
export const CODE_MODE_PREFLIGHT_AVAILABLE = `${CODE_MODE_PREFLIGHT_PROTOCOL}/available`;
export const CODE_MODE_PROVIDER_PROTOCOL = "@howaboua/pi-codex-conversion/code-mode-provider/v1";
export const CODE_MODE_PROVIDER_REQUEST = `${CODE_MODE_PROVIDER_PROTOCOL}/request`;
export const CODE_MODE_PROVIDER_AVAILABLE = `${CODE_MODE_PROVIDER_PROTOCOL}/available`;

interface PreflightCall {
  toolName: string;
  input: unknown;
  cwd: string;
}

interface PreflightBroker {
  protocol: typeof CODE_MODE_PREFLIGHT_PROTOCOL;
  isActive(): boolean;
  register(preflight: (call: PreflightCall) => Promise<{ block: true; reason: string } | void>): () => void;
}

interface ProviderBroker {
  protocol: typeof CODE_MODE_PROVIDER_PROTOCOL;
  isActive(): boolean;
  register(provider: { getTools(ctx?: unknown): unknown[] }): () => void;
}

export interface PiCadNestedToolBridge {
  readonly available: boolean;
  ensureProvider(): Promise<boolean>;
  dispose(): void;
}

function isBroker(value: unknown): value is PreflightBroker {
  return Boolean(value && typeof value === "object"
    && "protocol" in value && value.protocol === CODE_MODE_PREFLIGHT_PROTOCOL
    && "isActive" in value && typeof value.isActive === "function"
    && "register" in value && typeof value.register === "function");
}

function isProviderBroker(value: unknown): value is ProviderBroker {
  return Boolean(value && typeof value === "object"
    && "protocol" in value && value.protocol === CODE_MODE_PROVIDER_PROTOCOL
    && "isActive" in value && typeof value.isActive === "function"
    && "register" in value && typeof value.register === "function");
}

function usageFor(tool: any): string {
  const hint = typeof tool.promptSnippet === "string" && tool.promptSnippet.trim()
    ? ` // ${tool.promptSnippet.trim()}`
    : "";
  return `await tools.${tool.name}({ ... })${hint}`;
}

function compactResult(result: any): unknown {
  if (result?.content?.some((item: any) => item?.type === "image")) {
    return { content: result.content, details: result.details };
  }
  if (result?.details && typeof result.details === "object" && "output" in result.details) return result.details;
  const text = Array.isArray(result?.content)
    ? result.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n")
    : "";
  return text || "(no output)";
}

export function piCadNestedTools(pi: ExtensionAPI): unknown[] {
  const active = new Set(pi.getActiveTools?.() ?? []);
  return registeredMechanicalActionTools(pi)
    .filter((tool: any) => PI_CAD_OWNED_TOOLS.has(tool.name) && active.has(tool.name))
    .map((tool: any) => ({
      name: tool.name,
      usage: usageFor(tool),
      description: tool.description,
      deferLoading: false,
      kind: "function" as const,
      inputSchema: tool.parameters,
      ...(tool.renderCall ? { renderCall: tool.renderCall.bind(tool) } : {}),
      ...(tool.renderResult ? { renderResult: tool.renderResult.bind(tool) } : {}),
      async invoke(input: unknown, context: any, signal: AbortSignal) {
        if (signal.aborted) throw new Error(`${tool.name} aborted`);
        const extensionContext = context.extensionContext;
        if (!extensionContext) throw new Error("Pi-CAD nested tool context is unavailable");
        const prepared = tool.prepareArguments ? tool.prepareArguments(input) : input;
        const result = await tool.execute(
          context.toolCallId ?? `code-mode-${tool.name}`,
          prepared,
          signal,
          (update: unknown) => context.onUpdate?.(update),
          extensionContext,
        );
        context.captureResult?.(result);
        return compactResult(result);
      },
    }));
}

/**
 * Optional integration for pi-codex-conversion 3.x:
 * - publishes currently active Pi-CAD tools into Code/Notebook Mode;
 * - registers the public cross-extension preflight so nested calls use the
 *   exact same v7 authorization path as direct Pi calls.
 */
export function registerPiCadNestedToolBridge(pi: ExtensionAPI): PiCadNestedToolBridge {
  if (typeof (pi.events as any)?.on !== "function" || typeof (pi.events as any)?.emit !== "function") {
    return { available: false, async ensureProvider() { return false; }, dispose() {} };
  }
  let broker: PreflightBroker | undefined;
  let providerBroker: ProviderBroker | undefined;
  let unregisterPreflight: (() => void) | undefined;
  let unregisterProvider: (() => void) | undefined;
  let disposed = false;

  const detach = () => {
    unregisterPreflight?.();
    unregisterPreflight = undefined;
    unregisterProvider?.();
    unregisterProvider = undefined;
  };
  const onAvailable = (value: unknown) => {
    if (disposed || !isBroker(value)) return;
    if (broker !== value) {
      unregisterPreflight?.();
      broker = value;
      unregisterPreflight = broker.register(async (call) => {
        if (await selectKernelEngine(call.cwd) !== "v7") return;
        return authorizeMechanicalToolV7({ cwd: call.cwd, toolName: call.toolName, toolInput: call.input });
      });
    }
  };
  const unregisterAvailable = pi.events.on(CODE_MODE_PREFLIGHT_AVAILABLE, onAvailable) as unknown as (() => void) | undefined;
  const unregisterProviderAvailable = pi.events.on(CODE_MODE_PROVIDER_AVAILABLE, (value: unknown) => {
    if (disposed || !isProviderBroker(value) || value === providerBroker) return;
    unregisterProvider?.();
    providerBroker = value;
    unregisterProvider = value.register({ getTools: () => piCadNestedTools(pi) });
  }) as unknown as (() => void) | undefined;
  const registration: PiCadNestedToolBridge = {
    get available() {
      return !disposed && Boolean(broker?.isActive() && providerBroker?.isActive() && unregisterProvider);
    },
    ensureProvider() {
      if (disposed) return Promise.resolve(false);
      pi.events.emit(CODE_MODE_PROVIDER_REQUEST, { protocol: CODE_MODE_PROVIDER_PROTOCOL });
      return Promise.resolve(Boolean(providerBroker?.isActive() && unregisterProvider));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unregisterAvailable?.();
      unregisterProviderAvailable?.();
      detach();
      broker = undefined;
      providerBroker = undefined;
    },
  };
  // All extensions have loaded by session_start, regardless of package order.
  // Attach to conversion's existing shared runtime without registering a
  // second exec/wait/notebook surface on Pi-CAD's ExtensionAPI wrapper.
  pi.on("session_start", async () => { await registration.ensureProvider(); });
  pi.on("session_shutdown", () => registration.dispose());
  pi.events.emit(CODE_MODE_PREFLIGHT_REQUEST, { protocol: CODE_MODE_PREFLIGHT_PROTOCOL });
  pi.events.emit(CODE_MODE_PROVIDER_REQUEST, { protocol: CODE_MODE_PROVIDER_PROTOCOL });
  return registration;
}
