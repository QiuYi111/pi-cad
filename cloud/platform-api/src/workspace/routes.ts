// HTTP routes for the workspace (plan 5.3). WebSocket routes are in bridge.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../deps.js';
import { getView, keepalive, startWorkspace, stopWorkspace } from './service.js';

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  d: Deps,
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get('/v1/workspace', { preHandler: requireUser }, async (req) => getView(d, req.userId!));

  app.post('/v1/workspace/start', { preHandler: requireUser }, async (req) => startWorkspace(d, req.userId!));

  app.post('/v1/workspace/stop', { preHandler: requireUser }, async (req) => stopWorkspace(d, req.userId!));

  app.post('/v1/workspace/keepalive', { preHandler: requireUser }, async (req) => keepalive(d, req.userId!));
}
