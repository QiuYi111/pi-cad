import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearer, get, makeEnv, post, signUp, type Env } from './helpers/env.js';

describe('workspace API (plan 5.3)', () => {
  let env: Env;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await env.stop();
  });

  it('requires a valid access token', async () => {
    expect((await get(env, '/v1/workspace')).statusCode).toBe(401);
    expect((await post(env, '/v1/workspace/start', {})).statusCode).toBe(401);
  });

  it('shows a stopped workspace, starts it (idempotent), stops it, and keeps the same name', async () => {
    const alice = await signUp(env, 'alice@example.com');
    const view = (await get(env, '/v1/workspace', bearer(alice.accessToken))).json();
    expect(view).toMatchObject({ name: alice.k8sName, state: 'stopped', desired: 'stopped', queuePosition: null });

    const started = await post(env, '/v1/workspace/start', {}, bearer(alice.accessToken));
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ desired: 'running', state: 'stopped', lastActivityAt: env.clock.now().toISOString() });
    expect((await post(env, '/v1/workspace/start', {}, bearer(alice.accessToken))).json().desired).toBe('running');

    const stopped = await post(env, '/v1/workspace/stop', {}, bearer(alice.accessToken));
    expect(stopped.json()).toMatchObject({ desired: 'stopped', queuePosition: null });
  });

  it('answers 409 capacity_full with a queue position above 6 active workspaces, and queues each request once', async () => {
    const users = [];
    for (let i = 0; i < 8; i++) users.push(await signUp(env, `user${i}@example.com`));

    for (const u of users.slice(0, 6)) {
      expect((await post(env, '/v1/workspace/start', {}, bearer(u.accessToken))).statusCode).toBe(200);
    }
    const seventh = await post(env, '/v1/workspace/start', {}, bearer(users[6].accessToken));
    expect(seventh.statusCode).toBe(409);
    expect(seventh.json()).toMatchObject({ code: 'capacity_full', position: 1 });

    const eighth = await post(env, '/v1/workspace/start', {}, bearer(users[7].accessToken));
    expect(eighth.json()).toMatchObject({ code: 'capacity_full', position: 2 });

    // Asking again keeps the same place.
    const again = await post(env, '/v1/workspace/start', {}, bearer(users[7].accessToken));
    expect(again.json()).toMatchObject({ code: 'capacity_full', position: 2 });
    expect((await get(env, '/v1/workspace', bearer(users[7].accessToken))).json().queuePosition).toBe(2);
    expect((await env.db.query('select count(*)::int n from workspace_queue')).rows[0].n).toBe(2);
  });

  it('does not admit a new request while others are queued, even with a free slot', async () => {
    const users = [];
    for (let i = 0; i < 7; i++) users.push(await signUp(env, `q${i}@example.com`));
    for (const u of users.slice(0, 6)) await post(env, '/v1/workspace/start', {}, bearer(u.accessToken));
    expect((await post(env, '/v1/workspace/start', {}, bearer(users[6].accessToken))).statusCode).toBe(409);

    // A stop frees a slot, but the queue admits people, not the free slot. u0 cannot jump ahead of u6.
    await post(env, '/v1/workspace/stop', {}, bearer(users[0].accessToken));
    expect((await post(env, '/v1/workspace/start', {}, bearer(users[0].accessToken))).json()).toMatchObject({ code: 'capacity_full', position: 2 });
    expect((await get(env, '/v1/workspace', bearer(users[6].accessToken))).json().queuePosition).toBe(1);
  });

  it('a stop removes the user from the queue', async () => {
    const users = [];
    for (let i = 0; i < 7; i++) users.push(await signUp(env, `s${i}@example.com`));
    for (const u of users.slice(0, 6)) await post(env, '/v1/workspace/start', {}, bearer(u.accessToken));
    await post(env, '/v1/workspace/start', {}, bearer(users[6].accessToken));
    const stopped = await post(env, '/v1/workspace/stop', {}, bearer(users[6].accessToken));
    expect(stopped.json()).toMatchObject({ desired: 'stopped', queuePosition: null });
    expect((await env.db.query('select count(*)::int n from workspace_queue')).rows[0].n).toBe(0);
  });

  it('keepalive sets last_activity_at to now and clears the idle warning', async () => {
    const alice = await signUp(env, 'keep@example.com');
    await post(env, '/v1/workspace/start', {}, bearer(alice.accessToken));
    env.clock.advance(60_000);
    await env.db.query('update workspaces set idle_warned_at = $2 where user_id = $1', [alice.userId, env.clock.now()]);
    const r = await post(env, '/v1/workspace/keepalive', {}, bearer(alice.accessToken));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ lastActivityAt: env.clock.now().toISOString(), idleWarnedAt: null, reclaimAt: null });
  });

  it('a disabled user cannot reach the workspace API', async () => {
    const alice = await signUp(env, 'gone@example.com');
    await env.db.query("update users set status = 'disabled' where id = $1", [alice.userId]);
    expect((await get(env, '/v1/workspace', bearer(alice.accessToken))).statusCode).toBe(401);
  });
});
