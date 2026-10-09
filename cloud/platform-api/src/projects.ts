// Projects (plan 5.2). Membership is in project_members. Patch and delete need the maintainer role.
// Filesystem changes go through the gateway only while the workspace is running. Otherwise the controller
// passes the project ids to the entrypoint at the next start.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from './deps.js';
import { HttpError, badRequest } from './errors.js';
import { workspaceForUser } from './workspace/service.js';
import type { WorkspaceDeps } from './workspace/ports.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 100;

function projectName(v: unknown): string {
  if (typeof v !== 'string') throw badRequest('invalid_input', '项目名必须是字符串');
  const name = v.trim();
  if (name.length === 0 || [...name].length > MAX_NAME) throw badRequest('invalid_input', `项目名需要 1 到 ${MAX_NAME} 个字符`);
  return name;
}

async function memberRole(d: Deps, projectId: string, userId: string): Promise<'maintainer' | 'editor' | 'viewer'> {
  const r = await d.db.query<{ role: 'maintainer' | 'editor' | 'viewer' }>(
    `select pm.role from project_members pm join projects p on p.id = pm.project_id
      where pm.project_id = $1 and pm.user_id = $2 and p.deleted_at is null`,
    [projectId, userId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'not_found', '没有这个项目');
  return r.rows[0].role;
}

// Runs a filesystem change only when the workspace is running. A failure is logged. The database stays the source of truth.
async function whenRunning(
  d: Deps,
  workspace: WorkspaceDeps | undefined,
  userId: string,
  log: (msg: string, err: unknown) => void,
  fn: (k8sName: string) => Promise<void>,
): Promise<void> {
  if (!workspace) return;
  const w = await workspaceForUser(d.db, userId).catch(() => null);
  if (!w || w.state !== 'running') return;
  await fn(w.k8s_name).catch((e: unknown) => log('workspace filesystem change failed', e));
}

export function registerProjectRoutes(
  app: FastifyInstance,
  d: Deps,
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
  workspace?: WorkspaceDeps,
): void {
  const warn = (msg: string, err: unknown) => app.log.warn({ err }, msg);
  const idParam = (req: FastifyRequest): string => {
    const id = (req.params as { id?: string }).id ?? '';
    if (!UUID_RE.test(id)) throw new HttpError(404, 'not_found', '没有这个项目');
    return id;
  };

  app.get('/v1/projects', { preHandler: requireUser }, async (req) => {
    const r = await d.db.query<{ id: string; name: string; role: string; created_at: Date }>(
      `select p.id, p.name, pm.role, p.created_at from projects p
         join project_members pm on pm.project_id = p.id
        where pm.user_id = $1 and p.deleted_at is null order by p.created_at, p.id`,
      [req.userId],
    );
    return { projects: r.rows.map((p) => ({ id: p.id, name: p.name, role: p.role, createdAt: p.created_at })) };
  });

  app.post('/v1/projects', { preHandler: requireUser }, async (req, reply) => {
    const name = projectName((req.body as { name?: unknown } | undefined)?.name);
    const userId = req.userId!;
    const now = d.clock.now();
    const team = await d.db.query<{ team_id: string }>(
      "select team_id from team_members where user_id = $1 and role = 'owner' order by team_id limit 1",
      [userId],
    );
    if (!team.rows[0]) throw new HttpError(500, 'internal', '个人团队不存在');
    const client = await d.db.connect();
    let id: string;
    try {
      await client.query('begin');
      id = (
        await client.query<{ id: string }>(
          'insert into projects (team_id, name, created_by, created_at) values ($1, $2, $3, $4) returning id',
          [team.rows[0].team_id, name, userId, now],
        )
      ).rows[0].id;
      await client.query("insert into project_members (project_id, user_id, role) values ($1, $2, 'maintainer')", [id, userId]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await whenRunning(d, workspace, userId, warn, (k8sName) => workspace!.fs.mkdirProjects(userId, k8sName, [id]));
    return reply.code(201).send({ id, name, role: 'maintainer', createdAt: now });
  });

  app.patch('/v1/projects/:id', { preHandler: requireUser }, async (req) => {
    const id = idParam(req);
    const userId = req.userId!;
    if ((await memberRole(d, id, userId)) !== 'maintainer') throw new HttpError(403, 'forbidden', '只有维护者可以改名');
    const name = projectName((req.body as { name?: unknown } | undefined)?.name);
    const r = await d.db.query<{ id: string; name: string; created_at: Date }>(
      'update projects set name = $2 where id = $1 returning id, name, created_at',
      [id, name],
    );
    return { id: r.rows[0].id, name: r.rows[0].name, role: 'maintainer', createdAt: r.rows[0].created_at };
  });

  app.delete('/v1/projects/:id', { preHandler: requireUser }, async (req, reply) => {
    const id = idParam(req);
    const userId = req.userId!;
    if ((await memberRole(d, id, userId)) !== 'maintainer') throw new HttpError(403, 'forbidden', '只有维护者可以删除');
    const now = d.clock.now();
    // Soft delete. The folders move to .trash, and a cleanup job removes them after 30 days (plan 5.2).
    await d.db.query('update projects set deleted_at = $2 where id = $1 and deleted_at is null', [id, now]);
    const stamp = now.toISOString().replace(/[-:.]/g, '');
    await whenRunning(d, workspace, userId, warn, (k8sName) => workspace!.fs.trashProject(userId, k8sName, id, stamp));
    return reply.code(204).send();
  });
}
