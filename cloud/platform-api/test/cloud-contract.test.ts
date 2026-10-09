// Contract test: the desktop CloudSession (apps/desktop/electron/main/cloud-session.ts) drives the real platform API
// in this process, over real HTTP and WebSockets. The workspace gateway is a real one as well, so the bridge exec
// goes end to end. The server's shapes are the spec: a client that guessed a shape fails here.
//
// It lives in the platform API package, not the desktop one, because the Postgres cluster and the invite helpers are
// started by this package's global setup (test/global-setup.ts). CloudSession has no Electron import; the token store
// is an in-memory stand-in.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSPKI, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier, startGateway, type Gateway } from '../../workspace-gateway/src/index.js';
import { createController, type Controller } from '../src/workspace/controller.js';
import { createGatewayClient } from '../src/workspace/gateway.js';
import type { WorkspaceGateway } from '../src/workspace/ports.js';
import {
  CloudSession,
  describeLoginError,
  type CloudSessionStore,
  type StoredCloudSession,
} from '../../../apps/desktop/electron/main/cloud-session.js';
import { RemoteBridge } from '../../../apps/desktop/electron/main/remote-bridge.js';
import type { CloudEvent } from '../../../apps/desktop/src/shared/contracts.js';
import { inviteToken, makeEnv, PASSWORD, type Env } from './helpers/env.js';

const MIN = 60_000;
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const NEW_PASSWORD = 'a brand new passphrase';

type Api = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

