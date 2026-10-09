import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listWorkspaces, statusReport, stopWorkspaceByEmail } from '../src/admin.js';
import { bearer, makeEnv, post, signUp, type Env } from './helpers/env.js';

describe('reify-admin workspace commands (plan 10, 8.6)', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv({ maxActiveWorkspaces: 1 });
  });
  afterEach(async () => {
    await env.stop();
  });

  it('lists workspaces with their state and last activity', async () => {
    const a = await signUp(env, 'a@example.com');
    await signUp(env, 'b@example.com');
    await post(env, '/v1/workspace/start', {}, bearer(a.accessToken));
    const rows = await listWorkspaces(env.db);
    expect(rows.map((r) => r.email)).toEqual(['a@example.com', 'b@example.com']);
    expect(rows[0]).toMatchObject({ name: a.k8sName, state: 'stopped', desired: 'running' });
  });

  it('stop by email sets desired=stopped and removes the user from the queue', async () => {
    const a = await signUp(env, 'a@example.com');
    const b = await signUp(env, 'b@example.com');
    await post(env, '/v1/workspace/start', {}, bearer(a.accessToken));
    expect((await post(env, '/v1/workspace/start', {}, bearer(b.accessToken))).statusCode).toBe(409);

    // b is the queued one. Stopping it by email takes it out of the queue.
    await stopWorkspaceByEmail(env.db, env.clock.now(), 'b@example.com');
    const q = await env.db.query('select count(*)::int n from workspace_queue');
    expect(q.rows[0].n).toBe(0);
    expect((await env.db.query('select desired from workspaces where user_id = $1', [b.userId])).rows[0].desired).toBe('stopped');
    expect((await env.db.query('select desired from workspaces where user_id = $1', [a.userId])).rows[0].desired).toBe('running');
  });

  it('status counts workspaces by state, lists active ones, and counts error events from the last 24 hours', async () => {
    const a = await signUp(env, 'a@example.com');
    await signUp(env, 'b@example.com');
    await post(env, '/v1/workspace/start', {}, bearer(a.accessToken));
    await env.db.query(
      "insert into events (at, kind, detail) values ($1, 'error', '{}'), ($2, 'error', '{}')",
      [env.clock.now(), new Date(env.clock.now().getTime() - 30 * 60 * 60 * 1000)],
    );
    const s = await statusReport(env.db, env.clock.now());
    expect(s.countsByState).toEqual({ stopped: 2 });
    expect(s.active).toEqual([expect.objectContaining({ email: 'a@example.com', state: 'stopped' })]);
    expect(s.errorEventsLast24h).toBe(1);
    expect(s.queued).toBe(0);
  });
});
