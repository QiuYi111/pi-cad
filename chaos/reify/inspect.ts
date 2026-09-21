import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ProxyAgent, request } from "undici";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Provider / OAuth boundary
// ---------------------------------------------------------------------------

export interface ProviderCredential {
  id: string;
  type: string;
  hasCredentials: boolean;
  /** OAuth access-token expiry (epoch ms), or null for API-key providers. */
  expiresAt: number | null;
  expired: boolean | null;
}

export interface ProviderSelection {
  provider: string;
  model: string;
  thinking: string | null;
  source: string;
}

export interface ProviderProbe {
  url: string | null;
  status: number | null;
  ok: boolean;
  ms: number;
  authenticated: boolean;
  error?: string;
  skipped?: string;
}

export interface ProviderBoundary {
  agentDir: string;
  agentDirPresent: boolean;
  primeAgentRepo: string | null;
  credentials: ProviderCredential[];
  selection: ProviderSelection;
  baseUrl: string | null;
  api: string | null;
  registrySource: string | null;
  probe: ProviderProbe;
}

/** Raw credential entry as stored by Prime in its real `auth.json`. */
interface AuthEntry {
  type?: string;
  expires?: number;
  key?: string;
  access?: string;
}

function homeAgentDir(): string {
  return process.env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), ".prime", "agent");
}

/**
 * Classify a credential by Prime's real `auth.json` schema (see
 * `docs/providers.md` in the prime-agent checkout): API-key providers store
 * `{ "type": "api_key", "key": ... }` and OAuth providers store
 * `{ "type": "oauth", "access": ..., "expires": ... }`. Prime spells the
 * API-key type `api_key`, so a bare `apikey` comparison misreads the real
 * store; older/compact spellings are still folded in.
 */
function credentialKind(entry: AuthEntry | undefined): "api_key" | "oauth" | "unknown" {
  const raw = typeof entry?.type === "string" ? entry.type.trim().toLowerCase().replace(/[-_\s]/g, "") : "";
  if (raw === "apikey") return "api_key";
  if (raw === "oauth") return "oauth";
  return "unknown";
}

/**
 * Resolve a stored `key` the way Prime's host does (`docs/providers.md`): a
 * literal value is used as-is, an env-var name resolves to its value, and a
 * `!command` indirection is skipped because the host, not the kernel, runs
 * those. Private: the resolved secret only ever feeds a probe header.
 */
function resolveApiKeyValue(key: string | undefined): string | null {
  if (typeof key !== "string") return null;
  const value = key.trim();
  if (!value || value.startsWith("!")) return null;
  return process.env[value] ?? value;
}

/** Whether a stored credential actually carries a usable secret. */
function entryHasSecret(entry: AuthEntry | undefined): boolean {
  switch (credentialKind(entry)) {
    case "api_key":
      return Boolean(entry?.key);
    case "oauth":
      return Boolean(entry?.access);
    default:
      return Boolean(entry?.key) || Boolean(entry?.access);
  }
}

/** Real Prime checkout the Desktop runtime is built from, when one is resolvable. */
export function resolvePrimeAgentRepo(): string | null {
  const candidates = [
    process.env.PRIME_AGENT_REPO,
    "/home/jingyi/.local/share/pi-cad-desktop/runtime/prime-agent",
    join(homedir(), ".local", "share", "pi-cad-desktop", "runtime", "prime-agent"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "prime-agent.sh"))) return candidate;
  }
  return null;
}

/** Read-only view of the real credential store. Token values are never returned. */
export function readProviderCredentials(agentDir = homeAgentDir()): ProviderCredential[] {
  const path = join(agentDir, "auth.json");
  if (!existsSync(path)) return [];
  let parsed: Record<string, AuthEntry>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as typeof parsed;
  } catch {
    return [];
  }
  return Object.entries(parsed).map(([id, entry]) => {
    const type = typeof entry?.type === "string" ? entry.type : "unknown";
    const hasCredentials = entryHasSecret(entry);
    const expiresAt = typeof entry?.expires === "number" ? entry.expires : null;
    return { id, type, hasCredentials, expiresAt, expired: expiresAt === null ? null : expiresAt <= Date.now() };
  });
}

function readPrimeSettings(agentDir: string): { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string } {
  const path = join(agentDir, "settings.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof readPrimeSettings>;
  } catch {
    return {};
  }
}