function memoryStore(): CloudSessionStore & { value: StoredCloudSession | null } {
  const store = {
    value: null as StoredCloudSession | null,
    available: () => true,
    load: async () => store.value,
    save: async (session: StoredCloudSession) => {
      store.value = session;
    },
    clear: async () => {
      store.value = null;
    },
  };
  return store;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('desktop CloudSession against the real platform API', () => {
  let env: Env;
  let base: string;
  let root: string;
  let gateways: Gateway[] = [];
  let controller: Controller;
  // One real gateway per workspace, because each one only accepts tokens for its own workspace name.
  const clients = new Map<string, WorkspaceGateway>();
  let aliceK8s = '';
  let bobK8s = '';
  let logged: string[] = [];
  const sessions: CloudSession[] = [];

  let session: CloudSession;
  let store: ReturnType<typeof memoryStore>;
  let events: CloudEvent[] = [];

  // The workspace gateway used by the platform API. It forwards to the real gateway client for that workspace.
  const clientFor = (name: string): WorkspaceGateway => {
    const client = clients.get(name);
    if (!client) throw new Error(`no gateway for ${name}`);
    return client;
  };
  const forwarding: WorkspaceGateway = {
    healthz: (n) => clientFor(n).healthz(n),
    shutdown: (u, n) => clientFor(n).shutdown(u, n),
    exec: (u, n, a) => clientFor(n).exec(u, n, a),
    connect: (u, n) => clientFor(n).connect(u, n),
  };

  const tick = () => controller.tick();
  const api = async (method: string, path: string, token?: string, body?: unknown): Promise<Api> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const k8sNameOf = async (email: string): Promise<string> =>
    (await env.db.query<{ k8s_name: string }>('select w.k8s_name from workspaces w join users u on u.id = w.user_id where u.email = $1', [email])).rows[0]!.k8s_name;
  const workspaceRow = async (k8sName: string) =>
    (await env.db.query<{ state: string; desired: string }>('select state, desired from workspaces where k8s_name = $1', [k8sName])).rows[0]!;

  function newSession(): CloudSession {
    const s = new CloudSession({
      baseUrl: base,
      store,
      deviceLabel: 'contract-test',
      now: () => env.clock.now().getTime(),
      workspacePollMs: 5,
      reconnectInitialMs: 20,
      reconnectMaxMs: 100,
    });
    s.on((event) => events.push(event));
    sessions.push(s);
    return s;
  }

  async function register(email: string): Promise<void> {
    const inviteTokenValue = await inviteToken(env, { uses: 5 });
    const res = await api('POST', '/v1/auth/register', undefined, { inviteToken: inviteTokenValue, email, password: PASSWORD });
    expect(res.status).toBe(201);
  }

  beforeAll(async () => {
    env = await makeEnv({ maxActiveWorkspaces: 1 }, { gateway: forwarding });
    base = await env.app.listen({ port: 0, host: '127.0.0.1' });
    store = memoryStore();

    await register(ALICE);
    await register(BOB);
    aliceK8s = await k8sNameOf(ALICE);
    bobK8s = await k8sNameOf(BOB);

    root = await mkdtemp(join(tmpdir(), 'reify-contract-'));
    const pair = await generateKeyPair('ES256');
    const publicKeyPem = await exportSPKI(pair.publicKey);
    for (const name of [aliceK8s, bobK8s]) {
      const gateway = await startGateway({
        port: 0,
        workspaceRoot: root,
        readOnlyRoots: [],
        verifyToken: await createTokenVerifier({ publicKeyPem, workspaceName: name }),
        exit: () => {},
      });
      gateways.push(gateway);
      clients.set(name, createGatewayClient({ key: pair.privateKey, urlPattern: `ws://127.0.0.1:${gateway.port}/` }));
    }

    logged = [];
    controller = createController({ db: env.db, keys: env.keys, clock: env.clock, config: env.config, workspace: env.workspace }, (msg, err) =>
      logged.push(`${msg}: ${String(err)}`),
    );
    events = [];
    session = newSession();
  });

  afterAll(async () => {
    for (const s of sessions) s.close();
    for (const gateway of gateways) await gateway.close();
    await env?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('shows the lockout after repeated wrong passwords, with retryAfterSec, then clears after the window', async () => {
    for (let i = 0; i < 5; i++) {
      const error = await session.login(ALICE, 'wrong password!!').catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 401, code: 'invalid_credentials' });
      expect(describeLoginError(error)).toBe('邮箱或密码错误');
    }
    const locked = await session.login(ALICE, PASSWORD).catch((e: unknown) => e);
    expect(locked).toMatchObject({ status: 429, code: 'locked', retryAfterSec: 900 });
    expect(describeLoginError(locked)).toBe('尝试次数过多，已锁定。请 15 分钟后再试。');

    env.clock.advance(15 * MIN + 1000);
    expect(await session.login(ALICE, PASSWORD)).toMatchObject({ email: ALICE });
    expect(session.status()).toMatchObject({ signedIn: true, user: { email: ALICE } });
    await waitFor(() => session.status().eventsConnected, 'the events channel');
  });

  it('refreshes the access token before it expires, and keeps the new pair in the store', async () => {
    const before = store.value!;
    env.clock.advance(14 * MIN);
    expect(await session.listProjects()).toEqual([]);
    expect(store.value!.accessToken).not.toBe(before.accessToken);
    expect(store.value!.refreshToken).not.toBe(before.refreshToken);
  });

  it('creates, lists, renames and deletes projects in the server shape', async () => {
    const bracket = await session.createProject('Bracket');
    expect(bracket).toEqual({ id: expect.any(String), name: 'Bracket', role: 'maintainer', createdAt: expect.any(String) });
    const scratch = await session.createProject('Scratch');

    // Same created_at under the fake clock, so the server's order between them is not fixed.
    expect((await session.listProjects()).map((p) => p.name).sort()).toEqual(['Bracket', 'Scratch']);
    // The raw body the client reads: {projects:[...]} with role and createdAt on each entry.
    const rawList = await api('GET', '/v1/projects', store.value!.accessToken);
    expect(rawList.status).toBe(200);
    expect(Object.keys(rawList.body)).toEqual(['projects']);
    expect(rawList.body.projects).toEqual(expect.arrayContaining([
      { id: bracket.id, name: 'Bracket', role: 'maintainer', createdAt: expect.any(String) },
    ]));
    await expect(session.renameProject(bracket.id, 'Bracket v2')).resolves.toMatchObject({ id: bracket.id, name: 'Bracket v2', role: 'maintainer' });
    await session.deleteProject(scratch.id);
    expect(await session.listProjects()).toEqual([expect.objectContaining({ id: bracket.id, name: 'Bracket v2' })]);
    await expect(session.createProject('')).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
  });

  it('queues behind a full server with its position, then starts when the other workspace frees the slot', async () => {
    // Bob occupies the one slot: start, controller brings the pod up, the gateway answers, the workspace is running.
    const bobLogin = await api('POST', '/v1/auth/login', undefined, { email: BOB, password: PASSWORD });
    expect(bobLogin.status).toBe(200);
    expect((await api('POST', '/v1/workspace/start', bobLogin.body.accessToken)).status).toBe(200);
    await tick();
    env.k8s.setReady(bobK8s, true);
    await tick();
    expect(await workspaceRow(bobK8s)).toEqual({ state: 'running', desired: 'running' });

    const starting = session.startWorkspace();
    await waitFor(() => session.status().workspace.state === 'queued', 'queued');
    expect(session.status().workspace).toEqual({ state: 'queued', position: 1 });
    expect(events).toContainEqual({ type: 'workspace_state', state: 'queued', position: 1 });

    // The raw server answers: 409 capacity_full with the position, and a view with queuePosition (no "queued" state).
    const aliceLogin = await api('POST', '/v1/auth/login', undefined, { email: ALICE, password: PASSWORD });
    const full = await api('POST', '/v1/workspace/start', aliceLogin.body.accessToken);
    expect(full).toEqual({ status: 409, body: { code: 'capacity_full', message: expect.any(String), position: 1 } });
    const queued = await api('GET', '/v1/workspace', aliceLogin.body.accessToken);
    expect(Object.keys(queued.body).sort()).toEqual(
      ['desired', 'idleWarnedAt', 'lastActivityAt', 'lastError', 'name', 'queuePosition', 'reclaimAt', 'state'],
    );
    expect(queued.body).toMatchObject({ name: aliceK8s, state: 'stopped', desired: 'stopped', queuePosition: 1 });

    // Bob stops. The controller admits Alice from the queue in the same tick that bob's workspace leaves the slot.
    expect((await api('POST', '/v1/workspace/stop', bobLogin.body.accessToken)).body).toMatchObject({ desired: 'stopped' });
    await tick();
    await waitFor(() => session.status().workspace.state === 'starting', 'admission from the queue');
    expect(session.status().workspace.position).toBeUndefined();

    // Bob's pod is scaled down after the shutdown grace period.
    env.clock.advance(31_000);
    await tick();
    await tick();
    expect((await workspaceRow(bobK8s)).state).toBe('stopped');

    await tick();
    env.k8s.setReady(aliceK8s, true);
    await tick();
    expect(await starting).toMatchObject({ state: 'running' });
    expect(events).toContainEqual({ type: 'workspace_state', state: 'starting' });
    expect(events).toContainEqual({ type: 'workspace_state', state: 'running' });
  });

  it('runs exec through the bridge, reports the idle warning, takes keepalive, and reclaims the idle workspace', async () => {
    const bridge = new RemoteBridge({ connect: () => session.connectBridge(), projectId: () => undefined, workspaceRoot: root });
    const { stdout, stderr } = await bridge.exec(['echo', 'hi']);
    expect(stdout).toBe('hi\n');
    expect(stderr).toBe('');
    bridge.close();

    env.clock.advance(26 * MIN);
    await tick();
    await waitFor(() => events.some((e) => e.type === 'idle_warning'), 'the idle warning event');
    const warning = events.find((e): e is Extract<CloudEvent, { type: 'idle_warning' }> => e.type === 'idle_warning');
    expect(session.status().workspace.idleWarningAt).toBe(warning!.reclaimAt);
    // The read-back of the same warning, which also refreshes the access token (it is past its lead time).
    expect((await session.refreshWorkspace()).idleWarningAt).toBe(warning!.reclaimAt);

    await session.keepalive();
    expect(session.status().workspace.idleWarningAt).toBeUndefined();
    expect(await workspaceRow(aliceK8s)).toEqual({ state: 'running', desired: 'running' });

    env.clock.advance(31 * MIN);
    await tick();
    await waitFor(() => events.some((e) => e.type === 'reclaimed'), 'the reclaim event');
    expect(session.status().workspace.state).toBe('stopped');
  });

  it('refuses the bridge while the workspace is stopping, with the server code as the message', async () => {
    // The reclaim set desired=stopped; the controller moves the pod down on its next tick.
    await tick();
    await expect(session.connectBridge()).rejects.toMatchObject({ status: 409, code: 'workspace_not_running', message: '工作区未运行' });
    env.clock.advance(31_000);
    await tick();
    await tick();
    expect(await workspaceRow(aliceK8s)).toEqual({ state: 'stopped', desired: 'stopped' });
  });

  it('reports a failed start with the server lastError, and retries it', async () => {
    // The pod never becomes Ready within the 5-minute start timeout, so the controller marks the start failed.
    const failing = session.startWorkspace();
    await waitFor(() => session.status().workspace.state === 'starting', 'starting');
    await tick(); // pod created
    env.clock.advance(6 * MIN);
    await tick(); // start timeout

    const failedView = await api('GET', '/v1/workspace', store.value!.accessToken);
    expect(failedView.body).toMatchObject({ state: 'failed', desired: 'stopped', lastError: 'the workspace did not become ready within 5 minutes', queuePosition: null });

    const failed = await failing;
    expect(failed).toEqual({ state: 'failed', error: 'the workspace did not become ready within 5 minutes' });
    expect(session.status().workspace).toEqual({ state: 'failed', error: 'the workspace did not become ready within 5 minutes' });
    expect(events).toContainEqual({
      type: 'workspace_state',
      state: 'failed',
      error: 'the workspace did not become ready within 5 minutes',
    });

    // Retry: the start request is accepted, the controller starts the pod again, and it runs.
    const retry = session.startWorkspace();
    await waitFor(() => session.status().workspace.state === 'starting', 'retry starting');
    await tick();
    env.k8s.setReady(aliceK8s, true);
    await tick();
    expect(await retry).toMatchObject({ state: 'running' });
    expect(session.status().workspace.error).toBeUndefined();
  });

  it('changes the password, keeps this device signed in, and rejects a wrong old password without looping', async () => {
    await expect(session.changePassword('not the password', NEW_PASSWORD)).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
      message: '原密码错误',
    });
    expect(session.status().signedIn).toBe(true);

    await session.changePassword(PASSWORD, NEW_PASSWORD);
    // The refresh token was sent with the change, so this device's session survives the revocation of the others.
    env.clock.advance(14 * MIN);
    await expect(session.listProjects()).resolves.toHaveLength(1);
    expect(session.status().signedIn).toBe(true);
    expect((await api('POST', '/v1/auth/login', undefined, { email: ALICE, password: PASSWORD })).status).toBe(401);
  });

  it('logs out: the server revokes the refresh token and the local session is forgotten', async () => {
    const refreshToken = store.value!.refreshToken;
    await session.logout();
    expect(session.status().signedIn).toBe(false);
    expect(store.value).toBeNull();
    expect(events).toContainEqual({ type: 'session_ended', reason: 'signed_out' });
    expect((await api('POST', '/v1/auth/refresh', undefined, { refreshToken })).status).toBe(401);
    await expect(session.listProjects()).rejects.toThrow();
    expect(logged).toEqual([]);
  });
});
