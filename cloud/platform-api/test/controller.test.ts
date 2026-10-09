import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/crypto.js';
import { createController } from '../src/workspace/controller.js';
import type { UserEvent } from '../../protocol/src/index.js';
import { bearer, get, makeEnv, PASSWORD, post, signUp, type Env } from './helpers/env.js';

const SEC = 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type SignedUp = Awaited<ReturnType<typeof signUp>>;

describe('workspace controller (plan 5.4)', () => {
  let env: Env;
  let logged: string[];
  let alice: SignedUp;
  let seen: UserEvent[];

  // One controller per environment, as in the server. It remembers which shutdowns it has sent.
  const controllers = new WeakMap<Env, ReturnType<typeof createController>>();
  const controllerFor = (e: Env) => {
    let c = controllers.get(e);
    if (!c) {
      c = createController({ db: e.db, keys: e.keys, clock: e.clock, config: e.config, workspace: e.workspace }, (msg, err) =>
        logged.push(`${msg}: ${String(err)}`),
      );
      controllers.set(e, c);
    }
    return c;
  };
  const tick = (e: Env = env) => controllerFor(e).tick();
  const rowOf = async (userId: string, e: Env = env) => (await e.db.query('select * from workspaces where user_id = $1', [userId])).rows[0];
  const startAs = (u: SignedUp, e: Env = env) => post(e, '/v1/workspace/start', {}, bearer(u.accessToken));
  const stopAs = (u: SignedUp, e: Env = env) => post(e, '/v1/workspace/stop', {}, bearer(u.accessToken));
  const kinds = async (userId: string, e: Env = env) =>
    (await e.db.query('select kind from events where user_id = $1 or workspace_id = (select id from workspaces where user_id = $1) order by id', [userId])).rows.map(
      (r) => r.kind as string,
    );
  const makeReady = (u: SignedUp, e: Env = env) => {
    e.k8s.setReady(u.k8sName, true);
    e.gateway.healthy.add(u.k8sName);
  };

  beforeEach(async () => {
    env = await makeEnv();
    logged = [];
    alice = await signUp(env, 'alice@example.com');
    seen = [];
    env.events.subscribe(alice.userId, (e) => seen.push(e));
  });

  afterEach(async () => {
    expect(logged).toEqual([]);
    await env.stop();
  });

  it('rule 1: desired running with no pod creates the PVC, Deployment and Service, state starting', async () => {
    const project = await post(env, '/v1/projects', { name: 'Bracket' }, bearer(alice.accessToken));
    expect(project.statusCode).toBe(201);
    await startAs(alice);
    await tick();

    expect((await rowOf(alice.userId)).state).toBe('starting');
    expect(env.k8s.applied).toEqual([`PersistentVolumeClaim/${alice.k8sName}-data`, `Deployment/${alice.k8sName}`, `Service/${alice.k8sName}`]);
    const dep = env.k8s.deployments.get(alice.k8sName)!;
    expect(dep.replicas).toBe(1);

    const env0 = env.k8s.env(alice.k8sName);
    expect(env0.REIFY_WORKSPACE_NAME).toBe(alice.k8sName);
    expect(env0.REIFY_PROJECT_IDS).toBe(project.json().id);
    expect(env0.REIFY_ACTIVITY_URL).toBe(`${env.config.platformInternalUrl}/internal/workspaces/${(await rowOf(alice.userId)).id}/activity`);
    // The pod gets the plaintext token. The database keeps only its hash.
    const stored = (await rowOf(alice.userId)).activity_token_hash as Buffer;
    expect(sha256(env0.REIFY_ACTIVITY_TOKEN).equals(stored)).toBe(true);
    expect(seen).toEqual([{ type: 'workspace_state', state: 'starting' }]);
    expect(await kinds(alice.userId)).toContain('ws_start');
  });

  it('rule 2: a Ready pod whose gateway answers /healthz becomes running; the project folders are created', async () => {
    const project = (await post(env, '/v1/projects', { name: 'Bracket' }, bearer(alice.accessToken))).json();
    await startAs(alice);
    await tick();

    env.k8s.setReady(alice.k8sName, true); // Ready, but no gateway answer yet
    await tick();
    expect((await rowOf(alice.userId)).state).toBe('starting');

    env.gateway.healthy.add(alice.k8sName);
    await tick();
    expect((await rowOf(alice.userId)).state).toBe('running');
    expect(seen.at(-1)).toEqual({ type: 'workspace_state', state: 'running' });
    expect(env.fs.mkdirs).toEqual([{ name: alice.k8sName, ids: [project.id] }]);
  });

  it('rule 3: stop sends shutdown once, waits for the gateway, and scales to 0 after 30 s', async () => {
    await startAs(alice);
    await tick();
    makeReady(alice);
    await tick();

    await stopAs(alice);
    await tick();
    expect(env.gateway.shutdowns).toEqual([alice.k8sName]);
    expect((await rowOf(alice.userId)).state).toBe('stopping');
    expect(env.k8s.deployments.get(alice.k8sName)!.replicas).toBe(1);

    env.clock.advance(10 * SEC);
    await tick();
    expect(env.gateway.shutdowns).toHaveLength(1); // not repeated
    expect(env.k8s.deployments.get(alice.k8sName)!.replicas).toBe(1); // gateway still answers, so Prime may still be saving

    env.clock.advance(21 * SEC); // 31 s since stopping began
    await tick();
    expect(env.k8s.deployments.get(alice.k8sName)!.replicas).toBe(0);
    await tick();
    expect((await rowOf(alice.userId)).state).toBe('stopped');
    expect(await kinds(alice.userId)).toContain('ws_stop');
    expect(seen.at(-1)).toEqual({ type: 'workspace_state', state: 'stopped' });
  });

  it('rule 3: when the gateway is already gone, scales to 0 without waiting', async () => {
    await startAs(alice);
    await tick();
    makeReady(alice);
    await tick();
    await stopAs(alice);
    await tick();
    env.gateway.healthy.delete(alice.k8sName); // gateway exited after shutdown
    env.k8s.setReady(alice.k8sName, false);
    await tick();
    expect(env.k8s.deployments.get(alice.k8sName)!.replicas).toBe(0);
  });

  it('rule 4: starting for more than 5 minutes becomes failed with last_error and an error event', async () => {
    await startAs(alice);
    await tick();
    env.clock.advance(5 * MIN);
    await tick();
    expect((await rowOf(alice.userId)).state).toBe('starting'); // exactly 5 minutes is not over the limit

    env.clock.advance(SEC);
    await tick();
    const w = await rowOf(alice.userId);
    expect(w).toMatchObject({ state: 'failed', desired: 'stopped' });
    expect(w.last_error).toContain('5 minutes');
    expect(env.k8s.deployments.get(alice.k8sName)!.replicas).toBe(0);
    const err = (await env.db.query("select detail from events where kind = 'error'")).rows;
    expect(err).toHaveLength(1);
    expect(err[0].detail).toMatchObject({ reason: 'start_timeout' });
  });

  it('rule 5: after 25 min idle the user gets an idle warning once; after 30 min the workspace is reclaimed', async () => {
    const started = env.clock.now();
    await startAs(alice);
    await tick();
    makeReady(alice);
    await tick();
    expect((await rowOf(alice.userId)).state).toBe('running');

    env.clock.advance(25 * MIN + SEC);
    await tick();
    const warned = await rowOf(alice.userId);
    expect(warned.idle_warned_at).not.toBeNull();
    const reclaimAt = new Date(started.getTime() + 30 * MIN).toISOString();
    expect(seen.filter((e) => e.type === 'idle_warning')).toEqual([{ type: 'idle_warning', reclaimAt }]);

    await tick(); // no second warning
    expect(seen.filter((e) => e.type === 'idle_warning')).toHaveLength(1);

    env.clock.advance(5 * MIN);
    await tick();
    expect((await rowOf(alice.userId)).desired).toBe('stopped');
    expect(seen.at(-1)).toEqual({ type: 'reclaimed' });
    expect(await kinds(alice.userId)).toEqual(expect.arrayContaining(['ws_idle_warn', 'ws_reclaim']));

    // The reclaim then goes through the normal stop path: shutdown, then scale to 0.
    await tick();
    expect(env.gateway.shutdowns).toEqual([alice.k8sName]);
    env.clock.advance(31 * SEC);
    await tick();
    await tick();
    expect((await rowOf(alice.userId)).state).toBe('stopped');
  });

  it('keepalive clears the idle warning and pushes the reclaim time out', async () => {
    await startAs(alice);
    await tick();
    makeReady(alice);
    await tick();

    env.clock.advance(26 * MIN);
    await tick();
    expect((await rowOf(alice.userId)).idle_warned_at).not.toBeNull();

    // The access token lives 15 minutes and the clock has moved 26, so log in again.
    const fresh = (await post(env, '/v1/auth/login', { email: 'alice@example.com', password: PASSWORD })).json().accessToken as string;
    const k = await post(env, '/v1/workspace/keepalive', {}, bearer(fresh));
    expect(k.statusCode).toBe(200);
    expect(k.json()).toMatchObject({ state: 'running', idleWarnedAt: null, reclaimAt: null });

    env.clock.advance(20 * MIN); // 46 min after start, but only 20 min after keepalive
    await tick();
    expect((await rowOf(alice.userId)).desired).toBe('running');
    expect(seen.filter((e) => e.type === 'reclaimed')).toHaveLength(0);
    expect(seen.filter((e) => e.type === 'idle_warning')).toHaveLength(1);

    env.clock.advance(6 * MIN); // 26 min after keepalive: warned again
    await tick();
    expect(seen.filter((e) => e.type === 'idle_warning')).toHaveLength(2);
  });

  it('a pod that stops being Ready while running goes back to starting', async () => {
    await startAs(alice);
    await tick();
    makeReady(alice);
    await tick();
    env.k8s.setReady(alice.k8sName, false);
    await tick();
    expect((await rowOf(alice.userId)).state).toBe('starting');
    expect(env.k8s.deployments.get(alice.k8sName)!.replicas).toBe(1); // pod restarts, no re-render needed
  });

  it('admits queued workspaces in order when a slot frees, and a queued user cannot jump the queue', async () => {
    const small = await makeEnv({ maxActiveWorkspaces: 2 });
    try {
      const users = [await signUp(small, 'u1@example.com'), await signUp(small, 'u2@example.com'), await signUp(small, 'u3@example.com'), await signUp(small, 'u4@example.com')];
      expect((await startAs(users[0], small)).statusCode).toBe(200);
      expect((await startAs(users[1], small)).statusCode).toBe(200);
      expect((await startAs(users[2], small)).statusCode).toBe(409);
      expect((await startAs(users[3], small)).statusCode).toBe(409);

      // Freeing a slot admits the head of the queue (u3) on the next tick.
      await stopAs(users[0], small);
      await tick(small);
      expect((await rowOf(users[2].userId, small)).desired).toBe('running');
      expect((await rowOf(users[3].userId, small)).desired).toBe('stopped');
      const pos = await get(small, '/v1/workspace', bearer(users[3].accessToken));
      expect(pos.json().queuePosition).toBe(1);

      // u2 stops too. u4 is admitted now.
      await stopAs(users[1], small);
      await tick(small);
      expect((await rowOf(users[3].userId, small)).desired).toBe('running');
      expect((await get(small, '/v1/workspace', bearer(users[3].accessToken))).json().queuePosition).toBeNull();
      expect(logged).toEqual([]);
    } finally {
      await small.stop();
    }
  });

  it('a workspace that became ready with no gateway answer stays starting', async () => {
    await startAs(alice);
    await tick();
    env.k8s.setReady(alice.k8sName, true);
    await tick();
    expect((await rowOf(alice.userId)).state).toBe('starting');
    expect(env.gateway.shutdowns).toEqual([]);
    expect((await post(env, '/v1/workspace/stop', {}, bearer(alice.accessToken))).statusCode).toBe(200);
  });

  it('a reconcile error is written to last_error, shown to the user, and cleared by the next clean pass', async () => {
    await startAs(alice);
    await tick();
    env.k8s.fail = true;
    await tick();
    expect((await rowOf(alice.userId)).last_error).toBe('fake k8s failure');
    expect((await get(env, '/v1/workspace', bearer(alice.accessToken))).json().lastError).toBe('fake k8s failure');
    expect(logged.some((l) => l.includes(`reconcile ${alice.k8sName}`))).toBe(true);
    logged.length = 0; // expected, checked above

    env.k8s.fail = false;
    await tick();
    expect((await rowOf(alice.userId)).last_error).toBeNull();
  });

  it('a start timeout keeps its reason on later ticks, even after an earlier reconcile error', async () => {
    await startAs(alice);
    await tick();
    env.k8s.fail = true;
    await tick(); // leaves last_error set
    env.k8s.fail = false;
    logged.length = 0; // expected, checked above

    env.clock.advance(5 * MIN + SEC);
    await tick();
    expect(await rowOf(alice.userId)).toMatchObject({ state: 'failed', desired: 'stopped' });
    expect((await rowOf(alice.userId)).last_error).toContain('5 minutes');
    await tick();
    expect((await rowOf(alice.userId)).last_error).toContain('5 minutes');
  });

  it('daily: a running workspace purges .trash entries older than 30 days, at most once a day', async () => {
    // Idle timers are pushed out of reach so the workspace stays running for two days.
    const e = await makeEnv({ idleWarnMs: 1000 * DAY, idleReclaimMs: 1000 * DAY });
    try {
      const u = await signUp(e, 'trash@example.com');
      e.fs.purged = 2;
      await startAs(u, e);
      await tick(e);
      makeReady(u, e);
      await tick(e);
      expect(e.fs.purges).toEqual([{ name: u.k8sName, cutoff: new Date(e.clock.now().getTime() - 30 * DAY) }]);

      await tick(e);
      expect(e.fs.purges).toHaveLength(1);
      e.clock.advance(23 * HOUR);
      await tick(e);
      expect(e.fs.purges).toHaveLength(1);
      e.clock.advance(HOUR);
      await tick(e);
      expect(e.fs.purges).toHaveLength(2);
      expect(logged).toEqual([]);
    } finally {
      await e.stop();
    }
  });

  it('a stopped workspace is not swept', async () => {
    await tick();
    expect((await rowOf(alice.userId)).state).toBe('stopped');
    expect(env.fs.purges).toEqual([]);
  });
});
