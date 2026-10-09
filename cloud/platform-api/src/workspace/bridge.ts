// WebSocket upgrades on the public port: the bridge proxy (plan 5.3, 7.2) and the user event stream.
// Access tokens come in the Authorization header. A failed check is answered on the raw socket before the upgrade.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { userIdFromAuth, type Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { touchActivity, workspaceForUser } from './service.js';
import type { WorkspaceDeps } from './ports.js';

export const BRIDGE_PATH = '/v1/workspace/bridge';
export const EVENTS_PATH = '/v1/events';

const STATUS_TEXT: Record<number, string> = {
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function rejectUpgrade(socket: Duplex, status: number, code: string) {
  const body = JSON.stringify({ code });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

export function attachWebSockets(
  server: { on(event: 'upgrade', fn: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown },
  d: Deps & { workspace: WorkspaceDeps },
): WebSocketServer[] {
  const bridgeWss = new WebSocketServer({ noServer: true });
  const eventsWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const run = async () => {
      if (path === BRIDGE_PATH) return handleBridge(req, socket, head);
      if (path === EVENTS_PATH) return handleEvents(req, socket, head);
      rejectUpgrade(socket, 404, 'not_found');
    };
    run().catch((e: unknown) => {
      if (e instanceof HttpError) rejectUpgrade(socket, e.status, e.code);
      else {
        console.error('[ws] upgrade failed', e);
        rejectUpgrade(socket, 500, 'internal');
      }
    });
  });

  async function handleBridge(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const userId = await userIdFromAuth(d, req.headers.authorization);
    const w = await workspaceForUser(d.db, userId);
    if (w.state !== 'running') throw new HttpError(409, 'workspace_not_running', '工作区未运行');
    let gateway: WebSocket;
    try {
      gateway = await d.workspace.gateway.connect(userId, w.k8s_name);
    } catch {
      throw new HttpError(502, 'gateway_unreachable', '工作区网关不可用');
    }
    bridgeWss.handleUpgrade(req, socket, head, (client) => {
      let lastTouch = 0;
      const touch = () => {
        const now = d.clock.now().getTime();
        if (now - lastTouch < d.config.bridgeTouchMs) return;
        lastTouch = now;
        touchActivity(d, w.id, d.config.bridgeTouchMs).catch((e) => console.error('[ws] activity write failed', e));
      };
      touch();
      client.on('message', (data: RawData, isBinary: boolean) => {
        touch();
        if (gateway.readyState === WebSocket.OPEN) gateway.send(data, { binary: isBinary });
      });
      gateway.on('message', (data: RawData, isBinary: boolean) => {
        touch();
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      // Either side closing closes the other. The gateway keeps spawned processes running on its own.
      client.on('close', () => gateway.close());
      gateway.on('close', () => client.close());
      client.on('error', () => gateway.close());
      gateway.on('error', () => client.close());
    });
  }

  async function handleEvents(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const userId = await userIdFromAuth(d, req.headers.authorization);
    eventsWss.handleUpgrade(req, socket, head, (client) => {
      const off = d.workspace.events.subscribe(userId, (event) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
      });
      client.on('close', off);
      client.on('error', () => client.close());
      // Current state right away, so the client does not wait for the next change.
      void workspaceForUser(d.db, userId)
        .then((w) => {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'workspace_state', state: w.state }));
        })
        .catch(() => client.close());
    });
  }

  return [bridgeWss, eventsWss];
}