export function resolveProviderSelection(agentDir = homeAgentDir(), override: { provider?: string; model?: string } = {}): ProviderSelection {
  if (override.provider && override.model) {
    return { provider: override.provider, model: override.model, thinking: null, source: "override" };
  }
  const envProvider = process.env.CHAOS_REIFY_PROVIDER;
  const envModel = process.env.CHAOS_REIFY_MODEL;
  if (envProvider && envModel) {
    return { provider: envProvider, model: envModel, thinking: process.env.CHAOS_REIFY_THINKING ?? null, source: "env" };
  }
  const settings = readPrimeSettings(agentDir);
  return {
    provider: override.provider ?? settings.defaultProvider ?? "unknown",
    model: override.model ?? settings.defaultModel ?? "unknown",
    thinking: settings.defaultThinkingLevel ?? null,
    source: "prime settings.json",
  };
}

/** Resolve the real provider base URL from Prime's own generated model registry. */
async function resolveModelEndpoint(primeRepo: string | null, provider: string, model: string): Promise<{ baseUrl: string; api: string; source: string } | null> {
  if (!primeRepo) return null;
  const registry = join(primeRepo, "packages", "ai", "dist", "models.generated.js");
  if (!existsSync(registry)) return null;
  try {
    const module = (await import(registry)) as { MODELS: Record<string, Record<string, { id: string; provider: string; baseUrl: string; api: string }>> };
    const group = module.MODELS[provider];
    const entry = group?.[model] ?? group?.[`${provider}.${model}`];
    if (entry?.baseUrl) return { baseUrl: entry.baseUrl, api: entry.api, source: "prime models.generated.js" };
  } catch {
    return null;
  }
  return null;
}

