import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { request } from "undici";

import {
  homeAgentDir,
  inspectProviderBoundary,
  providerAuthHeaders,
  resolveProviderEndpoint,
  type ProviderBoundary,
} from "./inspect.ts";
import { parseUpstream, ProviderFaultProxy, type ProviderFaultMode, type ProviderFaultPlan } from "./provider-proxy.ts";
import type { ReifySession } from "./session.ts";

/**
 * The provider / OAuth boundary of the chaos slice.
 *
 * Two kinds of real fault live here:
 *
 * 1. Credential faults mutate a chaos-owned copy of the real Prime credential
 *    store (same path, same `auth.json` schema) so the product's own reader
 *    really sees an expired / missing / unusable credential.
 * 2. Transport faults put a real fault proxy on the wire in front of the real
 *    provider endpoint, carrying the real credential header, and break the
 *    connection the way a network fault would (latency / hang / reset /
 *    truncated stream / 429 / 5xx).
 *
 * Neither one sends a real LLM turn: the slice never wants to spend tokens or
 * invent a second oracle. What is real is the file, the schema, the endpoint
 * and the bytes on the wire; what is deliberately out of scope is the agent
 * loop itself.
 */

/** Transport faults only run when the caller explicitly asks for real network. */
export function providerFaultsEnabled(): boolean {
  return process.env.CHAOS_REIFY_PROVIDER_FAULTS === "1";
}

export interface CredentialSandbox {
  /** Prime agent dir the faulted credential store lives in. */
  dir: string;
  /** Where the copy came from, or null when the machine has no real store. */
  source: string | null;
  files: string[];
}

const AUTH_FILE = "auth.json";

/**
 * Copy the real credential store into the chaos project so credential faults
 * mutate our own copy, never the machine's live login.
 */
export function seedCredentialSandbox(session: ReifySession, sourceDir = homeAgentDir()): CredentialSandbox {
  const dir = join(session.root, "prime-agent");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const name of [AUTH_FILE, "settings.json"]) {
    const from = join(sourceDir, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(dir, name));
    files.push(name);
  }
  return { dir, source: existsSync(sourceDir) ? sourceDir : null, files };
}

export function credentialSandboxPresent(sandbox: CredentialSandbox): boolean {
  return sandbox.files.includes(AUTH_FILE);
}

interface AuthEntry {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}

function readSandboxAuth(sandbox: CredentialSandbox): Record<string, AuthEntry> {
  const path = join(sandbox.dir, AUTH_FILE);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, AuthEntry>;
}

