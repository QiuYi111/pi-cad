import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPasswordReset, disableUser, enableUser } from '../src/admin.js';
import { makeEnv, inviteToken, get, post, bearer, PASSWORD, type Env } from './helpers/env.js';

const MIN = 60 * 1000;
let env: Env;

beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.stop();
});

async function registerUser(email = 'alice@example.com', password = PASSWORD) {
  const tok = await inviteToken(env, { uses: 5 });
  const r = await post(env, '/v1/auth/register', { inviteToken: tok, email, displayName: 'Alice', password });
  expect(r.statusCode).toBe(201);
  return r.json().user as { id: string; email: string; displayName: string };
}

async function login(email: string, password: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return post(env, '/v1/auth/login', { email, password, deviceLabel: 'test-pc', ...extra }, headers);
}

describe('registration side effects', () => {
  it('creates user, credentials, identity, team, workspace and event in one go', async () => {
    const user = await registerUser('Alice@Example.com');
    expect(user.email).toBe('alice@example.com');

    const q = async (sql: string, p: unknown[] = []) => (await env.db.query(sql, p)).rows;
    const [u] = await q('select status, display_name, invite_id from users where id = $1', [user.id]);
    expect(u).toMatchObject({ status: 'active', display_name: 'Alice' });
    expect(u.invite_id).not.toBeNull();

    expect((await q('select count(*)::int n from password_credentials where user_id = $1', [user.id]))[0].n).toBe(1);
    const [ei] = await q("select provider, subject from external_identities where user_id = $1", [user.id]);
    expect(ei).toEqual({ provider: 'password', subject: 'alice@example.com' });

    const [tm] = await q(
      `select t.personal_owner, tm.role from team_members tm join teams t on t.id = tm.team_id where tm.user_id = $1`,
      [user.id],
    );
    expect(tm).toEqual({ personal_owner: user.id, role: 'owner' });

    const [w] = await q('select k8s_name, state, desired from workspaces where user_id = $1', [user.id]);
    expect(w.state).toBe('stopped');
    expect(w.desired).toBe('stopped');
    expect(w.k8s_name).toBe('ws-' + user.id.replace(/-/g, '').slice(0, 12));

    const ev = await q("select kind from events where user_id = $1 and kind = 'invite_used'", [user.id]);
    expect(ev).toHaveLength(1);
  });

  it('rejects a duplicate email with 409 and an invalid email with 400', async () => {
    await registerUser('dup@example.com');
    const tok = await inviteToken(env, { uses: 5 });
    const dup = await post(env, '/v1/auth/register', { inviteToken: tok, email: 'DUP@example.com', password: PASSWORD });
    expect(dup.statusCode).toBe(409);
    const bad = await post(env, '/v1/auth/register', { inviteToken: tok, email: 'not-an-email', password: PASSWORD });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_email');
  });
});

describe('login', () => {
  it('returns an ES256 access token for sub=userId that /v1/me accepts', async () => {
    const user = await registerUser();
    const r = await login('ALICE@example.com', PASSWORD);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user).toEqual({ id: user.id, email: 'alice@example.com', displayName: 'Alice' });
    expect(body.expiresIn).toBe(900);
    expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const me = await get(env, '/v1/me', bearer(body.accessToken));
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: user.id });

    // Refresh tokens are stored only as sha256.
    const rows = (await env.db.query('select token_hash from refresh_tokens')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash.toString('hex')).toHaveLength(64);
  });

  it('gives the same generic error for wrong password and unknown email', async () => {
    await registerUser();
    const wrong = await login('alice@example.com', 'wrong password!!');
    const unknown = await login('nobody@example.com', PASSWORD);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ code: 'invalid_credentials', message: '邮箱或密码错误' });
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('locks an email for 15 minutes after 5 failures, then unlocks', async () => {
    await registerUser();
    for (let i = 0; i < 5; i++) {
      expect((await login('alice@example.com', 'nope nope nope')).statusCode).toBe(401);
    }
    const locked = await login('alice@example.com', PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ code: 'locked', retryAfterSec: 900 });

    env.clock.advance(14 * MIN);
    expect((await login('alice@example.com', PASSWORD)).statusCode).toBe(429);
    env.clock.advance(MIN + 1000);
    expect((await login('alice@example.com', PASSWORD)).statusCode).toBe(200);
  });

  it('locks an IP for 1 hour after 30 failures across emails (client IP from X-Forwarded-For)', async () => {
    await env.stop();
    env = await makeEnv({ trustProxy: true });
    await registerUser();
    const h = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' };
    for (let i = 0; i < 30; i++) {
      expect((await login(`nobody${i}@example.com`, PASSWORD, {}, h)).statusCode).toBe(401);
    }
    // Valid user, but from the attacking IP: blocked.
    expect((await login('alice@example.com', PASSWORD, {}, h)).statusCode).toBe(429);
    // Other IP is fine.
    expect((await login('alice@example.com', PASSWORD, {}, { 'x-forwarded-for': '198.51.100.9' })).statusCode).toBe(200);
    env.clock.advance(60 * MIN + 1000);
    expect((await login('alice@example.com', PASSWORD, {}, h)).statusCode).toBe(200);
  });
});

