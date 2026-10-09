// Operator functions used by cloud/admin/reify-admin.ts. Each takes the current time explicitly.
import { EMAIL_RE, newToken, normalizeEmail, sha256 } from './crypto.js';
import type { Db } from './db.js';
import { withTx } from './db.js';
import { recordEvent } from './deps.js';
import { HttpError, badRequest } from './errors.js';
import { inviteHash } from './invites.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireEmail(s: string): string {
  const e = normalizeEmail(s);
  if (!EMAIL_RE.test(e)) throw badRequest('invalid_email', `邮箱格式不正确：${s}`);
  return e;
}

export interface CreatedInvite {
  id: string;
  token: string; // shown once
  url: string;
  expiresAt: Date;
}

// Plan §10: invite create [--email] [--uses 1] [--days 7] [--note]
export async function createInvite(
  db: Db,
  now: Date,
  publicBaseUrl: string,
  opts: { email?: string; uses?: number; days?: number; note?: string } = {},
): Promise<CreatedInvite> {
  const uses = opts.uses ?? 1;
  const days = opts.days ?? 7;
  if (!Number.isInteger(uses) || uses < 1 || uses > 1000) throw badRequest('invalid_input', '--uses 必须是 1 到 1000 的整数');
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw badRequest('invalid_input', '--days 必须在 0 到 365 之间');
  const email = opts.email ? requireEmail(opts.email) : null;
  const token = newToken(32);
  const expiresAt = new Date(now.getTime() + days * DAY);
  const r = await db.query<{ id: string }>(
    'insert into invites (token_hash, email, max_uses, expires_at, note, created_at) values ($1, $2, $3, $4, $5, $6) returning id',
    [inviteHash(token), email, uses, expiresAt, opts.note ?? null, now],
  );
  return { id: r.rows[0].id, token, url: `${publicBaseUrl}/invite/${token}`, expiresAt };
}

export async function listInvites(db: Db, now: Date) {
  const r = await db.query(
    `select id, email, max_uses, used_count, expires_at, revoked_at, note, created_at
       from invites order by created_at desc limit 200`,
  );
  return r.rows.map((x) => ({
    id: x.id as string,
    email: x.email as string | null,
    uses: `${x.used_count}/${x.max_uses}`,
    expiresAt: x.expires_at as Date,
    status: x.revoked_at
      ? 'revoked'
      : x.used_count >= x.max_uses
        ? 'used'
        : x.expires_at.getTime() <= now.getTime()
          ? 'expired'
          : 'valid',
    note: x.note as string | null,
    createdAt: x.created_at as Date,
  }));
}

export async function revokeInvite(db: Db, now: Date, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw badRequest('invalid_input', '邀请 id 格式不正确');
  const r = await db.query('update invites set revoked_at = coalesce(revoked_at, $2) where id = $1 returning id', [id, now]);
  if (!r.rowCount) throw new HttpError(404, 'not_found', '没有这个邀请');
}

export async function listUsers(db: Db) {
  const r = await db.query(
    `select u.email, u.display_name, u.status, u.created_at, w.state, w.desired
       from users u left join workspaces w on w.user_id = u.id order by u.created_at`,
  );
  return r.rows as Array<{
    email: string;
    display_name: string | null;
    status: string;
    created_at: Date;
    state: string | null;
    desired: string | null;
  }>;
}

async function userIdByEmail(c: Pick<Db, 'query'>, email: string): Promise<string> {
  const r = await c.query('select id from users where email = $1', [email]);
  if (!r.rowCount) throw new HttpError(404, 'not_found', `没有这个用户：${email}`);
  return r.rows[0].id as string;
}

// Disables login, revokes refresh tokens, and asks the workspace controller to stop the pod.
export async function disableUser(db: Db, now: Date, emailIn: string): Promise<void> {
  const email = requireEmail(emailIn);
  await withTx(db, async (c) => {
    const id = await userIdByEmail(c, email);
    await c.query("update users set status = 'disabled' where id = $1", [id]);
    await c.query("update refresh_tokens set revoked_at = $2, revoked_reason = 'disabled' where user_id = $1 and revoked_at is null", [id, now]);
    await c.query("update workspaces set desired = 'stopped' where user_id = $1", [id]);
    await c.query('delete from workspace_queue where workspace_id in (select id from workspaces where user_id = $1)', [id]);
    await recordEvent(c, { kind: 'user_disable', at: now, userId: id, detail: { by: 'admin' } });
  });
}

