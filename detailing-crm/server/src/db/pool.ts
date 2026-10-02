import pg from 'pg';

const { Pool, types } = pg;

// Return BIGINT (COUNT(*), SUM over ints) and NUMERIC as JS numbers. Values in this app are far
// below 2^53, so this is lossless and saves string handling everywhere.
types.setTypeParser(types.builtins.INT8, (v) => Number(v));
types.setTypeParser(types.builtins.NUMERIC, (v) => Number(v));
// DATE and TIMESTAMP (without zone) stay as plain strings. The default parser turns them into a JS
// Date at *server-local* midnight, which silently shifts calendar dates across time zones.
types.setTypeParser(types.builtins.DATE, (v) => v);
types.setTypeParser(types.builtins.TIMESTAMP, (v) => v);

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

export function createPool(opts: { connectionString: string; max: number; ssl: boolean }): pg.Pool {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Guard against runaway queries holding connections forever.
    options: '-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000',
  });
  return pool;
}

export async function many<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(sql, params);
  return res.rows as T[];
}

export async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await db.query(sql, params);
  return res.rows[0] as T | undefined;
}

export async function exec(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const res = await db.query(sql, params);
  return res.rowCount ?? 0;
}

/** Runs fn inside a transaction on a dedicated connection; rolls back on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // connection is unusable; destroy it instead of returning it to the pool
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * Serialises booking writes within one organisation for the rest of the transaction, so two people
 * booking the same technician at the same moment cannot both pass the conflict check.
 */
export async function lockOrgBookings(client: pg.PoolClient, orgId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('bookings:' || $1::text))`, [orgId]);
}
