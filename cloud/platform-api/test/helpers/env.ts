import { readFileSync } from 'node:fs';
import { generateKeyPair } from 'jose';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createInvite } from '../../src/admin.js';
import { DEFAULT_CONFIG, type Config } from '../../src/config.js';
import type { Clock, Keys } from '../../src/deps.js';
import { buildInternalApp } from '../../src/internal.js';
import { EventHub } from '../../src/workspace/events.js';
import type { WorkspaceDeps } from '../../src/workspace/ports.js';
import { FakeFs, FakeGateway, FakeK8s } from './fakes.js';
import { createTestDb, type TestDb } from './pg-cluster.js';

// The real template, so tests render what ships.
export const TEMPLATE = readFileSync(new URL('../../../deploy/k3s/workspace-template.yaml', import.meta.url), 'utf8');

export interface Env {
  t: TestDb;
  db: TestDb['db'];
  app: Awaited<ReturnType<typeof buildApp>>;
  internal: ReturnType<typeof buildInternalApp>;
  clock: Clock & { advance(ms: number): void };
  keys: Keys;
  config: Config;
  workspace: WorkspaceDeps;
  k8s: FakeK8s;
  gateway: FakeGateway;
  fs: FakeFs;
  events: EventHub;
  stop(): Promise<void>;
}

// Each call: fresh migrated database, ES256 keys, fake clock starting at T0, fake cluster, and an app bound to them.
export async function makeEnv(
  over: Partial<Config> = {},
  overWorkspace: Partial<WorkspaceDeps> = {},
): Promise<Env> {
  const t = await createTestDb(inject('pgAdminUrl'));
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  let now = new Date('2026-10-09T02:00:00Z').getTime();
  const clock = {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
  const config: Config = { ...DEFAULT_CONFIG, publicBaseUrl: 'https://test.example', downloadUrl: 'https://dl.example/setup.exe', ...over };
  const k8s = new FakeK8s();
  const gateway = new FakeGateway();
  const fs = new FakeFs();
  const events = new EventHub();
  const workspace: WorkspaceDeps = { k8s, gateway, fs, events, template: TEMPLATE, ...overWorkspace };
  const deps = { db: t.db, keys: { privateKey, publicKey }, clock, config };
  const app = buildApp({ ...deps, workspace });
  const internal = buildInternalApp(deps);
  await app.ready();
  await internal.ready();
  return {
    t,
    db: t.db,
    app,
    internal,
    clock,
    keys: { privateKey, publicKey },
    config,
    workspace,
    k8s,
    gateway,
    fs,
    events,
    stop: async () => {
      await app.close();
      await internal.close();
      await t.drop();
    },
  };
}

// Helpers for the HTTP surface. inject() returns a light-my-request response.
export const post = (env: Env, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'POST', url, payload: payload as object, headers });

export const get = (env: Env, url: string, headers: Record<string, string> = {}) => env.app.inject({ method: 'GET', url, headers });

export const patch = (env: Env, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'PATCH', url, payload: payload as object, headers });

export const del = (env: Env, url: string, headers: Record<string, string> = {}) => env.app.inject({ method: 'DELETE', url, headers });

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// Creates an invite through the admin function and returns its token.
export async function inviteToken(env: Env, opts: { email?: string; uses?: number; days?: number } = {}): Promise<string> {
  return (await createInvite(env.db, env.clock.now(), env.config.publicBaseUrl, opts)).token;
}

export const PASSWORD = 'correct horse battery';

// Registers and logs in a user through the public API. Returns ids and tokens.
export async function signUp(env: Env, email: string): Promise<{ userId: string; accessToken: string; refreshToken: string; k8sName: string }> {
  const token = await inviteToken(env, { uses: 5 });
  const reg = await post(env, '/v1/auth/register', { inviteToken: token, email, password: PASSWORD });
  if (reg.statusCode !== 201) throw new Error(`register failed: ${reg.body}`);
  const r = await post(env, '/v1/auth/login', { email, password: PASSWORD });
  const body = r.json();
  const ws = (await env.db.query('select k8s_name from workspaces where user_id = $1', [body.user.id])).rows[0];
  return { userId: body.user.id, accessToken: body.accessToken, refreshToken: body.refreshToken, k8sName: ws.k8s_name as string };
}
