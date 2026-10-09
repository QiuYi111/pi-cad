import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { changePassword, login, logout, refresh, register, resetPassword } from './auth.js';
import { INVITE_MESSAGES, getInvite } from './invites.js';
import { HttpError } from './errors.js';
import { verifyAccess, type Deps } from './deps.js';
import { invitePage, resetPage } from './pages.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | null;
  }
}

// Client address. With trustProxy, the first X-Forwarded-For entry (set by Tailscale Funnel / Caddy); else the socket peer.
export function clientIp(req: FastifyRequest, trustProxy: boolean): string | null {
  let ip: string | undefined;
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    ip = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  }
  ip ||= req.socket.remoteAddress;
  ip = ip?.replace(/^::ffff:/, '');
  return ip && isIP(ip) ? ip : null;
}

const HTML_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export function buildApp(d: Deps & { logger?: boolean }): FastifyInstance {
  const app = Fastify({ logger: d.logger ?? false, bodyLimit: 64 * 1024 });
  app.decorateRequest('userId', null);

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ code: err.code, message: err.message, ...err.extra });
    }
    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ code: 'bad_request', message: '请求格式不正确' });
    }
    req.log.error(err);
    return reply.code(500).send({ code: 'internal', message: '服务器内部错误' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'not_found', message: '未找到' }));

  // preHandler for protected routes: verifies the access token and that the user is still active.
  const requireUser = async (req: FastifyRequest, _reply: FastifyReply) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw new HttpError(401, 'unauthorized', '请先登录');
    const uid = await verifyAccess(d, m[1]);
    const r = await d.db.query<{ status: string }>('select status from users where id = $1', [uid]);
    if (r.rows[0]?.status !== 'active') throw new HttpError(401, 'unauthorized', '账户已停用');
    req.userId = uid;
  };
  app.decorate('requireUser', requireUser);

  const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});
  const ipOf = (req: FastifyRequest) => clientIp(req, d.config.trustProxy);

  app.get('/v1/healthz', async () => {
    await d.db.query('select 1');
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>('/v1/invites/:token', async (req) => {
    const r = await getInvite(d, req.params.token);
    return r.valid ? r : { ...r, message: INVITE_MESSAGES[r.reason!] };
  });

  app.post('/v1/auth/register', async (req, reply) => {
    const b = body(req);
    return reply.code(201).send(await register(d, { ...b, ip: ipOf(req) }));
  });

  app.post('/v1/auth/login', async (req) => login(d, { ...body(req), ip: ipOf(req) }));

  app.post('/v1/auth/refresh', async (req) => refresh(d, body(req)));

  app.post('/v1/auth/logout', async (req, reply) => {
    await logout(d, body(req));
    return reply.code(204).send();
  });

  app.post('/v1/auth/password', { preHandler: requireUser }, async (req, reply) => {
    await changePassword(d, req.userId!, body(req));
    return reply.code(204).send();
  });

  app.post('/v1/auth/reset', async (req, reply) => {
    await resetPassword(d, body(req));
    return reply.code(204).send();
  });

  app.get('/v1/me', { preHandler: requireUser }, async (req) => {
    const r = await d.db.query<{ id: string; email: string; display_name: string | null }>(
      'select id, email, display_name from users where id = $1',
      [req.userId],
    );
    const u = r.rows[0];
    return { id: u.id, email: u.email, displayName: u.display_name };
  });

  app.get<{ Params: { token: string } }>('/invite/:token', async (_req, reply) =>
    reply.headers(HTML_HEADERS).type('text/html; charset=utf-8').send(invitePage(d.config.downloadUrl)),
  );

  app.get('/reset/:token', async (_req, reply) =>
    reply.headers(HTML_HEADERS).type('text/html; charset=utf-8').send(resetPage()),
  );

  return app;
}