async function httpProbe(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number | null; ok: boolean; ms: number; error?: string }> {
  const startedAt = Date.now();
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  try {
    const response = await request(url, { method: "GET", headers, dispatcher, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    await response.body.dump();
    return { status: response.statusCode, ok: response.statusCode < 400, ms: Date.now() - startedAt };
  } catch (error) {
    return { status: null, ok: false, ms: Date.now() - startedAt, error: (error as Error).message };
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

/**
 * Observe the real provider/OAuth boundary: which provider is selected, which
 * credentials really exist, and where the provider lives. Network probing is
 * off by default: reading the boundary must not change the outside world. A
 * real provider request only happens when the caller explicitly opts in
 * (`probe: true` or `CHAOS_REIFY_PROVIDER_PROBE=1`).
 */
export async function inspectProviderBoundary(options: { agentDir?: string; override?: { provider?: string; model?: string }; probe?: boolean } = {}): Promise<ProviderBoundary> {
  const agentDir = options.agentDir ?? homeAgentDir();
  const primeAgentRepo = resolvePrimeAgentRepo();
  const credentials = readProviderCredentials(agentDir);
  const selection = resolveProviderSelection(agentDir, options.override ?? {});
  const endpoint = await resolveModelEndpoint(primeAgentRepo, selection.provider, selection.model);
  const credential = credentials.find((item) => item.id === selection.provider);
  const authed = Boolean(credential?.hasCredentials);
  const probeEnabled = options.probe ?? process.env.CHAOS_REIFY_PROVIDER_PROBE === "1";
  let probe: ProviderProbe = {
    url: endpoint ? `${endpoint.baseUrl.replace(/\/$/, "")}/models` : null,
    status: null,
    ok: false,
    ms: 0,
    authenticated: authed,
    ...(endpoint ? {} : { skipped: "provider endpoint not resolvable (no prime-agent model registry)" }),
  };
  if (endpoint && probeEnabled) {
    const result = await httpProbe(probe.url!, authed ? { authorization: `Bearer ${readAccessToken(agentDir, selection.provider) ?? ""}` } : {}, 15_000);
    probe = { ...probe, ...result };
  } else if (endpoint && !probeEnabled) {
    probe.skipped = "provider probe is opt-in (--provider-probe / CHAOS_REIFY_PROVIDER_PROBE=1)";
  }
  return {
    agentDir,
    agentDirPresent: existsSync(agentDir),
    primeAgentRepo,
    credentials,
    selection,
    baseUrl: endpoint?.baseUrl ?? null,
    api: endpoint?.api ?? null,
    registrySource: endpoint?.source ?? null,
    probe,
  };
}

/** Read the access token only to authenticate the probe; never log or return it. */
function readAccessToken(agentDir: string, provider: string): string | null {
  const path = join(agentDir, "auth.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, AuthEntry>;
    const entry = parsed[provider];
    switch (credentialKind(entry)) {
      case "api_key":
        return resolveApiKeyValue(entry?.key);
      case "oauth":
        return entry?.access ?? null;
      default:
        return entry?.access ?? resolveApiKeyValue(entry?.key);
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Desktop ↔ backend projection
// ---------------------------------------------------------------------------

export interface DesktopProjection {
  path: string;
  present: boolean;
  runId: string | null;
  phase: string | null;
  status: string | null;
  workflowHash: string | null;
  updatedAt: string | null;
}

export interface BackendRunState {
  runId: string;
  phase: string;
  status: string;
  workflowHash: string | null;
}

export interface DesktopConsistencyPair {
  projection: DesktopProjection;
  backend: BackendRunState | null;
  consistent: boolean;
  mismatch: string | null;
}

/** The Desktop-facing projection is written by the real authority, never by us. */
export function readDesktopProjection(project: string): DesktopProjection {
  const path = join(project, ".pi-cad", "status.json");
  const empty: DesktopProjection = { path, present: false, runId: null, phase: null, status: null, workflowHash: null, updatedAt: null };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      run?: { id?: string; phase?: string; status?: string; workflowHash?: string } | null;
      updatedAt?: string;
    };
    return {
      path,
      present: true,
      runId: parsed.run?.id ?? null,
      phase: parsed.run?.phase ?? null,
      status: parsed.run?.status ?? null,
      workflowHash: parsed.run?.workflowHash ?? null,
      updatedAt: parsed.updatedAt ?? null,
    };
  } catch {
    return { ...empty, present: true };
  }
}

export function readBackendRunState(canonical: string, runId: string): BackendRunState | null {
  const path = join(canonical, "runs", runId, "state.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { phase?: string; status?: string; workflow?: { hash?: string } };
    return { runId, phase: parsed.phase ?? "unknown", status: parsed.status ?? "unknown", workflowHash: parsed.workflow?.hash ?? null };
  } catch {
    return null;
  }
}

/** Compare the real Desktop projection against the real backend run state. */
export function inspectDesktopProjection(project: string, canonical: string, expectedRunId?: string | null): DesktopConsistencyPair {
  const projection = readDesktopProjection(project);
  const runId = projection.runId ?? expectedRunId ?? null;
  const backend = runId ? readBackendRunState(canonical, runId) : null;
  if (!projection.present) return { projection, backend, consistent: false, mismatch: "Desktop projection .pi-cad/status.json is missing" };
  if (!projection.runId) return { projection, backend, consistent: true, mismatch: null };
  if (!backend) return { projection, backend, consistent: false, mismatch: `Desktop shows run ${projection.runId}, backend store has no such run` };
  const mismatches: string[] = [];
  if (projection.phase !== backend.phase) mismatches.push(`phase ${projection.phase} vs ${backend.phase}`);
  if (projection.status !== backend.status) mismatches.push(`status ${projection.status} vs ${backend.status}`);
  if (projection.workflowHash && backend.workflowHash && projection.workflowHash !== backend.workflowHash) {
    mismatches.push("workflow hash differs");
  }
  return { projection, backend, consistent: mismatches.length === 0, mismatch: mismatches.length ? mismatches.join("; ") : null };
}

// ---------------------------------------------------------------------------
// Windows ↔ WSL boundary
// ---------------------------------------------------------------------------

export interface WslProbe {
  id: string;
  ready: boolean;
  detail: string;
}

export interface WslBoundary {
  host: string;
  boundary: "windows-wsl" | "wsl-linux" | "native";
  distro: string | null;
  /** The Windows side of the boundary, when it can really be reached. */
  windows: { reachable: boolean; wslExe: string | null; distros: string[]; version: string | null } | null;
  probes: WslProbe[];
  command: string;
  note: string;
}

const RUNTIME_PROBE_SCRIPT = [
  'export PATH="$HOME/.local/bin:$PATH"',
  'printf "node=%s\\n" "$(command -v node || true)"',
  'printf "uv=%s\\n" "$(command -v uv || true)"',
  'printf "python=%s\\n" "$(command -v python3 || true)"',
  'printf "bwrap=%s\\n" "$(command -v bwrap || true)"',
  'printf "prime=%s\\n" "$(test -f "$HOME/prime-agent.sh" -o -f "$PRIME_AGENT_REPO/prime-agent.sh" 2>/dev/null && echo ready || echo unknown)"',
].join("; ");

function parseProbes(stdout: string): WslProbe[] {
  const values = Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
  ) as Record<string, string>;
  return ["node", "uv", "python", "bwrap"].map((id) => ({ id, ready: Boolean(values[id]), detail: values[id] || "not found" }));
}

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function decodeWslText(value: string | Buffer): string {
  // wsl.exe emits UTF-16LE; decoding that as UTF-8 both leaves NULs and
  // mangles non-ASCII text, so decode the bytes as UTF-16LE instead.
  const text = Buffer.isBuffer(value) ? value.toString("utf16le") : String(value ?? "");
  return text.replaceAll("\u0000", "").trim();
}

function findWslExe(): string | null {
  const absolute = "/mnt/c/Windows/System32/wsl.exe";
  if (existsSync(absolute)) return absolute;
  for (const dir of process.env.PATH?.split(":") ?? []) {
    const candidate = join(dir, "wsl.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Observe the Windows side of the boundary through the real wsl.exe. */
async function probeWindowsSide(wslExe: string): Promise<NonNullable<WslBoundary["windows"]>> {
  let distros: string[] = [];
  let version: string | null = null;
  try {
    const list = await execFileAsync(wslExe, ["-l", "-q"], { encoding: "buffer", timeout: 20_000, windowsHide: true });
    distros = decodeWslText(list.stdout).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  } catch {
    /* Windows side not reachable through this command */
  }
  try {
    const release = await execFileAsync(wslExe, ["--version"], { encoding: "buffer", timeout: 20_000, windowsHide: true });
    version = decodeWslText(release.stdout).split(/\r?\n/)[0] ?? null;
  } catch {
    /* older inbox wsl.exe has no --version */
  }
  return { reachable: distros.length > 0 || version !== null, wslExe, distros, version };
}

/**
 * Probe the Windows ↔ WSL boundary with real commands instead of treating WSL
 * as a black box. On a Windows host this talks to `wsl.exe`; inside WSL (or on
 * native Linux) it probes the Linux side locally, and from inside WSL it also
 * reaches the Windows side through the real `wsl.exe`.
 */
export async function inspectWslBoundary(): Promise<WslBoundary> {
  const host = process.platform;
  const windowsCmd = 'wsl.exe -l -q; wsl.exe -d <distro> -- bash -lc "<runtime probe>"';
  if (host === "win32") {
    const windows = await probeWindowsSide("wsl.exe");
    let distro: string | null = null;
    distro = windows.distros[0] ?? null;
    if (!distro) {
      return { host, boundary: "windows-wsl", distro: null, windows, probes: [], command: windowsCmd, note: "Windows host, but no WSL distro is installed/initialized." };
    }
    try {
      const { stdout } = await execFileAsync("wsl.exe", ["-d", distro, "--", "bash", "-lc", RUNTIME_PROBE_SCRIPT], { encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      return { host, boundary: "windows-wsl", distro, windows, probes: parseProbes(stdout), command: windowsCmd, note: "Windows host driving a real WSL distro." };
    } catch (error) {
      return { host, boundary: "windows-wsl", distro, windows, probes: [], command: windowsCmd, note: `WSL distro probe failed: ${(error as Error).message}` };
    }
  }
  // Linux side: WSL or native. Probe the real local engineering runtime either way.
  let probes: WslProbe[] = [];
  try {
    const { stdout } = await execFileAsync("bash", ["-lc", RUNTIME_PROBE_SCRIPT], { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    probes = parseProbes(stdout);
  } catch {
    probes = [];
  }
  if (isWsl()) {
    const wslExe = findWslExe();
    const windows = wslExe ? await probeWindowsSide(wslExe) : { reachable: false, wslExe: null, distros: [], version: null };
    if (windows.reachable) probes = [...probes, { id: "windows-wsl", ready: true, detail: `wsl.exe sees ${windows.distros.join(", ") || "no distros"}` }];
    return {
      host,
      boundary: "wsl-linux",
      distro: process.env.WSL_DISTRO_NAME ?? windows.distros[0] ?? "unknown",
      windows,
      probes,
      command: RUNTIME_PROBE_SCRIPT,
      note: windows.reachable
        ? "Inside the WSL Linux side; the Windows side is really observed through wsl.exe."
        : "Inside the WSL Linux side; wsl.exe is not reachable, so the Windows side is not observable from here.",
    };
  }
  return { host, boundary: "native", distro: null, windows: null, probes, command: windowsCmd, note: "Native Linux/macOS host: there is no Windows↔WSL boundary here; run the same probe on a Windows host with wsl.exe." };
}
