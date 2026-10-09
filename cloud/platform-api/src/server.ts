import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadEnv } from './config.js';
import { createPool } from './db.js';
import { buildApp } from './app.js';
import { buildInternalApp } from './internal.js';
import { createController } from './workspace/controller.js';
import { createGatewayClient, createGatewayFs } from './workspace/gateway.js';
import { createKubeWorkspaceClient } from './workspace/k8s.js';
import { EventHub } from './workspace/events.js';
import type { WorkspaceDeps } from './workspace/ports.js';

const { databaseUrl, privateKeyPem, gatewayPrivateKeyPem, port, config } = loadEnv();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!privateKeyPem) throw new Error('JWT_PRIVATE_KEY (ES256 PEM) or JWT_PRIVATE_KEY_FILE is required');
if (!gatewayPrivateKeyPem) throw new Error('GATEWAY_PRIVATE_KEY (ES256 PEM) or GATEWAY_PRIVATE_KEY_FILE is required');

const privateKey = createPrivateKey(privateKeyPem);
const gatewayKey = createPrivateKey(gatewayPrivateKeyPem);
const db = createPool(databaseUrl);
const clock = { now: () => new Date() };
const deps = { db, keys: { privateKey, publicKey: createPublicKey(privateKey) }, clock, config };

const gateway = createGatewayClient({ key: gatewayKey, urlPattern: config.gatewayUrlPattern });
const workspace: WorkspaceDeps = {
  k8s: createKubeWorkspaceClient(config.workspaceNamespace),
  gateway,
  fs: createGatewayFs(gateway),
  events: new EventHub(),
  template: readFileSync(config.workspaceTemplatePath, 'utf8'),
};

const app = buildApp({ ...deps, workspace, logger: true });
const internal = buildInternalApp({ ...deps, logger: true });
const controller = createController({ ...deps, workspace });
const timer = setInterval(() => {
  controller.tick().catch((e: unknown) => console.error('[controller] tick failed', e));
}, config.controllerIntervalMs);

const stop = async () => {
  clearInterval(timer);
  await app.close();
  await internal.close();
  await db.end();
};
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
process.on('SIGINT', () => void stop().then(() => process.exit(0)));

await app.listen({ port, host: '0.0.0.0' });
// Cluster-internal only. The Caddy config and the Service have no route to this port from outside.
await internal.listen({ port: config.internalPort, host: '0.0.0.0' });
