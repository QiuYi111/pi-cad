import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from './db.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

// Applies every migrations/*.sql not yet recorded in schema_migrations, in filename order.
// Each file runs in its own transaction. A session advisory lock serializes concurrent runners.
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const c = await db.connect();
  const applied: string[] = [];
  try {
    await c.query('select pg_advisory_lock(727001)');
    await c.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await c.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      await c.query('begin');
      try {
        await c.query(sql); // no params: simple protocol, multi-statement ok
        await c.query('insert into schema_migrations (name) values ($1)', [f]);
        await c.query('commit');
        applied.push(f);
      } catch (e) {
        await c.query('rollback');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
  return applied;
}
