import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/crm_test';

/** Rebuilds the test database schema from the migrations, so tests always run on a clean schema. */
export default async function setup() {
  const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 2, ssl: false });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
