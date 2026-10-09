import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createController } from '../src/workspace/controller.js';
import { bearer, del, get, makeEnv, patch, post, signUp, type Env } from './helpers/env.js';

type SignedUp = Awaited<ReturnType<typeof signUp>>;

describe('projects (plan 5.2)', () => {
  let env: Env;
  let alice: SignedUp;
  let bob: SignedUp;

  const create = (u: SignedUp, name: string) => post(env, '/v1/projects', { name }, bearer(u.accessToken));
  const list = async (u: SignedUp) => (await get(env, '/v1/projects', bearer(u.accessToken))).json().projects as Array<{ id: string; name: string; role: string }>;
  const setState = (u: SignedUp, state: string) => env.db.query('update workspaces set state = $2 where user_id = $1', [u.userId, state]);

  beforeEach(async () => {
    env = await makeEnv();
    alice = await signUp(env, 'alice@example.com');
    bob = await signUp(env, 'bob@example.com');
  });
  afterEach(async () => {
    await env.stop();
  });

  it('requires a valid access token', async () => {
    expect((await get(env, '/v1/projects')).statusCode).toBe(401);
    expect((await post(env, '/v1/projects', { name: 'x' })).statusCode).toBe(401);
  });

  it('creates a project as maintainer and lists it with the role', async () => {
    const r = await create(alice, '  Bracket  ');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'Bracket', role: 'maintainer' });
    expect(await list(alice)).toEqual([expect.objectContaining({ id: r.json().id, name: 'Bracket', role: 'maintainer' })]);
    expect(await list(bob)).toEqual([]);
  });

  it('rejects an empty or too long name', async () => {
    expect((await create(alice, '   ')).json()).toMatchObject({ code: 'invalid_input' });
    expect((await create(alice, 'x'.repeat(101))).statusCode).toBe(400);
    expect((await post(env, '/v1/projects', { name: 5 }, bearer(alice.accessToken))).statusCode).toBe(400);
  });

  it('does not touch the filesystem while the workspace is stopped', async () => {
    await create(alice, 'Quiet');
    expect(env.fs.mkdirs).toEqual([]);
  });

  it('creates the project folders through the gateway while the workspace is running', async () => {
    await setState(alice, 'running');
    const id = (await create(alice, 'Live')).json().id;
    expect(env.fs.mkdirs).toEqual([{ name: alice.k8sName, ids: [id] }]);
  });

  it('still creates the project when the filesystem step fails (the entrypoint creates it at next start)', async () => {
    await setState(alice, 'running');
    env.fs.fail = true;
    expect((await create(alice, 'Resilient')).statusCode).toBe(201);
  });

  it('renames as maintainer; editors and viewers get 403; strangers get 404', async () => {
    const id = (await create(alice, 'Old')).json().id;
    const ok = await patch(env, `/v1/projects/${id}`, { name: 'New' }, bearer(alice.accessToken));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, name: 'New', role: 'maintainer' });

    await env.db.query("insert into project_members (project_id, user_id, role) values ($1, $2, 'editor')", [id, bob.userId]);
    expect((await patch(env, `/v1/projects/${id}`, { name: 'Hijack' }, bearer(bob.accessToken))).statusCode).toBe(403);
    expect((await list(bob)).find((p) => p.id === id)?.role).toBe('editor');

    const carol = await signUp(env, 'carol@example.com');
    expect((await patch(env, `/v1/projects/${id}`, { name: 'Nope' }, bearer(carol.accessToken))).statusCode).toBe(404);
    expect((await get(env, '/v1/projects', bearer(carol.accessToken))).json().projects).toEqual([]);
  });

  it('answers 404 for a malformed project id', async () => {
    expect((await patch(env, '/v1/projects/not-a-uuid', { name: 'x' }, bearer(alice.accessToken))).statusCode).toBe(404);
    expect((await del(env, '/v1/projects/not-a-uuid', bearer(alice.accessToken))).statusCode).toBe(404);
  });

  it('soft-deletes as maintainer: hidden from lists and from edits, folders moved to .trash while running', async () => {
    const id = (await create(alice, 'Gone')).json().id;
    await setState(alice, 'running');
    await env.db.query("insert into project_members (project_id, user_id, role) values ($1, $2, 'editor')", [id, bob.userId]);

    expect((await del(env, `/v1/projects/${id}`, bearer(bob.accessToken))).statusCode).toBe(403);
    expect((await del(env, `/v1/projects/${id}`, bearer(alice.accessToken))).statusCode).toBe(204);

    expect(await list(alice)).toEqual([]);
    expect((await patch(env, `/v1/projects/${id}`, { name: 'x' }, bearer(alice.accessToken))).statusCode).toBe(404);
    expect((await del(env, `/v1/projects/${id}`, bearer(alice.accessToken))).statusCode).toBe(404);

    const row = (await env.db.query('select deleted_at from projects where id = $1', [id])).rows[0];
    expect(row.deleted_at).toEqual(env.clock.now());
    expect(env.fs.trashes).toEqual([{ name: alice.k8sName, id, stamp: '20261009T020000000Z' }]);
  });

  it('a deleted project is left out of REIFY_PROJECT_IDS at the next pod start', async () => {
    const keep = (await create(alice, 'Keep')).json().id;
    const drop = (await create(alice, 'Drop')).json().id;
    await del(env, `/v1/projects/${drop}`, bearer(alice.accessToken));

    await post(env, '/v1/workspace/start', {}, bearer(alice.accessToken));
    await createController({ db: env.db, keys: env.keys, clock: env.clock, config: env.config, workspace: env.workspace }).tick();
    expect(env.k8s.env(alice.k8sName).REIFY_PROJECT_IDS).toBe(keep);
  });
});
