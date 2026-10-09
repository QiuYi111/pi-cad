import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revokeInvite } from '../src/admin.js';
import { makeEnv, inviteToken, get, post, PASSWORD, type Env } from './helpers/env.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.stop();
});

const reg = (token: string, email: string, password = PASSWORD) =>
  post(env, '/v1/auth/register', { inviteToken: token, email, displayName: 'T', password });

describe('invite validity', () => {
  it('reports a fresh invite as valid, with its bound email', async () => {
    const tok = await inviteToken(env, { email: 'Bound@Example.com' });
    const r = await get(env, `/v1/invites/${tok}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ valid: true, email: 'bound@example.com' });
  });

  it('reports unknown and malformed tokens as not_found', async () => {
    expect((await get(env, '/v1/invites/' + 'a'.repeat(43))).json()).toMatchObject({ valid: false, reason: 'not_found' });
    expect((await get(env, '/v1/invites/%20%20')).json()).toMatchObject({ valid: false, reason: 'not_found' });
  });

  it('rejects an expired invite', async () => {
    const tok = await inviteToken(env, { days: 1 });
    env.clock.advance(24 * 60 * 60 * 1000);
    expect((await get(env, `/v1/invites/${tok}`)).json()).toMatchObject({ valid: false, reason: 'expired' });
    const r = await reg(tok, 'a@example.com');
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'invite_invalid', reason: 'expired' });
  });

  it('rejects a revoked invite', async () => {
    const tok = await inviteToken(env);
    const inv = (await env.db.query('select id from invites')).rows[0];
    await revokeInvite(env.db, env.clock.now(), inv.id);
    expect((await get(env, `/v1/invites/${tok}`)).json()).toMatchObject({ valid: false, reason: 'revoked' });
    expect((await reg(tok, 'a@example.com')).json()).toMatchObject({ code: 'invite_invalid', reason: 'revoked' });
  });

  it('rejects an invite that is used up, and allows a multi-use invite until max_uses', async () => {
    const tok = await inviteToken(env, { uses: 2 });
    expect((await reg(tok, 'one@example.com')).statusCode).toBe(201);
    expect((await reg(tok, 'two@example.com')).statusCode).toBe(201);
    const r = await reg(tok, 'three@example.com');
    expect(r.json()).toMatchObject({ code: 'invite_invalid', reason: 'used' });
    expect((await get(env, `/v1/invites/${tok}`)).json()).toMatchObject({ valid: false, reason: 'used' });
  });

  it('rejects an email that does not match the invite, without consuming it', async () => {
    const tok = await inviteToken(env, { email: 'bound@example.com' });
    const r = await reg(tok, 'other@example.com');
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'email_mismatch' });
    expect((await get(env, `/v1/invites/${tok}`)).json()).toEqual({ valid: true, email: 'bound@example.com' });
    expect((await reg(tok, 'BOUND@example.com')).statusCode).toBe(201);
  });

  it('does not consume an invite when the password is too short', async () => {
    const tok = await inviteToken(env);
    const r = await reg(tok, 'a@example.com', 'short');
    expect(r.json()).toMatchObject({ code: 'weak_password' });
    expect((await get(env, `/v1/invites/${tok}`)).json()).toEqual({ valid: true });
  });
});

describe('concurrent registration', () => {
  it('lets exactly one of two concurrent registrations use a single-use invite', async () => {
    const tok = await inviteToken(env, { uses: 1 });
    const [a, b] = await Promise.all([reg(tok, 'race-a@example.com'), reg(tok, 'race-b@example.com')]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 400]);
    const used = (await env.db.query('select used_count from invites')).rows[0].used_count;
    expect(used).toBe(1);
    expect((await env.db.query('select count(*)::int n from users')).rows[0].n).toBe(1);
  });

  it('does not create duplicate accounts for the same email under the same invite race', async () => {
    const tok = await inviteToken(env, { uses: 2 });
    const [a, b] = await Promise.all([reg(tok, 'same@example.com'), reg(tok, 'same@example.com')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((await env.db.query('select count(*)::int n from users')).rows[0].n).toBe(1);
  });
});
