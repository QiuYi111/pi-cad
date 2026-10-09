import { isIP } from 'node:net';
import type { PoolClient } from 'pg';
import { dummyHash, EMAIL_RE, hashPassword, newToken, normalizeEmail, safeEqual, sha256, verifyPassword, TOKEN_RE } from './crypto.js';
import { withTx, isUniqueViolation } from './db.js';
import { HttpError, badRequest, invalidCredentials } from './errors.js';
import { inviteReason, INVITE_MESSAGES, inviteHash, isInviteTokenShape, type InviteRow } from './invites.js';
import { recordEvent, signAccess, type Deps } from './deps.js';

export interface UserView {
  id: string;
  email: string;
  displayName: string | null;
}

const MIN_PASSWORD = 10;
const MAX_PASSWORD = 1024;
const MIN = 60 * 1000;

export function checkPassword(pw: unknown): asserts pw is string {
  if (typeof pw !== 'string') throw badRequest('invalid_input', '密码必须是字符串');
  const n = [...pw].length;
  if (n < MIN_PASSWORD) throw badRequest('weak_password', `密码至少 ${MIN_PASSWORD} 个字符`);
  if (n > MAX_PASSWORD) throw badRequest('weak_password', '密码太长');
}

const invalidRefresh = () => new HttpError(401, 'invalid_refresh', '登录已过期，请重新登录');
const resetInvalid = () => new HttpError(400, 'reset_invalid', '重置链接无效或已过期');

// ---- registration ---------------------------------------------------------

