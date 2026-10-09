// Talks to a workspace gateway (plan 7.2). Every connection carries a fresh 60 s ES256 gateway token.
import WebSocket from 'ws';
import { SignJWT } from 'jose';
import type { KeyLike } from '../deps.js';
import type { ExecResult, WorkspaceFs, WorkspaceGateway } from './ports.js';

export const GATEWAY_TOKEN_HEADER = 'x-reify-gateway-token';
export const GATEWAY_TOKEN_TTL_SEC = 60;

export interface GatewayOptions {
  key: KeyLike; // ES256 private key. The gateways hold the matching public key.
  urlPattern: string; // ws://{name}.reify-ws.svc:7000/ ; {name} is the workspace k8s name
}

export async function mintGatewayToken(key: KeyLike, userId: string, k8sName: string): Promise<string> {
  // The gateway checks iat and exp against the real clock, so this uses Date.now and not the injected clock.
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ ws: k8sName })
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(userId)
    .setAudience('ws-gateway')
    .setIssuedAt(iat)
    .setExpirationTime(iat + GATEWAY_TOKEN_TTL_SEC)
    .sign(key);
}

export function createGatewayClient(opts: GatewayOptions): WorkspaceGateway {
  const urlOf = (name: string) => opts.urlPattern.replace('{name}', name);

  async function connect(userId: string, name: string): Promise<WebSocket> {
    const token = await mintGatewayToken(opts.key, userId, name);
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(urlOf(name), { headers: { [GATEWAY_TOKEN_HEADER]: token }, handshakeTimeout: 5000 });
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => {
        ws.terminate();
        reject(new Error(`gateway answered HTTP ${res.statusCode}`));
      });
      // Stays attached after open, so a later socket error never goes unhandled. Rejecting an open promise does nothing.
      ws.on('error', reject);
    });
  }

  return {
    connect,

    async healthz(name: string): Promise<boolean> {
      const url = new URL(urlOf(name));
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = '/healthz';
      url.search = '';
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    },

    async shutdown(userId: string, name: string): Promise<void> {
      const ws = await connect(userId, name);
      ws.send(JSON.stringify({ type: 'shutdown' }));
      ws.close(); // the gateway acts on the message before it sees the close frame
    },

    async exec(userId: string, name: string, args: string[]): Promise<ExecResult> {
      const ws = await connect(userId, name);
      try {
        return await new Promise<ExecResult>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('gateway exec timed out')), 30_000);
          ws.on('message', (data, isBinary) => {
            if (isBinary) return;
            const msg = JSON.parse(data.toString()) as { type: string; ch?: number; stdout?: string; stderr?: string; code?: number | null; message?: string };
            if (msg.type === 'exec_result' && msg.ch === 1) {
              clearTimeout(timer);
              resolve({ stdout: msg.stdout ?? '', stderr: msg.stderr ?? '', code: msg.code ?? null });
            } else if (msg.type === 'error' && (msg.ch === 1 || msg.ch === undefined)) {
              clearTimeout(timer);
              reject(new Error(`gateway: ${msg.message ?? msg.code}`));
            }
          });
          ws.on('close', () => {
            clearTimeout(timer);
            reject(new Error('gateway closed before answering'));
          });
          ws.send(JSON.stringify({ type: 'exec', ch: 1, args }));
        });
      } finally {
        ws.close();
      }
    },
  };
}

// Trash entries are named <projectId>-<stamp> (and <projectId>-<stamp>-state), where stamp is the UTC time
// from trashProject: 20261009T051234123Z. Returns that time, or null for any other name. Names that do not
// match are never deleted.
const TRASH_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z(-state)?$/i;

export function trashEntryTime(name: string): Date | null {
  const m = TRASH_NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1, 8).map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
}

// File operations as exec calls through the gateway. Arguments are passed as argv, never through a shell string.
export function createGatewayFs(gateway: WorkspaceGateway): WorkspaceFs {
  const check = (r: ExecResult, what: string) => {
    if (r.code !== 0) throw new Error(`${what} failed (code ${r.code}): ${r.stderr.trim()}`);
  };
  return {
    async mkdirProjects(userId, k8sName, projectIds) {
      if (projectIds.length === 0) return;
      const paths = projectIds.flatMap((id) => [`/workspace/projects/${id}`, `/workspace/state/${id}`]);
      check(await gateway.exec(userId, k8sName, ['mkdir', '-p', ...paths]), 'mkdir');
    },
    async trashProject(userId, k8sName, projectId, stamp) {
      // Moves the project folder and its state folder into .trash. Missing folders are fine.
      const script =
        'set -e; mkdir -p /workspace/.trash; ' +
        'if [ -e "$1" ]; then mv "$1" "$2"; fi; ' +
        'if [ -e "$3" ]; then mv "$3" "$4"; fi';
      const trash = `/workspace/.trash/${projectId}-${stamp}`;
      check(
        await gateway.exec(userId, k8sName, [
          'sh',
          '-c',
          script,
          'sh',
          `/workspace/projects/${projectId}`,
          trash,
          `/workspace/state/${projectId}`,
          `${trash}-state`,
        ]),
        'trash',
      );
    },
    async purgeTrash(userId, k8sName, cutoff) {
      // The shell only lists the directory. Deciding and deleting happen here, one argv per entry.
      const listed = await gateway.exec(userId, k8sName, ['sh', '-c', '[ -d /workspace/.trash ] && ls -1A /workspace/.trash || true']);
      check(listed, 'list trash');
      const old = listed.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((name) => {
          const t = trashEntryTime(name);
          return t !== null && t.getTime() < cutoff.getTime();
        });
      for (const name of old) {
        check(await gateway.exec(userId, k8sName, ['rm', '-rf', '--', `/workspace/.trash/${name}`]), 'purge trash');
      }
      return old.length;
    },
  };
}
