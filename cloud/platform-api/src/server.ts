import { createPrivateKey, createPublicKey } from 'node:crypto';
import { loadEnv } from './config.js';
import { createPool } from './db.js';
import { buildApp } from './app.js';

const { databaseUrl, privateKeyPem, port, config } = loadEnv();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!privateKeyPem) throw new Error('JWT_PRIVATE_KEY (ES256 PEM) or JWT_PRIVATE_KEY_FILE is required');

const privateKey = createPrivateKey(privateKeyPem);
const db = createPool(databaseUrl);
const app = buildApp({
  db,
  keys: { privateKey, publicKey: createPublicKey(privateKey) },
  clock: { now: () => new Date() },
  config,
  logger: true,
});

const stop = async () => {
  await app.close();
  await db.end();
};
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
process.on('SIGINT', () => void stop().then(() => process.exit(0)));

await app.listen({ port, host: '0.0.0.0' });
