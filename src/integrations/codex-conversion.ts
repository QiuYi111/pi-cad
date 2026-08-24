import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

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

function schemaExample(schema: any, field = "value", depth = 0): string {
  if (!schema || depth > 6) return "{}";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return JSON.stringify(schema.enum[0]);
  const alternative = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (alternative) return schemaExample(alternative, field, depth + 1);
  if (schema.type === "string") return JSON.stringify(`<${field}>`);
  if (schema.type === "number" || schema.type === "integer") return "0";
  if (schema.type === "boolean") return "true";
  if (schema.type === "array") {
    const item = schemaExample(schema.items, field, depth + 1);
    return schema.minItems > 0 ? `[${item}]` : `[] /* items: ${item} */`;
  }
  if (schema.default !== undefined) return JSON.stringify(schema.default);
  if (schema.type === "object" || schema.properties) {
    const required = new Set<string>(schema.required ?? []);
    const entries = Object.entries(schema.properties ?? {})
      .filter(([name]) => required.has(name))
      .map(([name, child]) => `${JSON.stringify(name)}: ${schemaExample(child, name, depth + 1)}`);
    return `{ ${entries.join(", ")} }`;
  }
  return "{}";
}

function usageFor(tool: any): string {
  const hint = typeof tool.promptSnippet === "string" && tool.promptSnippet.trim()
    ? ` // ${tool.promptSnippet.trim()}`
    : "";
  return `await tools.${tool.name}(${schemaExample(tool.parameters)})${hint}`;
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
  return registeredMechanicalActionTools(pi)
    // Code Mode receives one system prompt for the whole agent loop. v7 can
    // advance through several phases inside that loop, so a phase-filtered
    // provider would make the next action executable but undocumented. Publish
    // the stable Pi-CAD action universe here; the shared v7 preflight remains
    // the authoritative, fail-closed phase and scope gate for every invocation.
    .filter((tool: any) => PI_CAD_OWNED_TOOLS.has(tool.name))
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
        const withDefaults = Value.Default(tool.parameters, structuredClone(input ?? {}));
        const prepared = tool.prepareArguments ? tool.prepareArguments(withDefaults) : withDefaults;
        if (!Value.Check(tool.parameters, prepared)) {
          const errors = [...Value.Errors(tool.parameters, prepared)].slice(0, 3)
            .map((error: any) => `${error.path || "/"}: ${error.message}`)
            .join("; ");
          throw new Error(`${tool.name} input does not match its registered schema: ${errors || "invalid input"}`);
        }
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
