import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newToken, sha256 } from '../src/crypto.js';
import { bearer, makeEnv, signUp, type Env } from './helpers/env.js';

describe('internal activity endpoint (plan 7.4)', () => {
  let env: Env;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let workspaceId: string;
  const activityToken = newToken(32); // what the controller would give the pod

  const post = (payload: unknown, auth: Record<string, string> = bearer(activityToken)) =>
    env.internal.inject({ method: 'POST', url: `/internal/workspaces/${workspaceId}/activity`, payload: payload as object, headers: auth });

  beforeEach(async () => {
    env = await makeEnv();
    alice = await signUp(env, 'alice@example.com');
    workspaceId = (await env.db.query('select id from workspaces where user_id = $1', [alice.userId])).rows[0].id;
    await env.db.query('update workspaces set activity_token_hash = $2, idle_warned_at = $3, last_activity_at = null where id = $1', [
      workspaceId,
      sha256(activityToken),
      env.clock.now(),
    ]);
  });
  afterEach(async () => {
    await env.stop();
  });

  it('rejects a missing, wrong or unknown-workspace token with 401', async () => {
    expect((await post({ active: true, reason: 'x' }, {})).statusCode).toBe(401);
    expect((await post({ active: true, reason: 'x' }, bearer(newToken(32)))).statusCode).toBe(401);
    // The user's access token is not a workspace token.
    expect((await post({ active: true, reason: 'x' }, bearer(alice.accessToken))).statusCode).toBe(401);
    const unknown = await env.internal.inject({
      method: 'POST',
      url: '/internal/workspaces/00000000-0000-4000-8000-000000000000/activity',
      payload: { active: true, reason: 'x' },
      headers: bearer(activityToken),
    });
    expect(unknown.statusCode).toBe(401);
    expect((await env.db.query('select last_activity_at from workspaces where id = $1', [workspaceId])).rows[0].last_activity_at).toBeNull();
  });

  it('when active: sets last_activity_at to now and clears idle_warned_at', async () => {
    env.clock.advance(60_000);
    const r = await post({ active: true, reason: 'prime-turn' });
    expect(r.statusCode).toBe(204);
    const w = (await env.db.query('select last_activity_at, idle_warned_at from workspaces where id = $1', [workspaceId])).rows[0];
    expect(w.last_activity_at).toEqual(env.clock.now());
    expect(w.idle_warned_at).toBeNull();
  });

  it('when inactive: changes nothing', async () => {
    expect((await post({ active: false, reason: 'idle' })).statusCode).toBe(204);
    const w = (await env.db.query('select last_activity_at, idle_warned_at from workspaces where id = $1', [workspaceId])).rows[0];
    expect(w.last_activity_at).toBeNull();
    expect(w.idle_warned_at).not.toBeNull();
  });

  it('rejects a body without a boolean active with 400', async () => {
    expect((await post({ active: 'yes' })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
  });

  it('is not served on the public port: the public app answers 404', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: `/internal/workspaces/${workspaceId}/activity`,
      payload: { active: true, reason: 'x' },
      headers: bearer(activityToken),
    });
    expect(r.statusCode).toBe(404);
    expect((await env.db.query('select last_activity_at from workspaces where id = $1', [workspaceId])).rows[0].last_activity_at).toBeNull();
  });
});
