// Internal API (plan 7.4). Served on its own port (INTERNAL_PORT, 8081). Caddy never routes to it, and the
// public app has no /internal routes, so it answers 404 there. Each workspace authenticates with its own token.
import Fastify, { type FastifyInstance } from 'fastify';
import type { Deps } from './deps.js';
import { safeEqual, sha256 } from './crypto.js';
import { HttpError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildInternalApp(d: Deps & { logger?: boolean }): FastifyInstance {
  const app = Fastify({ logger: d.logger ?? false, bodyLimit: 4 * 1024 });
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ code: err.code, message: err.message });
    if (typeof err.statusCode === 'number' && err.statusCode < 500) return reply.code(400).send({ code: 'bad_request', message: '请求格式不正确' });
    req.log.error(err);
    return reply.code(500).send({ code: 'internal', message: '服务器内部错误' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'not_found', message: '未找到' }));

  // POST /internal/workspaces/:id/activity {active, reason}. The gateway reports every 60 s (plan 7.4).
  app.post<{ Params: { id: string } }>('/internal/workspaces/:id/activity', async (req, reply) => {
    const id = req.params.id;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    // Same answer for an unknown workspace and a wrong token, so the endpoint reveals nothing.
    const unauthorized = () => new HttpError(401, 'unauthorized', 'token 无效');
    if (!m || !UUID_RE.test(id)) throw unauthorized();
    const r = await d.db.query<{ activity_token_hash: Buffer | null }>('select activity_token_hash from workspaces where id = $1', [id]);
    const stored = r.rows[0]?.activity_token_hash;
    if (!stored || !safeEqual(stored, sha256(m[1]))) throw unauthorized();

    const body = (req.body ?? {}) as { active?: unknown; reason?: unknown };
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'invalid_input', 'active 必须是布尔值');
    if (body.active) {
      await d.db.query('update workspaces set last_activity_at = $2, idle_warned_at = null where id = $1', [id, d.clock.now()]);
    }
    return reply.code(204).send();
  });

  return app;
}