export async function register(
  d: Deps,
  b: { inviteToken?: unknown; email?: unknown; displayName?: unknown; password?: unknown; ip?: string | null },
): Promise<{ user: UserView }> {
  if (typeof b.email !== 'string') throw badRequest('invalid_input', '请填写邮箱');
  const email = normalizeEmail(b.email);
  if (!EMAIL_RE.test(email) || email.length > 254) throw badRequest('invalid_email', '邮箱格式不正确');
  const name = (typeof b.displayName === 'string' ? b.displayName.trim() : '') || email.split('@')[0];
  if ([...name].length > 64) throw badRequest('invalid_input', '显示名最多 64 个字符');
  checkPassword(b.password);
  if (!isInviteTokenShape(b.inviteToken)) throw new HttpError(400, 'invite_invalid', INVITE_MESSAGES.not_found, { reason: 'not_found' });

  const now = d.clock.now();
  const th = inviteHash(b.inviteToken);
  const pwHash = await hashPassword(b.password); // outside the transaction: slow, and needs no lock

  try {
    return await withTx(d.db, async (c) => {
      // The row lock serializes concurrent uses of the same invite.
      const inv = (
        await c.query<InviteRow>(
          'select id, email, max_uses, used_count, expires_at, revoked_at from invites where token_hash = $1 for update',
          [th],
        )
      ).rows[0];
      const reason = inv ? inviteReason(inv, now) : 'not_found';
      if (reason) throw new HttpError(400, 'invite_invalid', INVITE_MESSAGES[reason], { reason });
      if (inv!.email && inv!.email !== email) throw badRequest('email_mismatch', '邮箱与邀请不符');
      if ((await c.query('select 1 from users where email = $1', [email])).rowCount) {
        throw new HttpError(409, 'email_taken', '该邮箱已注册');
      }

      const user = (
        await c.query<{ id: string }>(
          'insert into users (email, display_name, invite_id, created_at) values ($1, $2, $3, $4) returning id',
          [email, name, inv!.id, now],
        )
      ).rows[0];
      const uid = user.id;
      await c.query('insert into password_credentials (user_id, password_hash, updated_at) values ($1, $2, $3)', [uid, pwHash, now]);
      await c.query("insert into external_identities (user_id, provider, subject, created_at) values ($1, 'password', $2, $3)", [uid, email, now]);
      const team = (await c.query<{ id: string }>("insert into teams (name, personal_owner, created_at) values ('个人', $1, $2) returning id", [uid, now])).rows[0];
      await c.query("insert into team_members (team_id, user_id, role) values ($1, $2, 'owner')", [team.id, uid]);
      await c.query(
        "insert into workspaces (user_id, k8s_name, state, desired, state_changed_at) values ($1, $2, 'stopped', 'stopped', $3)",
        [uid, 'ws-' + uid.replace(/-/g, '').slice(0, 12), now],
      );
      await c.query('update invites set used_count = used_count + 1 where id = $1', [inv!.id]);
      await recordEvent(c, { kind: 'invite_used', at: now, userId: uid, detail: { inviteId: inv!.id } });
      return { user: { id: uid, email, displayName: name } };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'email_taken', '该邮箱已注册');
    throw e;
  }
}

// ---- login and lockout ----------------------------------------------------

// Lock rules (plan §5.1): same email 5 failures within 15 min -> locked 15 min;
// same IP 30 failures within 1 h -> locked 1 h. The lock runs from the Nth most recent failure.
async function lockedForMs(d: Deps, col: 'email' | 'ip', value: string, max: number, windowMs: number): Promise<number> {
  const r = await d.db.query<{ at: Date }>(
    `select at from login_attempts where ${col} = $1 and ok = false order by at desc offset $2 limit 1`,
    [value, max - 1],
  );
  if (!r.rows[0]) return 0;
  return Math.max(0, r.rows[0].at.getTime() + windowMs - d.clock.now().getTime());
}

export async function login(
  d: Deps,
  b: { email?: unknown; password?: unknown; deviceLabel?: unknown; ip?: string | null },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; user: UserView }> {
  if (typeof b.email !== 'string' || typeof b.password !== 'string' || !b.password) {
    throw badRequest('invalid_input', '请填写邮箱和密码');
  }
  const email = normalizeEmail(b.email);
  const deviceLabel = typeof b.deviceLabel === 'string' ? b.deviceLabel.slice(0, 200) : null;
  const ip = b.ip ?? null;
  const now = d.clock.now();

  const retry = Math.max(
    await lockedForMs(d, 'email', email, 5, 15 * MIN),
    ip ? await lockedForMs(d, 'ip', ip, 30, 60 * MIN) : 0,
  );
  if (retry > 0) {
    throw new HttpError(429, 'locked', '尝试次数过多，请稍后再试', { retryAfterSec: Math.ceil(retry / 1000) });
  }

  const row = (
    await d.db.query<{ id: string; email: string; display_name: string | null; status: string; password_hash: string | null }>(
      `select u.id, u.email, u.display_name, u.status, pc.password_hash
         from users u left join password_credentials pc on pc.user_id = u.id
        where u.email = $1`,
      [email],
    )
  ).rows[0];
  // Always run one argon2 verify, so unknown emails cost the same time as known ones.
  const ok = await verifyPassword(row?.password_hash ?? (await dummyHash()), b.password);
  const good = !!row && ok && row.status === 'active';
  await d.db.query('insert into login_attempts (email, ip, ok, at) values ($1, $2, $3, $4)', [email, ip, good, now]);
  if (!good) throw invalidCredentials();

  const { token, expiresIn } = await signAccess(d, row!.id);
  return withTx(d.db, async (c) => {
    const rt = await insertRefresh(c, d, row!.id, deviceLabel, now);
    await recordEvent(c, { kind: 'login', at: now, userId: row!.id, detail: { device: deviceLabel } });
    return {
      accessToken: token,
      refreshToken: rt.token,
      expiresIn,
      user: { id: row!.id, email: row!.email, displayName: row!.display_name },
    };
  });
}

// Stores only sha256(token). Returns the plaintext token (shown to the client once) and the row id.
async function insertRefresh(c: Pick<PoolClient, 'query'>, d: Deps, userId: string, deviceLabel: string | null, now: Date) {
  const token = newToken(32);
  const expires = new Date(now.getTime() + d.config.refreshTokenTtlDays * 24 * 60 * MIN);
  const r = await c.query<{ id: string }>(
    'insert into refresh_tokens (user_id, token_hash, device_label, expires_at, created_at) values ($1, $2, $3, $4, $5) returning id',
    [userId, sha256(token), deviceLabel, expires, now],
  );
  return { token, id: r.rows[0].id };
}

// ---- refresh, logout ------------------------------------------------------

export async function refresh(d: Deps, b: { refreshToken?: unknown }) {
  if (!TOKEN_RE.test(String(b.refreshToken ?? ''))) throw invalidRefresh();
  const token = b.refreshToken as string;
  const h = sha256(token);
  const now = d.clock.now();
  const out = await withTx(d.db, async (c) => {
    const r = (
      await c.query<{ id: string; user_id: string; token_hash: Buffer; device_label: string | null; expires_at: Date; revoked_at: Date | null; revoked_reason: string | null }>(
        'select id, user_id, token_hash, device_label, expires_at, revoked_at, revoked_reason from refresh_tokens where token_hash = $1 for update',
        [h],
      )
    ).rows[0];
    if (!r || !safeEqual(r.token_hash, h)) return { err: 'invalid' as const };
    if (r.revoked_at) {
      // Only a rotated token presented again means theft: revoke everything for the user. Returns (not throws) so this commits.
      // Tokens revoked for other reasons (logout, password change, reset, disabled) just get 401.
      if (r.revoked_reason === 'rotated') {
        await c.query('update refresh_tokens set revoked_at = $2 where user_id = $1 and revoked_at is null', [r.user_id, now]);
        await recordEvent(c, { kind: 'refresh_reuse', at: now, userId: r.user_id, detail: { tokenId: r.id } });
      }
      return { err: 'invalid' as const };
    }
    if (r.expires_at.getTime() <= now.getTime()) return { err: 'invalid' as const };
    const u = (await c.query<{ id: string; email: string; display_name: string | null; status: string }>(
      'select id, email, display_name, status from users where id = $1', [r.user_id])).rows[0];
    if (!u || u.status !== 'active') return { err: 'invalid' as const };

    const next = await insertRefresh(c, d, r.user_id, r.device_label, now);
    await c.query("update refresh_tokens set revoked_at = $2, revoked_reason = 'rotated', replaced_by = $3 where id = $1", [r.id, now, next.id]);
    return { ok: true as const, user: { id: u.id, email: u.email, displayName: u.display_name }, next: next.token };
  });
  if ('err' in out) throw invalidRefresh();
  const { token: accessToken, expiresIn } = await signAccess(d, out.user.id);
  return { accessToken, refreshToken: out.next, expiresIn, user: out.user };
}

export async function logout(d: Deps, b: { refreshToken?: unknown }) {
  if (!TOKEN_RE.test(String(b.refreshToken ?? ''))) return; // unknown token: nothing to revoke, no oracle
  await d.db.query("update refresh_tokens set revoked_at = $2, revoked_reason = 'logout' where token_hash = $1 and revoked_at is null", [
    sha256(b.refreshToken as string),
    d.clock.now(),
  ]);
}

// ---- password change and reset -------------------------------------------

// Logged-in change. Revokes this user's other refresh tokens. Pass the current device's refreshToken to keep it.
export async function changePassword(
  d: Deps,
  userId: string,
  b: { oldPassword?: unknown; newPassword?: unknown; refreshToken?: unknown },
) {
  checkPassword(b.newPassword);
  if (typeof b.oldPassword !== 'string') throw badRequest('invalid_input', '请填写原密码');
  const row = (await d.db.query<{ password_hash: string }>('select password_hash from password_credentials where user_id = $1', [userId])).rows[0];
  if (!row || !(await verifyPassword(row.password_hash, b.oldPassword))) {
    throw new HttpError(401, 'invalid_credentials', '原密码错误');
  }
  if (b.oldPassword === b.newPassword) throw badRequest('same_password', '新密码不能与原密码相同');
  const h = await hashPassword(b.newPassword);
  const keep = TOKEN_RE.test(String(b.refreshToken ?? '')) ? sha256(b.refreshToken as string) : null;
  const now = d.clock.now();
  await withTx(d.db, async (c) => {
    await c.query('update password_credentials set password_hash = $2, updated_at = $3 where user_id = $1', [userId, h, now]);
    await c.query(
      "update refresh_tokens set revoked_at = $2, revoked_reason = 'password_change' where user_id = $1 and revoked_at is null and ($3::bytea is null or token_hash <> $3)",
      [userId, now, keep],
    );
    await recordEvent(c, { kind: 'password_change', at: now, userId });
  });
}

// One-time reset link (issued by reify-admin). Consumes the link and revokes all refresh tokens.
export async function resetPassword(d: Deps, b: { token?: unknown; newPassword?: unknown }) {
  checkPassword(b.newPassword);
  if (!TOKEN_RE.test(String(b.token ?? ''))) throw resetInvalid();
  const h = sha256(b.token as string);
  const pwHash = await hashPassword(b.newPassword);
  const now = d.clock.now();
  await withTx(d.db, async (c) => {
    const r = (
      await c.query<{ id: string; user_id: string; expires_at: Date; consumed_at: Date | null }>(
        'select id, user_id, expires_at, consumed_at from password_resets where token_hash = $1 for update',
        [h],
      )
    ).rows[0];
    if (!r || r.consumed_at || r.expires_at.getTime() <= now.getTime()) throw resetInvalid();
    await c.query('update password_resets set consumed_at = $2 where id = $1', [r.id, now]);
    await c.query(
      `insert into password_credentials (user_id, password_hash, updated_at) values ($1, $2, $3)
       on conflict (user_id) do update set password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
      [r.user_id, pwHash, now],
    );
    await c.query("update refresh_tokens set revoked_at = $2, revoked_reason = 'reset' where user_id = $1 and revoked_at is null", [r.user_id, now]);
    await recordEvent(c, { kind: 'password_reset', at: now, userId: r.user_id });
  });
}
