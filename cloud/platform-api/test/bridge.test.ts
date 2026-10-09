// Bridge proxy end to end: a real workspace gateway runs in this process, and the platform API talks to it
// over a real WebSocket with a gateway token it signed. Nothing is mocked on the gateway side.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSPKI, generateKeyPair } from 'jose';
import { WebSocket, type RawData } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTokenVerifier, startGateway, type Gateway } from '../../workspace-gateway/src/index.js';
import { encodeFrame, decodeFrame } from '../../protocol/src/index.js';
import { createGatewayClient } from '../src/workspace/gateway.js';
import type { WorkspaceGateway } from '../src/workspace/ports.js';
import { makeEnv, signUp, type Env } from './helpers/env.js';

type Msg = Record<string, unknown>;

class Client {
  readonly texts: Msg[] = [];
  readonly binaries: Array<{ ch: number; data: string }> = [];
  private waiters: Array<() => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const f = decodeFrame(data as Buffer);
        this.binaries.push({ ch: f.ch, data: Buffer.from(f.data).toString('utf8') });
      } else {
        this.texts.push(JSON.parse(data.toString()) as Msg);
      }
      this.waiters.forEach((w) => w());
      this.waiters = [];
    });
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  async until<T>(check: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = check();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }

  text(type: string, ch?: number) {
    return this.until(() => this.texts.find((m) => m.type === type && (ch === undefined || m.ch === ch)), type);
  }

  bytes(ch: number, includes: string) {
    return this.until(() => this.binaries.find((b) => b.ch === ch && b.data.includes(includes)), `bytes on ${ch}`);
  }

  close() {
    this.ws.close();
  }
}

describe('bridge proxy to a real gateway (plan 5.3, 7.2)', () => {
  let env: Env;
  let gateway: Gateway;
  let root: string;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let base: string; // ws://127.0.0.1:<port>
  const clients: Client[] = [];

  // The env is built before the gateway (the gateway's token check needs the workspace name), so the
  // workspace gateway is a stand-in that forwards to the real client once it is set.
  let real: WorkspaceGateway | undefined;
  const forwarding: WorkspaceGateway = {
    healthz: (n) => real!.healthz(n),
    shutdown: (u, n) => real!.shutdown(u, n),
    exec: (u, n, a) => real!.exec(u, n, a),
    connect: (u, n) => real!.connect(u, n),
  };

  async function open(token?: string, path = '/v1/workspace/bridge'): Promise<Client> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
      s.once('open', () => resolve(s));
      s.once('unexpected-response', (_req, res) => {
        s.terminate();
        reject(new Error(`HTTP ${res.statusCode}`));
      });
      s.once('error', reject);
    });
    const c = new Client(ws);
    clients.push(c);
    return c;
  }

  const setWorkspace = (sql: string, params: unknown[]) => env.db.query(sql, params);

  beforeEach(async () => {
    env = await makeEnv({}, { gateway: forwarding });
    alice = await signUp(env, 'bridge@example.com');

    root = await mkdtemp(join(tmpdir(), 'reify-bridge-'));
    const pair = await generateKeyPair('ES256');
    gateway = await startGateway({
      port: 0,
      workspaceRoot: root,
      readOnlyRoots: [],
      verifyToken: await createTokenVerifier({ publicKeyPem: await exportSPKI(pair.publicKey), workspaceName: alice.k8sName }),
      exit: () => {},
    });
    real = createGatewayClient({ key: pair.privateKey, urlPattern: `ws://127.0.0.1:${gateway.port}/` });

    base = (await env.app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws');
    await setWorkspace("update workspaces set state = 'running', desired = 'running', last_activity_at = null where user_id = $1", [alice.userId]);
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await gateway.close();
    await env.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('pushes workspace state and idle and reclaim events to /v1/events, with the token in the header', async () => {
    await expect(open(undefined, '/v1/events')).rejects.toThrow('HTTP 401');
    const ev = await open(alice.accessToken, '/v1/events');
    await ev.text('workspace_state');
    expect(ev.texts).toEqual([{ type: 'workspace_state', state: 'running' }]);

    env.events.idleWarning(alice.userId, new Date('2026-10-09T02:30:00Z'));
    env.events.reclaimed(alice.userId);
    await ev.until(() => (ev.texts.length === 3 ? true : undefined), 'idle and reclaim events');
    expect(ev.texts.slice(1)).toEqual([
      { type: 'idle_warning', reclaimAt: '2026-10-09T02:30:00.000Z' },
      { type: 'reclaimed' },
    ]);
  });

  it('requires an access token (the desktop sends it in the Authorization header)', async () => {
    await expect(open()).rejects.toThrow('HTTP 401');
    await expect(open('not-a-token')).rejects.toThrow('HTTP 401');
  });

  it('refuses the bridge while the workspace is not running', async () => {
    await setWorkspace("update workspaces set state = 'starting' where user_id = $1", [alice.userId]);
    await expect(open(alice.accessToken)).rejects.toThrow('HTTP 409');
  });

  it('runs exec through the proxy: echo hi comes back from the gateway', async () => {
    const c = await open(alice.accessToken);
    c.send({ type: 'exec', ch: 1, args: ['echo', 'hi'] });
    expect(await c.text('exec_result', 1)).toMatchObject({ stdout: 'hi\n', code: 0 });
  });

  it('carries binary frames both ways (spawn cat, write stdin, read stdout)', async () => {
    const c = await open(alice.accessToken);
    c.send({ type: 'spawn', ch: 2, args: ['cat'] });
    await c.text('spawned', 2);
    c.ws.send(encodeFrame(2, Buffer.from('through the bridge\n')));
    await c.bytes(2, 'through the bridge\n');
  });

  it('counts bridge traffic as activity, at most once per 30 s', async () => {
    const t0 = env.clock.now();
    const c = await open(alice.accessToken);
    const lastActivity = async () =>
      (await env.db.query('select last_activity_at from workspaces where user_id = $1', [alice.userId])).rows[0].last_activity_at as Date | null;
    // The connect itself counts. The write is fire-and-forget, so wait for it.
    for (let i = 0; i < 200 && (await lastActivity()) === null; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await lastActivity()).toEqual(t0);

    env.clock.advance(10_000);
    c.send({ type: 'ping' });
    await c.text('pong');
    expect(await lastActivity()).toEqual(t0); // within the 30 s window

    env.clock.advance(25_000);
    c.send({ type: 'ping' });
    await c.text('pong');
    // The write is fire-and-forget on the proxy side, so wait for it.
    for (let i = 0; i < 200 && (await lastActivity())?.getTime() !== env.clock.now().getTime(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await lastActivity()).toEqual(env.clock.now());
  });
});
