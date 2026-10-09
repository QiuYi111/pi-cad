import { createPool } from './db.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createPool(url, 2);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
} finally {
  await db.end();
}
