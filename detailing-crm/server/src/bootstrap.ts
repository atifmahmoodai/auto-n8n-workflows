import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import { one, withTx, type Pool } from './db/pool.js';
import { hashPassword } from './lib/crypto.js';

/**
 * Optional unattended first-run setup: when BOOTSTRAP_ADMIN_EMAIL/PASSWORD are set and the database
 * has no organisation yet, create one with that owner. Without these variables, the first visitor
 * completes setup in the browser instead.
 */
export async function bootstrap(pool: Pool, config: Config, log: FastifyBaseLogger): Promise<void> {
  if (!config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) return;
  const email = config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
  const password = config.BOOTSTRAP_ADMIN_PASSWORD;
  await withTx(pool, async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('crm:signup'))`);
    const orgs = await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM organizations');
    if ((orgs?.n ?? 0) > 0) return;
    const org = await one<{ id: string }>(tx, 'INSERT INTO organizations (name) VALUES ($1) RETURNING id', [
      config.BOOTSTRAP_ORG_NAME ?? 'My Detailing Business',
    ]);
    await tx.query(`INSERT INTO users (org_id, name, email, role, password_hash) VALUES ($1, $2, $3, 'owner', $4)`, [
      org!.id,
      config.BOOTSTRAP_ADMIN_NAME,
      email,
      await hashPassword(password),
    ]);
    log.info({ email }, 'created first organisation and owner account from BOOTSTRAP_* settings');
  });
}
