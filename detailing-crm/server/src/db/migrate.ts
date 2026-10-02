import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db -> ../../migrations (works from both src/ via tsx and dist/ after build)
export const MIGRATIONS_DIR = path.resolve(here, '..', '..', 'migrations');

/**
 * Applies pending *.sql migrations in filename order, each in its own transaction.
 * A session-level advisory lock makes concurrent starts (several replicas booting at once) safe.
 */
export async function migrate(pool: Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('crm:migrations'))`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    );
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      log(`applying migration ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('crm:migrations'))`).catch(() => {});
    client.release();
  }
}
