import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

/**
 * Database access.
 *
 * THE RULE (module1.md §4.1): every tenant-scoped query goes through `withTenant`.
 * Nothing else opens a connection. `DB-001` in scripts/verify-invariants.mjs fails the
 * build on a raw `new Pool(` outside this package, because the one thing that breaks
 * isolation is a query path that skips the tenant context.
 */

export type Db = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let appPool: pg.Pool | undefined;
let systemPool: pg.Pool | undefined;

export interface PoolConfig {
  /** Least-privilege application role. MUST NOT be a superuser. */
  appUrl?: string;
  /** Owner connection. Migrations and provisioning only. */
  systemUrl?: string;
  max?: number;
}

function makePool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString, max, application_name: 'vega' });
}

export function getAppPool(config: PoolConfig = {}): pg.Pool {
  if (!appPool) {
    const url =
      config.appUrl ?? process.env['DATABASE_APP_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_APP_URL (or DATABASE_URL) is not set');
    appPool = makePool(url, config.max ?? 10);
  }
  return appPool;
}

export function getSystemPool(config: PoolConfig = {}): pg.Pool {
  if (!systemPool) {
    const url = config.systemUrl ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is not set');
    systemPool = makePool(url, config.max ?? 4);
  }
  return systemPool;
}

/**
 * Refuses to proceed if the application is connected as a superuser.
 *
 * This is not paranoia. PostgreSQL bypasses RLS entirely for superusers — even with
 * FORCE ROW LEVEL SECURITY. An app running as `postgres` has perfect-looking policies and
 * zero isolation, and every test that connects the same way passes. Checking at startup is
 * the difference between finding that in CI and finding it in production.
 */
export async function assertNotSuperuser(pool: pg.Pool = getAppPool()): Promise<void> {
  const { rows } = await pool.query<{ current_user: string; is_super: boolean }>(
    `SELECT current_user, (SELECT usesuper FROM pg_user WHERE usename = current_user) AS is_super`,
  );
  const row = rows[0];
  if (!row) throw new Error('could not determine current database role');
  if (row.is_super) {
    throw new Error(
      `FATAL: connected as superuser "${row.current_user}". PostgreSQL bypasses RLS for ` +
        `superusers even with FORCE ROW LEVEL SECURITY, so tenant isolation would be ` +
        `silently absent. Use DATABASE_APP_URL (role vega_app).`,
    );
  }
}

/**
 * Runs `fn` inside a transaction with the tenant context set.
 *
 * The context is set with `set_config($1, $2, true)` rather than `SET LOCAL`, because
 * `SET LOCAL` cannot take a bind parameter — it would require interpolating the tenant id
 * into SQL text. `set_config` is parameterised, so a hostile tenant id is a value, never
 * syntax. The id is also shape-checked first; both together mean a request-supplied value
 * can never alter the statement.
 *
 * `true` scopes the setting to the transaction, so it cannot leak across pooled connections.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (db: Db) => Promise<T>,
  pool: pg.Pool = getAppPool(),
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`withTenant: invalid tenant id (expected uuid, got ${JSON.stringify(tenantId)})`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['vega.tenant_id', tenantId]);
    const db = drizzle(client, { schema });
    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* the original error is the one worth propagating */
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Owner connection with NO tenant context. RLS does not constrain it.
 *
 * The name is deliberately uncomfortable. Legitimate uses are provisioning a new tenant
 * (which by definition has no context yet), migrations, and reference data. Everything
 * else is a bug — reach for `withTenant` instead.
 */
export async function withSystemBypassingRls<T>(
  fn: (db: Db) => Promise<T>,
  pool: pg.Pool = getSystemPool(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const db = drizzle(client, { schema });
    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* preserve the original error */
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await appPool?.end();
  await systemPool?.end();
  appPool = undefined;
  systemPool = undefined;
}

export { schema };
export type { Pool } from 'pg';