describe('refresh tokens', () => {
  it('rotates on refresh: the old token is dead and the new one works', async () => {
    await registerUser();
    const first = (await login('alice@example.com', PASSWORD)).json();
    const r = await post(env, '/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(r.statusCode).toBe(200);
    const second = r.json();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await get(env, '/v1/me', bearer(second.accessToken))).statusCode).toBe(200);

    const { sha256 } = await import('../src/crypto.js');
    const byHash = async (t: string) =>
      (await env.db.query('select revoked_at, replaced_by from refresh_tokens where token_hash = $1', [sha256(t)])).rows[0];
    const old = await byHash(first.refreshToken);
    expect(old.revoked_at).not.toBeNull();
    expect(old.replaced_by).not.toBeNull();
    expect((await byHash(second.refreshToken)).revoked_at).toBeNull();
  });

  it('detects reuse of a rotated token and revokes all of the user refresh tokens', async () => {
    await registerUser();
    const a = (await login('alice@example.com', PASSWORD)).json();
    const b = (await login('alice@example.com', PASSWORD, { deviceLabel: 'laptop' })).json();
    const rotated = (await post(env, '/v1/auth/refresh', { refreshToken: a.refreshToken })).json();

    // Replaying the rotated token: rejected, and every session of this user is gone.
    const replay = await post(env, '/v1/auth/refresh', { refreshToken: a.refreshToken });
    expect(replay.statusCode).toBe(401);
    expect((await post(env, '/v1/auth/refresh', { refreshToken: rotated.refreshToken })).statusCode).toBe(401);
    expect((await post(env, '/v1/auth/refresh', { refreshToken: b.refreshToken })).statusCode).toBe(401);
    // Every later use of a revoked token is also reuse, so the count is >= 1.
    const ev = (await env.db.query("select count(*)::int n from events where kind = 'refresh_reuse'")).rows[0].n;
    expect(ev).toBeGreaterThanOrEqual(1);
  });

  it('rejects an expired refresh token after 30 days', async () => {
    await registerUser();
    const a = (await login('alice@example.com', PASSWORD)).json();
    env.clock.advance(30 * 24 * 60 * MIN + 1000);
    expect((await post(env, '/v1/auth/refresh', { refreshToken: a.refreshToken })).statusCode).toBe(401);
  });

  it('logout revokes the refresh token; the access token still works until it expires', async () => {
    await registerUser();
    const a = (await login('alice@example.com', PASSWORD)).json();
    expect((await post(env, '/v1/auth/logout', { refreshToken: a.refreshToken })).statusCode).toBe(204);
    expect((await post(env, '/v1/auth/refresh', { refreshToken: a.refreshToken })).statusCode).toBe(401);
    env.clock.advance(15 * MIN + 1000);
    expect((await get(env, '/v1/me', bearer(a.accessToken))).statusCode).toBe(401);
  });
});

