import WebSocket from "ws";
import type { CloudEvent, CloudProject, CloudStatus, CloudUser, CloudWorkspaceInfo, CloudWorkspaceState } from "../../src/shared/contracts.js";

/** Refresh the access token this long before it expires (plan §9.2). */
export const CLOUD_REFRESH_LEAD_MS = 2 * 60_000;
const WORKSPACE_POLL_MS = 3_000;
const WORKSPACE_START_TIMEOUT_MS = 10 * 60_000;
const REFRESH_RETRY_MS = 30_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_ACCESS_TTL_MS = 15 * 60_000;

/** Tokens and identity kept between launches. The store encrypts them. */
export interface StoredCloudSession {
  baseUrl: string;
  user: CloudUser;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
}

export interface CloudSessionStore {
  available(): boolean;
  load(): Promise<StoredCloudSession | null>;
  save(session: StoredCloudSession): Promise<void>;
  clear(): Promise<void>;
}

export type OpenSocket = (url: string, headers: Record<string, string>) => WebSocket;

export interface CloudSessionOptions {
  baseUrl: string;
  store: CloudSessionStore;
  deviceLabel: string;
  now?: () => number;
  fetch?: typeof fetch;
  openSocket?: OpenSocket;
  refreshLeadMs?: number;
  workspacePollMs?: number;
  workspaceStartTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
}

/** A failed API call. `code` and the extra fields come from the server's {code, message, ...} body. */
export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryAfterSec?: number,
    readonly position?: number,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

/** The session is missing or was rejected. The user must sign in again. */
export class CloudAuthError extends Error {
  constructor(message = "登录已失效，请重新登录。") {
    super(message);
    this.name = "CloudAuthError";
  }
}

/** The server's capacity limit: the start request was queued at `position`. */
export function isCapacityFull(error: unknown): error is CloudApiError {
  return error instanceof CloudApiError && error.status === 409 && error.code === "capacity_full";
}

