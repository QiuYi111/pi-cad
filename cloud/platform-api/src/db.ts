import pg from 'pg';

export type Db = pg.Pool;

export const createPool = (connectionString: string, max = 10) => new pg.Pool({ connectionString, max });

// Runs fn inside BEGIN/COMMIT on one client. A throw rolls back; a normal return commits.
export async function withTx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';
