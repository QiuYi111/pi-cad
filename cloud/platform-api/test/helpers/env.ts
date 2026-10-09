import { generateKeyPair } from 'jose';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createInvite } from '../../src/admin.js';
import { DEFAULT_CONFIG, type Config } from '../../src/config.js';
import type { Clock, Keys } from '../../src/deps.js';
import { createTestDb, type TestDb } from './pg-cluster.js';

export interface Env {
  t: TestDb;
  db: TestDb['db'];
  app: Awaited<ReturnType<typeof buildApp>>;
  clock: Clock & { advance(ms: number): void };
  keys: Keys;
  config: Config;
  stop(): Promise<void>;
}

// Each call: fresh migrated database, ES256 keys, fake clock starting at T0, and an app bound to them.
export async function makeEnv(over: Partial<Config> = {}): Promise<Env> {
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
  const app = buildApp({ db: t.db, keys: { privateKey, publicKey }, clock, config });
  await app.ready();
  return {
    t,
    db: t.db,
    app,
    clock,
    keys: { privateKey, publicKey },
    config,
    stop: async () => {
      await app.close();
      await t.drop();
    },
  };
}

// Helpers for the HTTP surface. inject() returns a light-my-request response.
export const post = (env: Env, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'POST', url, payload: payload as object, headers });

export const get = (env: Env, url: string, headers: Record<string, string> = {}) => env.app.inject({ method: 'GET', url, headers });

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// Creates an invite through the admin function and returns its token.
export async function inviteToken(env: Env, opts: { email?: string; uses?: number; days?: number } = {}): Promise<string> {
  return (await createInvite(env.db, env.clock.now(), env.config.publicBaseUrl, opts)).token;
}

export const PASSWORD = 'correct horse battery';
