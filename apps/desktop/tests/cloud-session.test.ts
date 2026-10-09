import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { CloudApiError, CloudAuthError, CloudSession, describeLoginError, jwtExpiryMs, workspaceInfoFromView, type CloudSessionOptions, type StoredCloudSession, type WorkspaceView } from "../electron/main/cloud-session";
import { EncryptedCloudSessionStore, type SecretCipher } from "../electron/main/cloud-token-store";
import type { CloudEvent } from "../src/shared/contracts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- Fake platform API: HTTP routes plus WebSocket endpoints -------------------

interface Recorded { method: string; path: string; authorization?: string; body?: Record<string, unknown> }
interface Reply { status: number; body?: unknown; headers?: Record<string, string> }
type Route = (request: Recorded) => Reply;

class FakeCloud {
  readonly requests: Recorded[] = [];
  readonly upgrades: Array<{ path: string; authorization?: string }> = [];
  readonly routes = new Map<string, Route>();
  /** WebSocket upgrades answered with a plain HTTP error instead, as the platform API does for a refused bridge. */
  readonly upgradeReplies = new Map<string, { status: number; body: unknown }>();
  /** Sockets opened by the client, by path. */
  readonly sockets = new Map<string, WebSocket[]>();
  /** Per-path behaviour for WebSocket connections, called with the connection count for that path. */
  onSocket?: (path: string, socket: WebSocket, count: number) => void;
  baseUrl = "";
  private server!: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly open = new Set<Socket>();

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const path = (request.url ?? "/").split("?")[0]!;
        const recorded: Recorded = {
          method: request.method ?? "GET",
          path,
          authorization: request.headers.authorization,
          body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
        };
        this.requests.push(recorded);
        const route = this.routes.get(`${recorded.method} ${path}`);
        const reply = route ? route(recorded) : { status: 404, body: { code: "not_found", message: `no route ${recorded.method} ${path}` } };
        response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        response.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
      });
    });
    this.server.on("connection", (socket) => {
      this.open.add(socket);
      socket.on("close", () => this.open.delete(socket));
    });
    this.server.on("upgrade", (request: IncomingMessage, socket, head) => {
      const path = (request.url ?? "/").split("?")[0]!;
      const authorization = request.headers.authorization;
      this.upgrades.push({ path, authorization });
      const refused = this.upgradeReplies.get(path);
      if (refused) {
        const body = JSON.stringify(refused.body);
        socket.end(`HTTP/1.1 ${refused.status} Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        const list = this.sockets.get(path) ?? [];
        list.push(ws);
        this.sockets.set(path, list);
        this.onSocket?.(path, ws, list.length);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as { port: number };
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  route(key: string, handler: Route): void {
    this.routes.set(key, handler);
  }

  pathRequests(path: string): Recorded[] {
    return this.requests.filter((request) => request.path === path);
  }

  async stop(): Promise<void> {
    for (const list of this.sockets.values()) for (const ws of list) ws.terminate();
    for (const socket of this.open) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ---- Helpers ------------------------------------------------------------------

const cloud = new FakeCloud();
let sessions: CloudSession[] = [];

function memoryStore() {
  const store = {
    value: null as StoredCloudSession | null,
    saves: 0,
    available: () => true,
    load: async () => store.value,
    save: async (session: StoredCloudSession) => { store.value = session; store.saves += 1; },
    clear: async () => { store.value = null; },
  };
  return store;
}

function createSession(overrides: Partial<CloudSessionOptions> = {}) {
  const store = memoryStore();
  const session = new CloudSession({
    baseUrl: cloud.baseUrl,
    store,
    deviceLabel: "test-desktop",
    workspacePollMs: 5,
    reconnectInitialMs: 20,
    reconnectMaxMs: 100,
    ...overrides,
  });
  sessions.push(session);
  return { session, store };
}

/** A GET /v1/workspace body in the server's shape (WorkspaceView in platform-api/src/workspace/service.ts). */
function workspaceView(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    name: "ws-test",
    state: "stopped",
    desired: "stopped",
    lastActivityAt: null,
    idleWarnedAt: null,
    reclaimAt: null,
    lastError: null,
    queuePosition: null,
    ...overrides,
  };
}

const PROJECT = { id: "p1", name: "Bracket", role: "maintainer", createdAt: "2026-10-01T00:00:00.000Z" };

function tokens(access: string, refresh: string, expiresIn = 900) {
  return { accessToken: access, refreshToken: refresh, expiresIn, user: { id: "u1", email: "a@example.com", displayName: "Alice" } };
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function collect(session: CloudSession): CloudEvent[] {
  const events: CloudEvent[] = [];
  session.on((event) => events.push(event));
  return events;
}

/** Default platform behaviour: login issues a1/r1, refresh rotates, events stay open and quiet. */
function installDefaultRoutes(): void {
  cloud.route("POST /v1/auth/login", (request) => (request.body?.password === "right"
    ? { status: 200, body: tokens("a1", "r1") }
    : { status: 401, body: { code: "invalid_credentials", message: "邮箱或密码错误" } }));
  cloud.route("POST /v1/auth/refresh", () => ({ status: 200, body: tokens("a2", "r2") }));
  cloud.route("POST /v1/auth/logout", () => ({ status: 204 }));
  cloud.route("GET /v1/workspace", () => ({ status: 200, body: workspaceView() }));
}

beforeAll(async () => {
  await cloud.start();
});

afterAll(async () => {
  await cloud.stop();
});

beforeEach(() => {
  cloud.requests.length = 0;
  cloud.upgrades.length = 0;
  cloud.routes.clear();
  cloud.upgradeReplies.clear();
  cloud.sockets.clear();
  cloud.onSocket = undefined;
  installDefaultRoutes();
  sessions = [];
});

afterEach(() => {
  for (const session of sessions) session.close();
  for (const list of cloud.sockets.values()) for (const ws of list) ws.terminate();
});

// ---- Tests --------------------------------------------------------------------

describe("cloud session sign-in", () => {
  it("logs in, stores the session and reports the user", async () => {
    const { session, store } = createSession();
    const user = await session.login("a@example.com", "right");
    expect(user).toEqual({ id: "u1", email: "a@example.com", displayName: "Alice" });
    expect(session.status()).toMatchObject({ signedIn: true, baseUrl: cloud.baseUrl, user });
    expect(store.value?.refreshToken).toBe("r1");
    expect(cloud.pathRequests("/v1/auth/login")[0]?.body).toEqual({ email: "a@example.com", password: "right", deviceLabel: "test-desktop" });
  });

  it("refuses to sign in when the system cannot store the session securely", async () => {
    const { session, store } = createSession();
    store.available = () => false;
    await expect(session.login("a@example.com", "right")).rejects.toThrow("cannot store sign-in securely");
    expect(cloud.pathRequests("/v1/auth/login")).toHaveLength(0);
  });

  it("maps login failures to the messages the login page shows", async () => {
    const { session } = createSession();
    const failureText = async (password: string) => {
      try {
        await session.login("a@example.com", password);
      } catch (error) {
        return describeLoginError(error);
      }
      throw new Error("login unexpectedly succeeded");
    };

    expect(await failureText("wrong")).toBe("邮箱或密码错误");

    cloud.route("POST /v1/auth/login", () => ({ status: 429, body: { code: "locked", message: "尝试次数过多", retryAfterSec: 900 } }));
    expect(await failureText("any")).toBe("尝试次数过多，已锁定。请 15 分钟后再试。");

    cloud.route("POST /v1/auth/login", () => ({ status: 403, body: { code: "account_disabled", message: "账户已停用" } }));
    expect(await failureText("any")).toBe("账户已停用，请联系管理员。");
  });

  it("restores a saved session for the same server and ignores one for another server", async () => {
    const { session, store } = createSession();
    await session.login("a@example.com", "right");
    const restored = createSession({ store });
    await restored.session.restore();
    expect(restored.session.status()).toMatchObject({ signedIn: true, user: { email: "a@example.com" } });

    const other = memoryStore();
    other.value = { ...store.value!, baseUrl: "https://elsewhere.example" };
    const elsewhere = createSession({ store: other });
    await elsewhere.session.restore();
    expect(elsewhere.session.status().signedIn).toBe(false);
  });

  it("logs out on the server and forgets the saved session", async () => {
    const { session, store } = createSession();
    const events = collect(session);
    await session.login("a@example.com", "right");
    await session.logout();
    expect(cloud.pathRequests("/v1/auth/logout")[0]?.body).toEqual({ refreshToken: "r1" });
    expect(store.value).toBeNull();
    expect(session.status().signedIn).toBe(false);
    expect(events).toContainEqual({ type: "session_ended", reason: "signed_out" });
  });

  it("changes the password with the access token", async () => {
    cloud.route("POST /v1/auth/password", () => ({ status: 204 }));
    const { session } = createSession();
    await session.login("a@example.com", "right");
    await session.changePassword("right", "a brand new pass");
    expect(cloud.pathRequests("/v1/auth/password")[0]).toMatchObject({
      authorization: "Bearer a1",
      body: { oldPassword: "right", newPassword: "a brand new pass", refreshToken: "r1" },
    });
  });
});

describe("cloud session tokens", () => {
  it("refreshes the access token before it expires, so the next call uses the new token", async () => {
    let clock = 1_000_000;
    cloud.route("POST /v1/auth/login", () => ({ status: 200, body: tokens("a1", "r1", 300) }));
    cloud.route("GET /v1/projects", (request) => (request.authorization === "Bearer a2"
      ? { status: 200, body: { projects: [PROJECT] } }
      : { status: 401, body: { code: "unauthorized", message: "expired" } }));
    const { session } = createSession({ now: () => clock });
    await session.login("a@example.com", "right");

    // 200 seconds in: 300 - 200 = 100 seconds left, which is inside the two-minute lead.
    clock += 200_000;
    await expect(session.listProjects()).resolves.toEqual([PROJECT]);
    const paths = cloud.requests.map((request) => request.path);
    expect(paths.indexOf("/v1/auth/refresh")).toBeGreaterThan(-1);
    expect(paths.indexOf("/v1/auth/refresh")).toBeLessThan(paths.indexOf("/v1/projects"));
    expect(cloud.pathRequests("/v1/projects")).toHaveLength(1);
  });

  it("refreshes automatically two minutes before expiry without a call", async () => {
    cloud.route("POST /v1/auth/login", () => ({ status: 200, body: tokens("a1", "r1", 121) }));
    const { session, store } = createSession();
    await session.login("a@example.com", "right");
    await waitFor(() => cloud.pathRequests("/v1/auth/refresh").length > 0);
    await waitFor(() => store.value?.accessToken === "a2");
  });

  it("retries once after a 401 by refreshing the session", async () => {
    cloud.route("GET /v1/projects", (request) => (request.authorization === "Bearer a2"
      ? { status: 200, body: { projects: [{ ...PROJECT, id: "p2", name: "Gear" }] } }
      : { status: 401, body: { code: "unauthorized", message: "expired" } }));
    const { session } = createSession();
    await session.login("a@example.com", "right");
    await expect(session.listProjects()).resolves.toEqual([{ ...PROJECT, id: "p2", name: "Gear" }]);
  });

  it("clears the session and emits session_ended when the refresh token is rejected", async () => {
    let clock = 1_000_000;
    cloud.route("POST /v1/auth/login", () => ({ status: 200, body: tokens("a1", "r1", 300) }));
    cloud.route("POST /v1/auth/refresh", () => ({ status: 401, body: { code: "invalid_refresh", message: "invalid" } }));
    const { session, store } = createSession({ now: () => clock });
    const events = collect(session);
    await session.login("a@example.com", "right");
    clock += 200_000;
    await expect(session.listProjects()).rejects.toBeInstanceOf(CloudAuthError);
    expect(events).toContainEqual({ type: "session_ended", reason: "expired" });
    expect(session.status().signedIn).toBe(false);
    expect(store.value).toBeNull();
  });

  it("reads expiry from the access token when the server does not send expiresIn", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url");
    expect(jwtExpiryMs(`x.${payload}.y`)).toBe(2_000_000_000_000);
    expect(jwtExpiryMs("not-a-token")).toBeUndefined();
  });
});

describe("cloud session projects and workspace", () => {
  it("lists, creates, renames and deletes projects", async () => {
    cloud.route("GET /v1/projects", () => ({ status: 200, body: { projects: [PROJECT] } }));
    cloud.route("POST /v1/projects", () => ({ status: 201, body: { id: "p2", name: "Gear", role: "maintainer", createdAt: "2026-10-02T00:00:00.000Z" } }));
    cloud.route("PATCH /v1/projects/p2", () => ({ status: 200, body: { id: "p2", name: "Spur gear", role: "maintainer", createdAt: "2026-10-02T00:00:00.000Z" } }));
    cloud.route("DELETE /v1/projects/p2", () => ({ status: 204 }));
    const { session } = createSession();
    await session.login("a@example.com", "right");
    await expect(session.listProjects()).resolves.toEqual([PROJECT]);
    await expect(session.createProject("Gear")).resolves.toEqual({ id: "p2", name: "Gear", role: "maintainer", createdAt: "2026-10-02T00:00:00.000Z" });
    await expect(session.renameProject("p2", "Spur gear")).resolves.toMatchObject({ id: "p2", name: "Spur gear", role: "maintainer" });
    await session.deleteProject("p2");
    expect(cloud.pathRequests("/v1/projects")[1]?.body).toEqual({ name: "Gear" });
  });

  it("queues behind a full server at the position the server reports, then resolves once running", async () => {
    let startCalls = 0;
    cloud.route("POST /v1/workspace/start", () => {
      startCalls += 1;
      return { status: 409, body: { code: "capacity_full", message: "同时运行的工作区已满，已排队", position: 2 } };
    });
    // The queue moves up, then the workspace is admitted (desired running) and comes up.
    const views = [
      workspaceView({ queuePosition: 2 }),
      workspaceView({ queuePosition: 1 }),
      workspaceView({ desired: "running", state: "starting" }),
      workspaceView({ desired: "running", state: "running" }),
    ];
    let poll = 0;
    cloud.route("GET /v1/workspace", () => ({ status: 200, body: views[Math.min(poll++, views.length - 1)] }));
    const { session } = createSession();
    const events = collect(session);
    await session.login("a@example.com", "right");
    await expect(session.startWorkspace()).resolves.toEqual({ state: "running" });
    expect(startCalls).toBe(1);
    expect(events).toContainEqual({ type: "workspace_state", state: "queued", position: 2 });
    expect(events).toContainEqual({ type: "workspace_state", state: "queued", position: 1 });
    expect(events.findIndex((e) => e.type === "workspace_state" && e.state === "queued" && e.position === 1))
      .toBeLessThan(events.findIndex((e) => e.type === "workspace_state" && e.state === "running"));
  });

  it("returns a failed start with the server's lastError, and the next start is accepted", async () => {
    const lastError = "the workspace did not become ready within 5 minutes";
    cloud.route("POST /v1/workspace/start", () => ({ status: 200, body: workspaceView({ state: "stopped", desired: "running" }) }));
    // After the controller gives up, the server keeps state failed and sets desired stopped.
    cloud.route("GET /v1/workspace", () => ({ status: 200, body: workspaceView({ state: "failed", desired: "stopped", lastError }) }));
    const { session } = createSession();
    const events = collect(session);
    await session.login("a@example.com", "right");
    await expect(session.startWorkspace()).resolves.toEqual({ state: "failed", error: lastError });
    expect(session.status().workspace).toEqual({ state: "failed", error: lastError });
    expect(events).toContainEqual({ type: "workspace_state", state: "failed", error: lastError });

    // The retry sets desired running. Until the controller acts, the old failure is shown as starting.
    cloud.route("GET /v1/workspace", () => ({ status: 200, body: workspaceView({ state: "failed", desired: "running", lastError }) }));
    const retry = session.startWorkspace();
    await waitFor(() => session.status().workspace.state === "starting");
    expect(session.status().workspace.error).toBeUndefined();
    cloud.route("GET /v1/workspace", () => ({ status: 200, body: workspaceView({ state: "running", desired: "running" }) }));
    await expect(retry).resolves.toEqual({ state: "running" });
  });

  it("sends keepalive with the access token", async () => {
    cloud.route("POST /v1/workspace/keepalive", () => ({ status: 204 }));
    const { session } = createSession();
    await session.login("a@example.com", "right");
    await session.keepalive();
    expect(cloud.pathRequests("/v1/workspace/keepalive")[0]?.authorization).toBe("Bearer a1");
  });

  it("opens the bridge socket with the bearer token", async () => {
    cloud.onSocket = (_path, socket) => socket.on("message", () => undefined);
    const { session } = createSession();
    await session.login("a@example.com", "right");
    const socket = await session.connectBridge();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(cloud.upgrades.find((upgrade) => upgrade.path === "/v1/workspace/bridge")?.authorization).toBe("Bearer a1");
    socket.close();
  });
});

describe("cloud session matches the platform API shapes", () => {
  it("maps the server view: queuePosition is the queue, lastError the failure, reclaimAt the idle warning", () => {
    expect(workspaceInfoFromView(workspaceView({ queuePosition: 3 }))).toEqual({ state: "queued", position: 3 });
    expect(workspaceInfoFromView(workspaceView({ state: "failed", lastError: "boom" }))).toEqual({ state: "failed", error: "boom" });
    expect(workspaceInfoFromView(workspaceView({ state: "failed", desired: "running", lastError: "boom" }))).toEqual({ state: "starting" });
    expect(workspaceInfoFromView(workspaceView({ state: "stopped", desired: "running" }))).toEqual({ state: "starting" });
    expect(workspaceInfoFromView(workspaceView({ state: "running", desired: "stopped" }))).toEqual({ state: "stopping" });
    expect(workspaceInfoFromView(workspaceView({ state: "running", desired: "running", reclaimAt: "2026-10-09T10:05:00.000Z" })))
      .toEqual({ state: "running", idleWarningAt: "2026-10-09T10:05:00.000Z" });
  });

  it("reads the queue and the failure from GET /v1/workspace", async () => {
    cloud.route("GET /v1/workspace", () => ({ status: 200, body: workspaceView({ queuePosition: 4 }) }));
    const { session } = createSession();
    await session.login("a@example.com", "right");
    await expect(session.refreshWorkspace()).resolves.toEqual({ state: "queued", position: 4 });

    cloud.route("GET /v1/workspace", () => ({ status: 200, body: workspaceView({ state: "failed", lastError: "pod crashed" }) }));
    await expect(session.refreshWorkspace()).resolves.toEqual({ state: "failed", error: "pod crashed" });
  });

  it("keeps the idle warning time from the server's reclaimAt", async () => {
    cloud.route("GET /v1/workspace", () => ({ status: 200, body: workspaceView({ state: "running", desired: "running", idleWarnedAt: "2026-10-09T10:00:00.000Z", reclaimAt: "2026-10-09T10:05:00.000Z" }) }));
    const { session } = createSession();
    await session.login("a@example.com", "right");
    expect((await session.refreshWorkspace()).idleWarningAt).toBe("2026-10-09T10:05:00.000Z");
  });

  it("rejects a project list that is not wrapped as {projects}", async () => {
    cloud.route("GET /v1/projects", () => ({ status: 200, body: [PROJECT] }));
    const { session } = createSession();
    await session.login("a@example.com", "right");
    await expect(session.listProjects()).rejects.toBeInstanceOf(CloudApiError);
  });

  it("sends the refresh token with a password change, and does not retry a rejected old password more than once", async () => {
    cloud.route("POST /v1/auth/password", () => ({ status: 401, body: { code: "invalid_credentials", message: "原密码错误" } }));
    const { session } = createSession();
    await session.login("a@example.com", "right");
    await expect(session.changePassword("wrong", "a brand new pass")).rejects.toMatchObject({ status: 401, code: "invalid_credentials", message: "原密码错误" });
    // One attempt, one refresh, one retry after the refresh. The retry carries the rotated refresh token.
    const attempts = cloud.pathRequests("/v1/auth/password");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.body?.refreshToken).toBe("r2");
    expect(cloud.pathRequests("/v1/auth/refresh")).toHaveLength(1);
    expect(session.status().signedIn).toBe(true);
  });

  it("reports a refused bridge with the server's code and message", async () => {
    cloud.upgradeReplies.set("/v1/workspace/bridge", { status: 409, body: { code: "workspace_not_running", message: "工作区未运行" } });
    const { session } = createSession();
    await session.login("a@example.com", "right");
    await expect(session.connectBridge()).rejects.toMatchObject({ status: 409, code: "workspace_not_running", message: "工作区未运行" });
  });
});

describe("cloud session events", () => {
  it("emits idle warnings and reclaim notices, and reconnects after the server drops the channel", async () => {
    cloud.onSocket = (path, socket, count) => {
      if (path !== "/v1/events") return;
      if (count === 1) {
        setTimeout(() => socket.close(), 30);
        return;
      }
      setTimeout(() => {
        socket.send(JSON.stringify({ type: "idle_warning", reclaimAt: "2026-10-09T10:05:00.000Z" }));
        socket.send(JSON.stringify({ type: "reclaimed" }));
      }, 20);
    };
    const { session } = createSession();
    const events = collect(session);
    await session.login("a@example.com", "right");

    await waitFor(() => events.some((event) => event.type === "reclaimed"));
    expect(events).toContainEqual({ type: "idle_warning", reclaimAt: "2026-10-09T10:05:00.000Z" });
    const connections = events.filter((event) => event.type === "events_connection" && event.connected);
    expect(connections.length).toBeGreaterThanOrEqual(2);
    expect(events).toContainEqual({ type: "events_connection", connected: false });
    expect(session.status().workspace.state).toBe("stopped");
    expect(session.status().eventsConnected).toBe(true);
  });

  it("applies workspace_state pushed by the server", async () => {
    cloud.onSocket = (path, socket) => {
      if (path === "/v1/events") setTimeout(() => socket.send(JSON.stringify({ type: "workspace_state", state: "running" })), 50);
    };
    const { session } = createSession();
    const events = collect(session);
    await session.login("a@example.com", "right");
    await waitFor(() => session.status().workspace.state === "running");
    expect(events).toContainEqual({ type: "workspace_state", state: "running" });
  });
});

describe("cloud token store", () => {
  it("writes only ciphertext and reads the session back through the cipher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reify-cloud-store-"));
    try {
      const cipher: SecretCipher = {
        isAvailable: () => true,
        encrypt: (text) => Buffer.from(`sealed:${Buffer.from(text).toString("base64")}`),
        decrypt: (data) => Buffer.from(data.toString("utf8").replace(/^sealed:/, ""), "base64").toString("utf8"),
      };
      const path = join(dir, "cloud-session.bin");
      const store = new EncryptedCloudSessionStore(path, cipher);
      const session: StoredCloudSession = { baseUrl: cloud.baseUrl, user: { id: "u1", email: "a@example.com", displayName: null }, accessToken: "a1", refreshToken: "r1", accessExpiresAt: 1 };
      await store.save(session);
      expect(await readFile(path, "utf8")).not.toContain("a@example.com");
      await expect(store.load()).resolves.toEqual(session);
      await store.clear();
      await expect(store.load()).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