function writeSandboxAuth(sandbox: CredentialSandbox, entries: Record<string, AuthEntry>): void {
  writeFileSync(join(sandbox.dir, AUTH_FILE), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

export type CredentialFault = "expire" | "drop" | "blank";

export interface CredentialFaultResult {
  provider: string;
  fault: CredentialFault;
  /** What the product's own reader says before and after. */
  before: { present: boolean; hasCredentials: boolean; expired: boolean | null };
  after: { present: boolean; hasCredentials: boolean; expired: boolean | null };
}

function describe(boundary: ProviderBoundary, provider: string) {
  const credential = boundary.credentials.find((item) => item.id === provider);
  return {
    present: Boolean(credential),
    hasCredentials: Boolean(credential?.hasCredentials),
    expired: credential ? credential.expired : null,
  };
}

/** Read the boundary the way the product reader does, without any network. */
export async function observeCredential(
  sandbox: CredentialSandbox,
  /** A partial override; an empty one means "use the machine's own selection". */
  selection: { provider?: string; model?: string },
): Promise<{ boundary: ProviderBoundary; described: ReturnType<typeof describe> }> {
  const boundary = await inspectProviderBoundary({ agentDir: sandbox.dir, override: selection, probe: false });
  // The caller's `selection` may be an empty override (`{}`) and rely on the
  // sandbox's own settings.json. Reading the credential by the *input* would
  // then look up `undefined` and report "no credential for this provider",
  // which made every credential fault quietly NotApplicable. Only the resolved
  // selection names a provider.
  return { boundary, described: describe(boundary, boundary.selection.provider) };
}

/**
 * Really break one stored credential in the chaos copy: expire an OAuth
 * token, delete the entry, or blank its secret. The product's reader then
 * really reports it as unusable.
 */
export async function applyCredentialFault(
  sandbox: CredentialSandbox,
  selection: { provider: string; model: string },
  fault: CredentialFault,
): Promise<CredentialFaultResult> {
  const before = await observeCredential(sandbox, selection);
  const entries = readSandboxAuth(sandbox);
  const entry = entries[selection.provider];
  if (!entry || fault === "drop") {
    delete entries[selection.provider];
  } else if (fault === "expire") {
    // OAuth entries carry the real `expires` epoch; API-key entries are given
    // the OAuth shape so the expiry is meaningful for the fault.
    entries[selection.provider] = { ...entry, expires: Date.now() - 60_000 };
  } else {
    entries[selection.provider] = { ...entry, key: "", access: "" };
  }
  writeSandboxAuth(sandbox, entries);
  const after = await observeCredential(sandbox, selection);
  return { provider: selection.provider, fault, before: before.described, after: after.described };
}

/** Put the untouched copy back, so later steps see the real machine again. */
export function restoreCredentialSandbox(sandbox: CredentialSandbox): void {
  rmSync(sandbox.dir, { recursive: true, force: true });
  mkdirSync(sandbox.dir, { recursive: true });
  for (const name of sandbox.files) {
    const from = join(sandbox.source ?? "", name);
    if (sandbox.source && existsSync(from)) copyFileSync(from, join(sandbox.dir, name));
  }
}

export interface TransportFaultResult {
  mode: ProviderFaultMode;
  endpoint: string;
  authenticated: boolean;
  status: number | null;
  ok: boolean;
  bytes: number;
  ms: number;
  error?: string;
  proxy: { connections: number; faults: number; bytesUp: number; bytesDown: number };
}

export interface TransportFaultOptions {
  baseUrl: string;
  path?: string;
  plan: ProviderFaultPlan;
  authHeaders?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Fire one real request at the real provider endpoint through the fault
 * proxy. The upstream leg is a real TLS connection; the fault is really on the
 * wire. Returns what the client really observed.
 */
export async function runTransportFault(options: TransportFaultOptions): Promise<TransportFaultResult> {
  const proxy = await ProviderFaultProxy.start(parseUpstream(options.baseUrl), options.plan);
  const startedAt = Date.now();
  let status: number | null = null;
  let ok = false;
  let bytes = 0;
  let error: string | undefined;
  const timeoutMs = options.timeoutMs ?? 3_000;
  try {
    const response = await request(proxy.urlFor(options.path ?? "/models"), {
      method: "GET",
      headers: { accept: "application/json", ...(options.authHeaders ?? {}) },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    status = response.statusCode;
    ok = response.statusCode < 400;
    const body = await response.body.arrayBuffer();
    bytes = body.byteLength;
  } catch (caught) {
    error = (caught as Error).message;
  } finally {
    await proxy.close().catch(() => undefined);
  }
  return {
    mode: options.plan.mode,
    endpoint: options.baseUrl,
    authenticated: Boolean(options.authHeaders && Object.keys(options.authHeaders).length > 0),
    status,
    ok,
    bytes,
    ms: Date.now() - startedAt,
    ...(error ? { error } : {}),
    proxy: proxy.observations,
  };
}

/** Resolve the real endpoint + real credential header for transport faults. */
export async function transportTarget(
  sandbox: CredentialSandbox,
  selection: { provider: string; model: string },
): Promise<{ baseUrl: string; source: string; authHeaders: Record<string, string> } | null> {
  const endpoint = await resolveProviderEndpoint(selection);
  if (!endpoint) return null;
  return { baseUrl: endpoint.baseUrl, source: endpoint.source, authHeaders: providerAuthHeaders(sandbox.dir, selection.provider) };
}

export { type ProviderFaultMode, type ProviderFaultPlan };
