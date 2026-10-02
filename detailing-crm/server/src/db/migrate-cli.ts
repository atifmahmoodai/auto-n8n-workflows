import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const config = loadConfig();
const pool = createPool({ connectionString: config.DATABASE_URL, max: 1, ssl: config.DATABASE_SSL });
try {
  const applied = await migrate(pool, (m) => console.warn(m));
  console.warn(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