/** Turns a sign-in failure into the message the login page shows. */
export function describeLoginError(error: unknown): string {
  if (error instanceof CloudApiError) {
    if (error.status === 429 || error.code === "locked") {
      const minutes = Math.max(1, Math.ceil((error.retryAfterSec ?? 60) / 60));
      return `尝试次数过多，已锁定。请 ${minutes} 分钟后再试。`;
    }
    if (error.status === 403 || error.code === "account_disabled") return "账户已停用，请联系管理员。";
    if (error.status === 401 || error.code === "invalid_credentials") return "邮箱或密码错误";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Reads the `exp` claim of an access token, in epoch milliseconds, without verifying it. */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  user?: CloudUser;
}

const noop = () => {};

/**
 * Signed-in connection to one Reify hosted service (plan §9.2). It owns the
 * tokens, refreshes the access token before it expires, runs the project and
 * workspace calls, keeps the server event channel open, and opens the bridge
 * socket for RemoteBridge.
 */
export class CloudSession {
  private session: StoredCloudSession | null = null;
  private workspace: CloudWorkspaceInfo = { state: "stopped" };
  private readonly listeners = new Set<(event: CloudEvent) => void>();
  private readonly base: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly openSocketImpl: OpenSocket;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private startingWorkspace?: Promise<CloudWorkspaceInfo>;
  private events?: WebSocket;
  private eventsRetry?: ReturnType<typeof setTimeout>;
  private eventsBackoffMs: number;
  private closed = false;

  constructor(private readonly options: CloudSessionOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.openSocketImpl = options.openSocket ?? ((url, headers) => new WebSocket(url, { headers }));
    this.eventsBackoffMs = options.reconnectInitialMs ?? RECONNECT_INITIAL_MS;
  }

  get baseUrl(): string {
    return this.base;
  }

  /** Loads a saved session for this server. Nothing is sent over the network until a call needs it. */
  async restore(): Promise<void> {
    let stored: StoredCloudSession | null = null;
    try {
      stored = await this.options.store.load();
    } catch {
      stored = null;
    }
    if (!stored || stored.baseUrl !== this.base) return;
    this.session = stored;
    this.scheduleRefresh();
    this.startEvents();
  }

  status(): CloudStatus {
    return {
      signedIn: this.session !== null,
      baseUrl: this.base,
      user: this.session?.user,
      workspace: { ...this.workspace },
      eventsConnected: this.events !== undefined,
    };
  }

  on(listener: (event: CloudEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- Account ------------------------------------------------------------

  async login(email: string, password: string): Promise<CloudUser> {
    if (!this.options.store.available()) throw new Error("This system cannot store sign-in securely, so cloud sign-in is unavailable.");
    const body = await this.call<TokenResponse>("POST", "/v1/auth/login", { email, password, deviceLabel: this.options.deviceLabel }, false);
    await this.adopt(body);
    this.startEvents();
    return this.session!.user;
  }

  /** Revokes the refresh token on the server when it can, then forgets the session locally. */
  async logout(): Promise<void> {
    const current = this.session;
    if (current) await this.call("POST", "/v1/auth/logout", { refreshToken: current.refreshToken }, false).catch(noop);
    await this.forget();
    this.emit({ type: "session_ended", reason: "signed_out" });
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.call("POST", "/v1/auth/password", { oldPassword, newPassword });
  }

  // ---- Projects -----------------------------------------------------------

  async listProjects(): Promise<CloudProject[]> {
    const body = await this.call<unknown>("GET", "/v1/projects");
    const items = Array.isArray(body) ? body : (body as { projects?: unknown } | undefined)?.projects;
    return Array.isArray(items) ? items.map(toProject) : [];
  }

  async createProject(name: string): Promise<CloudProject> {
    return toProject(await this.call("POST", "/v1/projects", { name }));
  }

  async renameProject(id: string, name: string): Promise<CloudProject> {
    return toProject(await this.call("PATCH", `/v1/projects/${encodeURIComponent(id)}`, { name }));
  }

  async deleteProject(id: string): Promise<void> {
    await this.call("DELETE", `/v1/projects/${encodeURIComponent(id)}`);
  }

  // ---- Workspace ----------------------------------------------------------

  /**
   * Starts the workspace and resolves once it is running. A full server reports
   * its queue position (409 capacity_full); the position is polled until a slot
   * frees up. Concurrent callers share one start.
   */
  startWorkspace(): Promise<CloudWorkspaceInfo> {
    this.startingWorkspace ??= this.runStart().finally(() => { this.startingWorkspace = undefined; });
    return this.startingWorkspace;
  }

  async stopWorkspace(): Promise<CloudWorkspaceInfo> {
    await this.call("POST", "/v1/workspace/stop");
    this.setWorkspace("stopping");
    return { ...this.workspace };
  }

  /** Tells the server the user is still working, which resets the idle timer. */
  async keepalive(): Promise<void> {
    await this.call("POST", "/v1/workspace/keepalive");
    this.workspace = { ...this.workspace, idleWarningAt: undefined };
  }

  async refreshWorkspace(): Promise<CloudWorkspaceInfo> {
    const body = await this.call<Record<string, unknown>>("GET", "/v1/workspace");
    const state = toWorkspaceState(body.state);
    this.setWorkspace(state, typeof body.position === "number" ? body.position : undefined);
    return { ...this.workspace };
  }

  /** Opens the bridge socket. The platform API forwards it to the user's workspace gateway. */
  async connectBridge(): Promise<WebSocket> {
    const token = await this.accessToken();
    return this.open("/v1/workspace/bridge", token);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.eventsRetry);
    this.events?.close();
    this.events = undefined;
  }

  // ---- Start loop ---------------------------------------------------------

  private async runStart(): Promise<CloudWorkspaceInfo> {
    const timeoutMs = this.options.workspaceStartTimeoutMs ?? WORKSPACE_START_TIMEOUT_MS;
    const pollMs = this.options.workspacePollMs ?? WORKSPACE_POLL_MS;
    const deadline = this.now() + timeoutMs;
    await this.requestStart();
    for (;;) {
      const info = await this.refreshWorkspace();
      if (info.state === "running") return info;
      if (info.state === "failed") throw new Error(info.error || "工作区启动失败，请稍后重试。");
      if (this.now() > deadline) throw new Error("工作区启动超时，请稍后重试。");
      // Still stopped means the request has not taken effect yet (queued or rejected): ask again.
      if (info.state === "stopped") await this.requestStart();
      await sleep(pollMs);
    }
  }

  private async requestStart(): Promise<void> {
    try {
      await this.call("POST", "/v1/workspace/start");
      this.setWorkspace("starting");
    } catch (error) {
      if (!isCapacityFull(error)) throw error;
      this.setWorkspace("queued", error.position);
    }
  }

  // ---- Events -------------------------------------------------------------

  private startEvents(): void {
    if (this.closed || !this.session || this.events || this.eventsRetry) return;
    void this.openEvents();
  }

  private async openEvents(): Promise<void> {
    let socket: WebSocket;
    try {
      socket = await this.open("/v1/events", await this.accessToken());
    } catch (error) {
      if (error instanceof CloudAuthError) {
        await this.expire();
        return;
      }
      this.scheduleEventsRetry();
      return;
    }
    if (this.closed) {
      socket.close();
      return;
    }
    this.events = socket;
    this.eventsBackoffMs = this.options.reconnectInitialMs ?? RECONNECT_INITIAL_MS;
    this.emit({ type: "events_connection", connected: true });
    socket.on("message", (data) => this.onEventMessage(data.toString()));
    socket.on("close", () => {
      if (this.events !== socket) return;
      this.events = undefined;
      this.emit({ type: "events_connection", connected: false });
      this.scheduleEventsRetry();
    });
    socket.on("error", noop);
    // Events sent while disconnected are lost, so the state is read again after every connect.
    void this.refreshWorkspace().catch(noop);
  }

  private scheduleEventsRetry(): void {
    if (this.closed || !this.session) return;
    const delay = this.eventsBackoffMs;
    this.eventsBackoffMs = Math.min(delay * 2, this.options.reconnectMaxMs ?? RECONNECT_MAX_MS);
    this.eventsRetry = setTimeout(() => {
      this.eventsRetry = undefined;
      this.startEvents();
    }, delay);
    this.eventsRetry.unref?.();
  }

  private onEventMessage(text: string): void {
    let message: { type?: unknown; state?: unknown; reclaimAt?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    switch (message.type) {
      case "workspace_state":
        this.setWorkspace(toWorkspaceState(message.state));
        return;
      case "idle_warning": {
        const reclaimAt = typeof message.reclaimAt === "string" ? message.reclaimAt : new Date(this.now()).toISOString();
        this.workspace = { ...this.workspace, idleWarningAt: reclaimAt };
        this.emit({ type: "idle_warning", reclaimAt });
        return;
      }
      case "reclaimed":
        this.setWorkspace("stopped");
        this.emit({ type: "reclaimed" });
        return;
    }
  }

  private open(path: string, token: string): Promise<WebSocket> {
    const socket = this.openSocketImpl(this.wsUrl(path), { Authorization: `Bearer ${token}` });
    socket.on("error", noop);
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(socket));
      socket.once("unexpected-response", (_request, response) => {
        socket.terminate();
        const status = response.statusCode ?? 0;
        reject(status === 401 || status === 403 ? new CloudAuthError() : new CloudApiError(status, undefined, `服务器返回 ${status}`));
      });
      socket.once("error", (error) => reject(new CloudApiError(0, "network", error.message)));
    });
  }

  // ---- Tokens -------------------------------------------------------------

  private async accessToken(): Promise<string> {
    if (!this.session) throw new CloudAuthError("请先登录。");
    if (this.now() + (this.options.refreshLeadMs ?? CLOUD_REFRESH_LEAD_MS) >= this.session.accessExpiresAt) await this.refresh();
    if (!this.session) throw new CloudAuthError();
    return this.session.accessToken;
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const current = this.session;
    if (!current) throw new CloudAuthError();
    try {
      const body = await this.call<TokenResponse>("POST", "/v1/auth/refresh", { refreshToken: current.refreshToken }, false);
      await this.adopt(body, current.user);
    } catch (error) {
      if (error instanceof CloudAuthError || (error instanceof CloudApiError && (error.status === 401 || error.status === 403))) {
        await this.expire();
        throw new CloudAuthError();
      }
      throw error;
    }
  }

  private async adopt(body: TokenResponse, fallbackUser?: CloudUser): Promise<void> {
    const user = body.user ? { id: body.user.id, email: body.user.email, displayName: body.user.displayName ?? null } : fallbackUser;
    if (!user || !body.accessToken || !body.refreshToken) throw new CloudApiError(502, "bad_response", "服务器返回的登录信息不完整。");
    const expiresAt = typeof body.expiresIn === "number"
      ? this.now() + body.expiresIn * 1000
      : jwtExpiryMs(body.accessToken) ?? this.now() + DEFAULT_ACCESS_TTL_MS;
    const next: StoredCloudSession = { baseUrl: this.base, user, accessToken: body.accessToken, refreshToken: body.refreshToken, accessExpiresAt: expiresAt };
    await this.options.store.save(next);
    this.session = next;
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    if (this.closed || !this.session) return;
    const lead = this.options.refreshLeadMs ?? CLOUD_REFRESH_LEAD_MS;
    const delay = Math.max(0, this.session.accessExpiresAt - lead - this.now());
    this.refreshTimer = setTimeout(() => {
      void this.refresh().catch(() => {
        // A transient failure keeps the session and retries. A rejected session has already been cleared.
        if (this.session && !this.closed) {
          this.refreshTimer = setTimeout(() => this.scheduleRefresh(), REFRESH_RETRY_MS);
          this.refreshTimer.unref?.();
        }
      });
    }, delay);
    this.refreshTimer.unref?.();
  }

  /** Server rejected the session: clear it and tell the renderer. */
  private async expire(): Promise<void> {
    if (!this.session) return;
    await this.forget();
    this.emit({ type: "session_ended", reason: "expired" });
  }

  private async forget(): Promise<void> {
    this.session = null;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.eventsRetry);
    this.events?.close();
    this.events = undefined;
    this.workspace = { state: "stopped" };
    await this.options.store.clear();
  }

  // ---- HTTP ---------------------------------------------------------------

  private async call<T = unknown>(method: string, path: string, body?: unknown, authenticated = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authenticated) headers.authorization = `Bearer ${await this.accessToken()}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      throw new CloudApiError(0, "network", `无法连接到服务器：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401 && authenticated && this.session) {
      // The access token may have expired between the freshness check and the call: refresh once and retry.
      await this.refresh();
      return this.call<T>(method, path, body, authenticated);
    }
    const text = await response.text();
    let data: Record<string, unknown> | undefined;
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    } catch {
      data = undefined;
    }
    if (!response.ok) {
      const message = typeof data?.message === "string" ? data.message : `请求失败（${response.status}）`;
      const retry = typeof data?.retryAfterSec === "number" ? data.retryAfterSec : Number(response.headers.get("retry-after")) || undefined;
      const position = typeof data?.position === "number" ? data.position : undefined;
      throw new CloudApiError(response.status, typeof data?.code === "string" ? data.code : undefined, message, retry, position);
    }
    return data as T;
  }

  private wsUrl(path: string): string {
    const url = new URL(path, `${this.base}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private setWorkspace(state: CloudWorkspaceState, position?: number): void {
    const next: CloudWorkspaceInfo = { state, ...(state === "queued" && position !== undefined ? { position } : {}) };
    this.workspace = next;
    this.emit({ type: "workspace_state", state, ...(next.position !== undefined ? { position: next.position } : {}) });
  }

  private emit(event: CloudEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function toProject(value: unknown): CloudProject {
  const record = ((value as { project?: unknown } | undefined)?.project ?? value) as { id?: unknown; name?: unknown; updatedAt?: unknown } | undefined;
  if (typeof record?.id !== "string" || typeof record.name !== "string") throw new CloudApiError(502, "bad_response", "服务器返回的项目信息不完整。");
  return { id: record.id, name: record.name, ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}) };
}

function toWorkspaceState(value: unknown): CloudWorkspaceState {
  switch (value) {
    case "queued":
    case "starting":
    case "running":
    case "stopping":
    case "failed":
      return value;
    default:
      return "stopped";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
