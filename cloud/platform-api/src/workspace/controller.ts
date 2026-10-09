// Workspace controller (plan 5.4). Every tick reconciles desired state with the cluster. It does not depend on
// a single request succeeding. Time comes from the injected clock, so tests drive it with tick().
import { newToken, sha256 } from '../crypto.js';
import type { Deps } from '../deps.js';
import { recordEvent } from '../deps.js';
import { withTx } from '../db.js';
import { CAPACITY_LOCK, activeCount, recordWorkspaceEvent, type WorkspaceRow } from './service.js';
import { renderWorkspaceManifests, type TemplateVars } from './template.js';
import type { DeploymentStatus, WorkspaceDeps } from './ports.js';

export interface Controller {
  tick(): Promise<void>;
}

export function createController(d: Deps & { workspace: WorkspaceDeps }, log: (msg: string, err?: unknown) => void = defaultLog): Controller {
  const { db, clock, config, workspace: ws } = d;
  // Workspaces whose shutdown message has gone out. Lost on restart, which only means one repeat shutdown.
  const shutdownSent = new Set<string>();

  async function setState(w: WorkspaceRow, state: WorkspaceRow['state'], now: Date): Promise<void> {
    if (state === 'starting') {
      // The start moment also starts the idle clock.
      await db.query("update workspaces set state = 'starting', state_changed_at = $2, last_activity_at = $2 where id = $1", [w.id, now]);
    } else {
      await db.query('update workspaces set state = $2, state_changed_at = $3 where id = $1', [w.id, state, now]);
    }
    w.state = state;
    w.state_changed_at = now;
    ws.events.workspaceState(w.user_id, state);
  }

  async function projectIds(userId: string): Promise<string[]> {
    const r = await db.query<{ id: string }>(
      `select p.id from projects p join project_members pm on pm.project_id = p.id
        where pm.user_id = $1 and p.deleted_at is null order by p.created_at, p.id`,
      [userId],
    );
    return r.rows.map((x) => x.id);
  }

  // Rule 1: desired=running and no pod (or 0 replicas). Create the PVC and Deployment, or scale to 1.
  async function startPod(w: WorkspaceRow, now: Date): Promise<void> {
    if (w.state !== 'starting') {
      await setState(w, 'starting', now);
      await recordWorkspaceEvent(db, d, w, 'ws_start');
    }
    shutdownSent.delete(w.id);
    const ids = await projectIds(w.user_id);
    // A fresh activity token on every start. Its hash goes to the database; the plaintext goes to the pod env.
    const token = newToken(32);
    await db.query('update workspaces set activity_token_hash = $2 where id = $1', [w.id, sha256(token)]);
    const vars: TemplateVars = {
      WS_K8S_NAME: w.k8s_name,
      WORKSPACE_ID: w.id,
      WORKSPACE_IMAGE: config.workspaceImage,
      PROJECT_IDS: ids.join(','),
      REPLICAS: '1',
      SECCOMP_TYPE: config.workspaceSeccompType,
      HOST_USERS: config.workspaceHostUsers,
      HTTPS_PROXY_FOR_WORKSPACES: config.httpsProxyForWorkspaces,
      PLATFORM_INTERNAL_URL: config.platformInternalUrl,
      ACTIVITY_URL: `${config.platformInternalUrl}/internal/workspaces/${w.id}/activity`,
      ACTIVITY_TOKEN: token,
    };
    for (const obj of renderWorkspaceManifests(ws.template, vars)) await ws.k8s.apply(obj);
  }

  // Rule 3: stop. Send "shutdown" through the gateway, wait up to 30 s, then scale to 0.
  async function finishStop(w: WorkspaceRow, dep: DeploymentStatus | null, now: Date): Promise<void> {
    if ((dep?.replicas ?? 0) === 0) {
      if (w.state !== 'stopped') {
        await setState(w, 'stopped', now);
        await recordWorkspaceEvent(db, d, w, 'ws_stop');
      }
      shutdownSent.delete(w.id);
      return;
    }
    if (!shutdownSent.has(w.id)) {
      shutdownSent.add(w.id);
      await ws.gateway.shutdown(w.user_id, w.k8s_name).catch((e) => log(`shutdown ${w.k8s_name}`, e));
    }
    const alive = (dep?.readyReplicas ?? 0) >= 1 && (await ws.gateway.healthz(w.k8s_name));
    // The gateway exits after "shutdown", so a dead health check means Prime is done.
    if (alive && now.getTime() - w.state_changed_at.getTime() < config.shutdownWaitMs) return;
    await ws.k8s.scale(w.k8s_name, 0);
  }

  // Rule 4: starting for more than 5 minutes is a failure. Scale to 0 and stop desiring it.
  async function failStart(w: WorkspaceRow, now: Date): Promise<void> {
    const message = 'the workspace did not become ready within 5 minutes';
    await db.query(
      "update workspaces set state = 'failed', state_changed_at = $2, desired = 'stopped', last_error = $3 where id = $1",
      [w.id, now, message],
    );
    await recordWorkspaceEvent(db, d, w, 'error', { reason: 'start_timeout', message });
    shutdownSent.delete(w.id);
    ws.events.workspaceState(w.user_id, 'failed');
    await ws.k8s.scale(w.k8s_name, 0).catch((e) => log(`scale ${w.k8s_name} to 0`, e));
  }

  async function markRunning(w: WorkspaceRow, now: Date): Promise<void> {
    await setState(w, 'running', now);
    await db.query('update workspaces set last_error = null where id = $1', [w.id]);
    // Project folders created while the pod was starting were not in its env. Create any that are missing.
    await ws.fs.mkdirProjects(w.user_id, w.k8s_name, await projectIds(w.user_id)).catch((e) => log(`mkdir projects ${w.k8s_name}`, e));
  }

  // Rule 5: idle timers, only while running and ready.
  async function idle(w: WorkspaceRow, now: Date): Promise<void> {
    const last = (w.last_activity_at ?? w.state_changed_at).getTime();
    const idleMs = now.getTime() - last;
    if (idleMs > config.idleReclaimMs) {
      await db.query("update workspaces set desired = 'stopped' where id = $1", [w.id]);
      await recordWorkspaceEvent(db, d, w, 'ws_reclaim', { idleMs });
      ws.events.reclaimed(w.user_id);
      w.desired = 'stopped';
      return;
    }
    if (idleMs > config.idleWarnMs && !w.idle_warned_at) {
      await db.query('update workspaces set idle_warned_at = $2 where id = $1', [w.id, now]);
      w.idle_warned_at = now;
      await recordWorkspaceEvent(db, d, w, 'ws_idle_warn', { idleMs });
      ws.events.idleWarning(w.user_id, new Date(last + config.idleReclaimMs));
    }
  }

  async function reconcile(w: WorkspaceRow, now: Date): Promise<void> {
    const dep = await ws.k8s.getDeployment(w.k8s_name);
    const replicas = dep?.replicas ?? 0;

    if (w.state === 'stopping') return finishStop(w, dep, now);

    if (w.desired === 'stopped') {
      if (replicas > 0) {
        await setState(w, 'stopping', now);
        return finishStop(w, dep, now);
      }
      if (w.state === 'starting' || w.state === 'running') {
        await setState(w, 'stopped', now);
        await recordWorkspaceEvent(db, d, w, 'ws_stop');
      }
      return;
    }

    // desired = running
    const ready = replicas > 0 && (dep?.readyReplicas ?? 0) >= 1 && (await ws.gateway.healthz(w.k8s_name));
    if (ready) {
      if (w.state === 'running') return idle(w, now);
      return markRunning(w, now);
    }
    if (w.state === 'running') await setState(w, 'starting', now); // not ready any more
    if (w.state === 'starting' && now.getTime() - w.state_changed_at.getTime() > config.startTimeoutMs) return failStart(w, now);
    if (replicas === 0) return startPod(w, now);
    if (w.state !== 'starting') await setState(w, 'starting', now);
  }

  // Admits queued workspaces, oldest first, while there is capacity (plan 5.4, last rule).
  async function admitQueued(now: Date): Promise<void> {
    await withTx(db, async (c) => {
      await c.query('select pg_advisory_xact_lock($1)', [CAPACITY_LOCK]);
      let active = await activeCount(c);
      while (active < config.maxActiveWorkspaces) {
        const head = (
          await c.query<{ workspace_id: string }>(
            'delete from workspace_queue where seq = (select min(seq) from workspace_queue) returning workspace_id',
          )
        ).rows[0];
        if (!head) break;
        await c.query("update workspaces set desired = 'running', last_activity_at = $2, idle_warned_at = null where id = $1", [
          head.workspace_id,
          now,
        ]);
        await recordEvent(c, { kind: 'ws_admit', at: now, workspaceId: head.workspace_id, detail: {} });
        active++;
      }
    });
  }

  // Sets last_error to the reconcile failure, so the user (GET /v1/workspace) and reify-admin status see it.
  async function recordError(w: WorkspaceRow, e: unknown): Promise<void> {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db.query('update workspaces set last_error = $2 where id = $1', [w.id, message]);
  }

  // Clears a stale reconcile error after a clean pass. A row in 'failed' keeps its reason (start timeout)
  // until the user starts it again. The state is read in the same statement, so a failStart that ran
  // earlier in this tick is seen as 'failed'.
  async function clearError(w: WorkspaceRow): Promise<void> {
    await db.query("update workspaces set last_error = null where id = $1 and last_error is not null and state <> 'failed'", [w.id]);
  }

  // Daily job (plan 5.2): removes .trash entries older than the retention period. Only while the workspace runs.
  // Failures are logged and retried on the next sweep, not recorded as last_error.
  const trashSweptAt = new Map<string, number>(); // workspace id -> time of the last sweep attempt
  async function sweepTrash(w: WorkspaceRow, now: Date): Promise<void> {
    const last = trashSweptAt.get(w.id);
    if (last !== undefined && now.getTime() - last < config.trashSweepMs) return;
    trashSweptAt.set(w.id, now.getTime());
    const cutoff = new Date(now.getTime() - config.trashRetentionMs);
    await ws.fs.purgeTrash(w.user_id, w.k8s_name, cutoff).catch((e) => log(`purge trash ${w.k8s_name}`, e));
  }

  return {
    async tick() {
      const now = clock.now();
      await admitQueued(now);
      const rows = (await db.query<WorkspaceRow>('select * from workspaces order by id')).rows;
      for (const w of rows) {
        try {
          await reconcile(w, now);
        } catch (e) {
          log(`reconcile ${w.k8s_name}`, e);
          await recordError(w, e).catch((err) => log(`record error ${w.k8s_name}`, err));
          continue;
        }
        if (w.last_error !== null) await clearError(w).catch((err) => log(`clear error ${w.k8s_name}`, err));
        if (w.state === 'running') await sweepTrash(w, now);
      }
      // Capacity that a stop freed during this tick goes to the queue now, not on the next tick.
      await admitQueued(now);
    },
  };
}

function defaultLog(msg: string, err?: unknown) {
  console.error(`[controller] ${msg}`, err);
}