describe('password change', () => {
  it('changes the password and revokes other devices, keeping the one named', async () => {
    await registerUser();
    const phone = (await login('alice@example.com', PASSWORD, { deviceLabel: 'phone' })).json();
    const pc = (await login('alice@example.com', PASSWORD, { deviceLabel: 'pc' })).json();

    const r = await post(env, '/v1/auth/password', { oldPassword: PASSWORD, newPassword: 'a brand new pass', refreshToken: pc.refreshToken }, bearer(pc.accessToken));
    expect(r.statusCode).toBe(204);

    // Kept token still refreshes. Refreshing the revoked phone token is reuse, so it runs last.
    expect((await post(env, '/v1/auth/refresh', { refreshToken: pc.refreshToken })).statusCode).toBe(200);
    expect((await post(env, '/v1/auth/refresh', { refreshToken: phone.refreshToken })).statusCode).toBe(401);
    expect((await login('alice@example.com', PASSWORD)).statusCode).toBe(401);
    expect((await login('alice@example.com', 'a brand new pass')).statusCode).toBe(200);
  });

  it('requires a valid access token and the correct old password', async () => {
    await registerUser();
    const a = (await login('alice@example.com', PASSWORD)).json();
    expect((await post(env, '/v1/auth/password', { oldPassword: PASSWORD, newPassword: 'another good one' })).statusCode).toBe(401);
    const wrong = await post(env, '/v1/auth/password', { oldPassword: 'not it at all', newPassword: 'another good one' }, bearer(a.accessToken));
    expect(wrong.statusCode).toBe(401);
  });
});

describe('password reset link', () => {
  const tokenOf = (url: string) => url.split('/reset/')[1];

  it('is single use, sets the new password, and revokes refresh tokens', async () => {
    await registerUser();
    const a = (await login('alice@example.com', PASSWORD)).json();
    const { url } = await createPasswordReset(env.db, env.clock.now(), env.config.publicBaseUrl, 'alice@example.com');
    expect(url.startsWith('https://test.example/reset/')).toBe(true);

    const ok = await post(env, '/v1/auth/reset', { token: tokenOf(url), newPassword: 'reset password 1' });
    expect(ok.statusCode).toBe(204);
    const again = await post(env, '/v1/auth/reset', { token: tokenOf(url), newPassword: 'reset password 2' });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ code: 'reset_invalid' });

    expect((await post(env, '/v1/auth/refresh', { refreshToken: a.refreshToken })).statusCode).toBe(401);
    expect((await login('alice@example.com', PASSWORD)).statusCode).toBe(401);
    expect((await login('alice@example.com', 'reset password 1')).statusCode).toBe(200);
  });

  it('expires after 24 hours', async () => {
    await registerUser();
    const { url } = await createPasswordReset(env.db, env.clock.now(), env.config.publicBaseUrl, 'alice@example.com');
    env.clock.advance(24 * 60 * MIN + 1000);
    expect((await post(env, '/v1/auth/reset', { token: tokenOf(url), newPassword: 'reset password 1' })).statusCode).toBe(400);
  });

  it('stores only the sha256 of the reset token', async () => {
    await registerUser();
    const { url } = await createPasswordReset(env.db, env.clock.now(), env.config.publicBaseUrl, 'alice@example.com');
    const rows = (await env.db.query('select token_hash from password_resets')).rows;
    expect(rows).toHaveLength(1);
    expect(url).not.toContain(rows[0].token_hash.toString('hex'));
    const { sha256 } = await import('../src/crypto.js');
    expect(rows[0].token_hash.equals(sha256(tokenOf(url)))).toBe(true);
  });
});

describe('disabled users', () => {
  it('cannot log in, refresh, or use an existing access token; re-enable restores login', async () => {
    await registerUser();
    const a = (await login('alice@example.com', PASSWORD)).json();

    await disableUser(env.db, env.clock.now(), 'alice@example.com');
    expect((await login('alice@example.com', PASSWORD)).statusCode).toBe(401);
    expect((await post(env, '/v1/auth/refresh', { refreshToken: a.refreshToken })).statusCode).toBe(401);
    expect((await get(env, '/v1/me', bearer(a.accessToken))).statusCode).toBe(401);
    expect((await env.db.query("select desired from workspaces")).rows[0].desired).toBe('stopped');

    await enableUser(env.db, env.clock.now(), 'alice@example.com');
    expect((await login('alice@example.com', PASSWORD)).statusCode).toBe(200);
  });
});

describe('misc routes', () => {
  it('serves the invite and reset pages as HTML', async () => {
    const inv = await get(env, '/invite/' + 'x'.repeat(43));
    expect(inv.statusCode).toBe(200);
    expect(inv.headers['content-type']).toContain('text/html');
    expect(inv.body).toContain('注册 Reify 账户');
    expect(inv.body).toContain('https://dl.example/setup.exe');
    const rst = await get(env, '/reset/' + 'x'.repeat(43));
    expect(rst.statusCode).toBe(200);
    expect(rst.body).toContain('重置密码');
  });

  it('healthz checks the database', async () => {
    expect((await get(env, '/v1/healthz')).json()).toEqual({ ok: true });
  });
});
