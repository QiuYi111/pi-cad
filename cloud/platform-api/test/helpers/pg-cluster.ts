// Throwaway PostgreSQL cluster for tests. Uses env TEST_DATABASE_URL (an existing server, e.g. CI services) when set;
// otherwise initdb + pg_ctl in a temp dir on a random port with a unix socket in that dir.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPool, type Db } from '../../src/db.js';
import { migrate } from '../../src/migrate.js';

const PG_BIN = process.env.PG_BIN_DIR ?? '/usr/lib/postgresql/16/bin';
const bin = (name: string) => (existsSync(join(PG_BIN, name)) ? join(PG_BIN, name) : name);

function sh(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args.join(' ')} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

// initdb and pg_ctl refuse to run as root, so run them as the postgres user when we are root.
const asPostgres = (file: string, args: string[]): [string, string[]] =>
  process.getuid?.() === 0 ? ['runuser', ['-u', 'postgres', '--', file, ...args]] : [file, args];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export interface Cluster {
  adminUrl: string; // connects to the 'postgres' database
  stop(): Promise<void>;
}

export async function startCluster(): Promise<Cluster> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) return { adminUrl: external, stop: async () => {} };

  const dir = await mkdtemp(join(tmpdir(), 'reify-pg-'));
  const data = join(dir, 'data');
  const log = join(dir, 'server.log');
  const port = await freePort();
  const isRoot = process.getuid?.() === 0;
  if (isRoot) await sh('chown', ['postgres', dir]);

  const [i, ia] = asPostgres(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync']);
  await sh(i, ia);
  const opts = `-p ${port} -k ${dir} -c listen_addresses= -c fsync=off -c synchronous_commit=off -c max_connections=200`;
  const [s, sa] = asPostgres(bin('pg_ctl'), ['-D', data, '-l', log, '-w', '-o', opts, 'start']);
  try {
    await sh(s, sa);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  // The port must be in the URL too: the client derives the socket file name (.s.PGSQL.<port>) from it.
  const adminUrl = `postgres://postgres@localhost:${port}/postgres?host=${encodeURIComponent(dir)}`;
  return {
    adminUrl,
    stop: async () => {
      const [t, ta] = asPostgres(bin('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop']);
      await sh(t, ta).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface TestDb {
  url: string;
  db: Db;
  drop(): Promise<void>;
}

// Fresh, migrated database on the given server.
export async function createTestDb(adminUrl: string): Promise<TestDb> {
  const name = 't_' + randomBytes(8).toString('hex');
  const admin = createPool(adminUrl, 1);
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  u.pathname = '/' + name;
  const url = u.toString();
  const db = createPool(url, 8);
  await migrate(db);
  return {
    url,
    db,
    drop: async () => {
      await db.end();
      const a = createPool(adminUrl, 1);
      try {
        await a.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}