export async function enableUser(db: Db, now: Date, emailIn: string): Promise<void> {
  const email = requireEmail(emailIn);
  await withTx(db, async (c) => {
    const id = await userIdByEmail(c, email);
    await c.query("update users set status = 'active' where id = $1", [id]);
    await recordEvent(c, { kind: 'user_enable', at: now, userId: id, detail: { by: 'admin' } });
  });
}

// One-time reset link, valid 24 h by default. Only the sha256 of the token is stored.
export async function createPasswordReset(
  db: Db,
  now: Date,
  publicBaseUrl: string,
  emailIn: string,
  hours = 24,
): Promise<{ url: string; expiresAt: Date }> {
  const email = requireEmail(emailIn);
  return withTx(db, async (c) => {
    const id = await userIdByEmail(c, email);
    const token = newToken(32);
    const expiresAt = new Date(now.getTime() + hours * HOUR);
    await c.query(
      'insert into password_resets (user_id, token_hash, expires_at, created_at) values ($1, $2, $3, $4)',
      [id, sha256(token), expiresAt, now],
    );
    await recordEvent(c, { kind: 'password_reset_issued', at: now, userId: id, detail: { by: 'admin' } });
    return { url: `${publicBaseUrl}/reset/${token}`, expiresAt };
  });
}

export interface WorkspaceAdminRow {
  email: string;
  name: string;
  state: string;
  desired: string;
  lastActivityAt: Date | null;
  idleWarnedAt: Date | null;
  lastError: string | null;
}

export async function listWorkspaces(db: Db): Promise<WorkspaceAdminRow[]> {
  const r = await db.query(
    `select u.email, w.k8s_name, w.state, w.desired, w.last_activity_at, w.idle_warned_at, w.last_error
       from workspaces w join users u on u.id = w.user_id order by w.last_activity_at desc nulls last, u.email`,
  );
  return r.rows.map((x) => ({
    email: x.email as string,
    name: x.k8s_name as string,
    state: x.state as string,
    desired: x.desired as string,
    lastActivityAt: x.last_activity_at as Date | null,
    idleWarnedAt: x.idle_warned_at as Date | null,
    lastError: x.last_error as string | null,
  }));
}

// Forced stop: desired=stopped and removed from the start queue. The controller does the shutdown (plan 10).
export async function stopWorkspaceByEmail(db: Db, now: Date, emailIn: string): Promise<void> {
  const email = requireEmail(emailIn);
  await withTx(db, async (c) => {
    const id = await userIdByEmail(c, email);
    await c.query('delete from workspace_queue where workspace_id in (select id from workspaces where user_id = $1)', [id]);
    await c.query("update workspaces set desired = 'stopped' where user_id = $1", [id]);
    await recordEvent(c, { kind: 'ws_stop_requested', at: now, userId: id, detail: { by: 'admin' } });
  });
}

// Plan 8.6 status without CPU and memory. Those would need the metrics API from the admin machine (not wired here).
export async function statusReport(db: Db, now: Date) {
  const since = new Date(now.getTime() - 24 * HOUR);
  const [active, counts, errors, queued, failing] = await Promise.all([
    db.query(
      `select u.email, w.state, w.desired, w.last_activity_at from workspaces w join users u on u.id = w.user_id
        where w.desired = 'running' or w.state in ('starting','running') order by w.last_activity_at desc nulls last`,
    ),
    db.query('select state, count(*)::int n from workspaces group by state order by state'),
    db.query("select count(*)::int n from events where kind = 'error' and at >= $1", [since]),
    db.query('select count(*)::int n from workspace_queue'),
    db.query(
      `select u.email, w.state, w.last_error from workspaces w join users u on u.id = w.user_id
        where w.last_error is not null order by u.email`,
    ),
  ]);
  return {
    active: active.rows.map((x) => ({ email: x.email as string, state: x.state as string, lastActivityAt: x.last_activity_at as Date | null })),
    countsByState: Object.fromEntries(counts.rows.map((x) => [x.state as string, x.n as number])),
    errorEventsLast24h: errors.rows[0].n as number,
    queued: queued.rows[0].n as number,
    // Workspaces whose last reconcile failed or timed out. Cleared by the next clean pass.
    withErrors: failing.rows.map((x) => ({ email: x.email as string, state: x.state as string, lastError: x.last_error as string })),
  };
}
