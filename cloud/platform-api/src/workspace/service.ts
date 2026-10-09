// Workspace requests from users (plan 5.3) and the shared rules for capacity and the start queue.
import type { Config } from '../config.js';
import type { Deps, Q } from '../deps.js';
import { recordEvent } from '../deps.js';
import { withTx } from '../db.js';
import { HttpError } from '../errors.js';

// Advisory lock taken by every change to desired state or the queue, so capacity checks cannot race.
export const CAPACITY_LOCK = 727002;

export interface WorkspaceRow {
  id: string;
  user_id: string;
  k8s_name: string;
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  desired: 'running' | 'stopped';
  last_activity_at: Date | null;
  idle_warned_at: Date | null;
  state_changed_at: Date;
  last_error: string | null;
  activity_token_hash: Buffer | null;
}

export interface WorkspaceView {
  name: string;
  state: WorkspaceRow['state'];
  desired: WorkspaceRow['desired'];
  lastActivityAt: string | null;
  idleWarnedAt: string | null;
  reclaimAt: string | null; // set once the idle warning has been sent
  lastError: string | null;
  queuePosition: number | null; // 1-based, null when not queued
}

export async function workspaceForUser(q: Q, userId: string): Promise<WorkspaceRow> {
  const r = await q.query<WorkspaceRow>('select * from workspaces where user_id = $1', [userId]);
  if (!r.rows[0]) throw new HttpError(404, 'not_found', '没有工作区');
  return r.rows[0];
}

export async function activeCount(q: Q): Promise<number> {
  const r = await q.query<{ n: number }>(
    "select count(*)::int n from workspaces where desired = 'running' or state in ('starting','running')",
  );
  return r.rows[0].n;
}

// 1-based position in the start queue, or null when this workspace is not queued.
export async function queuePosition(q: Q, workspaceId: string): Promise<number | null> {
  const r = await q.query<{ pos: number }>(
    `select (select count(*) from workspace_queue o where o.seq <= q.seq)::int pos
       from workspace_queue q where q.workspace_id = $1`,
    [workspaceId],
  );
  return r.rows[0]?.pos ?? null;
}

export async function viewOf(q: Q, w: WorkspaceRow, config: Config): Promise<WorkspaceView> {
  const last = w.last_activity_at;
  return {
    name: w.k8s_name,
    state: w.state,
    desired: w.desired,
    lastActivityAt: last?.toISOString() ?? null,
    idleWarnedAt: w.idle_warned_at?.toISOString() ?? null,
    reclaimAt: w.idle_warned_at && last ? new Date(last.getTime() + config.idleReclaimMs).toISOString() : null,
    lastError: w.last_error,
    queuePosition: await queuePosition(q, w.id),
  };
}

export async function getView(d: Deps, userId: string): Promise<WorkspaceView> {
  const w = await workspaceForUser(d.db, userId);
  return viewOf(d.db, w, d.config);
}

// POST /v1/workspace/start. Admits now when a slot is free and nobody is queued ahead. Otherwise the caller
// is queued (once) and gets 409 capacity_full with its position.
export async function startWorkspace(d: Deps, userId: string): Promise<WorkspaceView> {
  const now = d.clock.now();
  const outcome = await withTx(d.db, async (c) => {
    await c.query('select pg_advisory_xact_lock($1)', [CAPACITY_LOCK]);
    const w = await workspaceForUser(c, userId);
    if (w.desired === 'running') return { full: false as const, view: await viewOf(c, w, d.config) };

    const active = await activeCount(c);
    const queued = await queuePosition(c, w.id);
    const queueLength = (await c.query<{ n: number }>('select count(*)::int n from workspace_queue')).rows[0].n;
    const admit = active < d.config.maxActiveWorkspaces && (queueLength === 0 || queued === 1);
    if (admit) {
      await c.query('delete from workspace_queue where workspace_id = $1', [w.id]);
      await c.query(
        "update workspaces set desired = 'running', last_activity_at = $2, idle_warned_at = null where id = $1",
        [w.id, now],
      );
      return { full: false as const, view: await viewOf(c, { ...w, desired: 'running', last_activity_at: now, idle_warned_at: null }, d.config) };
    }
    if (queued === null) {
      await c.query('insert into workspace_queue (workspace_id, queued_at) values ($1, $2)', [w.id, now]);
    }
    return { full: true as const, position: await queuePosition(c, w.id) };
  });
  // Thrown outside the transaction, so the queue entry above is committed.
  if (outcome.full) throw new HttpError(409, 'capacity_full', '同时运行的工作区已满，已排队', { position: outcome.position });
  return outcome.view;
}

// POST /v1/workspace/stop. The controller does the shutdown and the scale to 0.
export async function stopWorkspace(d: Deps, userId: string): Promise<WorkspaceView> {
  return withTx(d.db, async (c) => {
    await c.query('select pg_advisory_xact_lock($1)', [CAPACITY_LOCK]);
    const w = await workspaceForUser(c, userId);
    await c.query('delete from workspace_queue where workspace_id = $1', [w.id]);
    await c.query("update workspaces set desired = 'stopped' where id = $1", [w.id]);
    return viewOf(c, { ...w, desired: 'stopped' }, d.config);
  });
}

// POST /v1/workspace/keepalive: the user chose "continue" on the idle warning.
export async function keepalive(d: Deps, userId: string): Promise<WorkspaceView> {
  const now = d.clock.now();
  const r = await d.db.query<WorkspaceRow>(
    'update workspaces set last_activity_at = $2, idle_warned_at = null where user_id = $1 returning *',
    [userId, now],
  );
  if (!r.rows[0]) throw new HttpError(404, 'not_found', '没有工作区');
  return viewOf(d.db, r.rows[0], d.config);
}

// Records user activity. Writes at most once per `minGapMs` (plan 5.4, bridge traffic). Returns whether it wrote.
export async function touchActivity(d: Deps, workspaceId: string, minGapMs: number): Promise<boolean> {
  const now = d.clock.now();
  const r = await d.db.query(
    `update workspaces set last_activity_at = $2, idle_warned_at = null
      where id = $1 and (last_activity_at is null or last_activity_at < $3)`,
    [workspaceId, now, new Date(now.getTime() - minGapMs)],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function recordWorkspaceEvent(
  q: Q,
  d: Deps,
  w: Pick<WorkspaceRow, 'id' | 'user_id'>,
  kind: string,
  detail: object = {},
): Promise<void> {
  await recordEvent(q, { kind, at: d.clock.now(), userId: w.user_id, workspaceId: w.id, detail });
}
