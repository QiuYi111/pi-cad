import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInvite, createPasswordReset, disableUser, listInvites, listUsers, revokeInvite, enableUser } from '../src/admin.js';
import { sha256 } from '../src/crypto.js';
import { migrate } from '../src/migrate.js';
import { HttpError } from '../src/errors.js';
import { makeEnv, type Env } from './helpers/env.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.stop();
});

const BASE = 'https://reify.example.ts.net';

describe('admin invites', () => {
  it('creates an invite whose printed URL carries a 32-byte base64url token; only the hash is stored', async () => {
    const inv = await createInvite(env.db, env.clock.now(), BASE, { email: 'Carol@Example.com', uses: 2, days: 3, note: 'friend' });
    expect(inv.url).toBe(`${BASE}/invite/${inv.token}`);
    expect(Buffer.from(inv.token, 'base64url')).toHaveLength(32);
    expect(inv.expiresAt.getTime()).toBe(env.clock.now().getTime() + 3 * 24 * 60 * 60 * 1000);

    const row = (await env.db.query('select token_hash, email, max_uses, note from invites where id = $1', [inv.id])).rows[0];
    expect(row.token_hash.equals(sha256(inv.token))).toBe(true);
    expect(row).toMatchObject({ email: 'carol@example.com', max_uses: 2, note: 'friend' });
  });

  it('validates uses, days and email', async () => {
    await expect(createInvite(env.db, env.clock.now(), BASE, { uses: 0 })).rejects.toBeInstanceOf(HttpError);
    await expect(createInvite(env.db, env.clock.now(), BASE, { days: 0 })).rejects.toBeInstanceOf(HttpError);
    await expect(createInvite(env.db, env.clock.now(), BASE, { email: 'nope' })).rejects.toBeInstanceOf(HttpError);
  });

  it('lists invites with computed status, and revokes by id', async () => {
    const a = await createInvite(env.db, env.clock.now(), BASE, {});
    const b = await createInvite(env.db, env.clock.now(), BASE, { days: 1 });
    await revokeInvite(env.db, env.clock.now(), a.id);
    env.clock.advance(2 * 24 * 60 * 60 * 1000);
    const list = await listInvites(env.db, env.clock.now());
    const byId = Object.fromEntries(list.map((x) => [x.id, x.status]));
    expect(byId[a.id]).toBe('revoked');
    expect(byId[b.id]).toBe('expired');
  });

  it('reports unknown ids on revoke', async () => {
    await expect(revokeInvite(env.db, env.clock.now(), '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 });
    await expect(revokeInvite(env.db, env.clock.now(), 'nope')).rejects.toMatchObject({ status: 400 });
  });
});

describe('admin users', () => {
  it('disable/enable toggles status and stops the workspace', async () => {
    const inv = await createInvite(env.db, env.clock.now(), BASE, { email: 'dan@example.com' });
    const { app } = env;
    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { inviteToken: inv.token, email: 'dan@example.com', password: 'long enough pass' },
    });
    expect(r.statusCode).toBe(201);

    await disableUser(env.db, env.clock.now(), 'Dan@example.com');
    let [u] = await listUsers(env.db);
    expect(u).toMatchObject({ email: 'dan@example.com', status: 'disabled', desired: 'stopped' });
    await enableUser(env.db, env.clock.now(), 'dan@example.com');
    [u] = await listUsers(env.db);
    expect(u.status).toBe('active');
  });

  it('reset-password prints a 24 hour link and rejects unknown users', async () => {
    const inv = await createInvite(env.db, env.clock.now(), BASE, { email: 'eve@example.com' });
    await env.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { inviteToken: inv.token, email: 'eve@example.com', password: 'long enough pass' },
    });
    const r = await createPasswordReset(env.db, env.clock.now(), BASE, 'eve@example.com');
    expect(r.url).toMatch(/^https:\/\/reify\.example\.ts\.net\/reset\/[A-Za-z0-9_-]{43}$/);
    expect(r.expiresAt.getTime() - env.clock.now().getTime()).toBe(24 * 60 * 60 * 1000);
    await expect(createPasswordReset(env.db, env.clock.now(), BASE, 'ghost@example.com')).rejects.toMatchObject({ status: 404 });
  });
});

describe('migrations', () => {
  it('are idempotent', async () => {
    expect(await migrate(env.db)).toEqual([]);
  });
});
