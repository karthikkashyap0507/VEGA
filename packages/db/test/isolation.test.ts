import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { seed, type SeedResult } from '../src/seed.js';

/**
 * ADVERSARIAL CROSS-TENANT SUITE — the definition of done for Module 1 Step 2.
 *
 * The question this answers is not "is RLS switched on". It is: given a valid connection
 * scoped to tenant A, and the exact primary key of a tenant B row, can anything be read,
 * changed, or destroyed? Every table, every operation.
 *
 * These run on the APPLICATION role (vega_app). Running them as the owner or a superuser
 * would pass trivially and prove nothing — PostgreSQL bypasses RLS for superusers even
 * with FORCE ROW LEVEL SECURITY.
 */

const SYSTEM_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const APP_URL = process.env['DATABASE_APP_URL'] ?? 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';

/**
 * (table, column holding the row's own id, column holding the tenant). `appendOnly` tables are
 * records nobody rewrites: the application role holds no UPDATE/DELETE grant at all, which is
 * asserted as a refusal (stronger than "zero rows"). `shared` names rows every tenant may READ
 * (platform defaults, tenant_id NULL) — never write.
 */
const TENANT_TABLES: Array<{ table: string; idColumn: string; tenantColumn: string; appendOnly?: boolean; shared?: string }> = [
  { table: 'tenants', idColumn: 'id', tenantColumn: 'id' },
  { table: 'users', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'workspaces', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'agents', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'secret_refs', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'platform_events', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'workspace_members', idColumn: 'workspace_id', tenantColumn: 'tenant_id' },
  { table: 'sessions', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'idempotency_keys', idColumn: 'key', tenantColumn: 'tenant_id' },
  { table: 'connectors', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'tool_invocations', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'connector_events', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'mcp_tools', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'sources', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'derivations', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'taint_violations', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'programs', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'trusted_contacts', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'runs', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'task_nodes', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'actions', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'replans', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'agent_versions', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'conversations', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'conversation_messages', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'trigger_fires', idColumn: 'agent_id', tenantColumn: 'tenant_id' },
  { table: 'webhook_endpoints', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'webhook_deliveries', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'policies', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'policy_bundles', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'policy_simulations', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'classifications', idColumn: 'id', tenantColumn: 'tenant_id' },
  { table: 'policy_evaluations', idColumn: 'id', tenantColumn: 'tenant_id', appendOnly: true },
  { table: 'risk_evaluations', idColumn: 'id', tenantColumn: 'tenant_id', appendOnly: true },
  { table: 'risk_weights', idColumn: 'version', tenantColumn: 'tenant_id', appendOnly: true, shared: 'tenant_id IS NULL' },
];

let appPool: pg.Pool;
let systemPool: pg.Pool;
let ids: SeedResult;

/** Runs a callback on a connection scoped to `tenantId`, exactly as withTenant does. */
async function asTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['vega.tenant_id', tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {
      /* the assertion result is what matters */
    });
    client.release();
  }
}

/** Every id belonging to tenant B, read on the owner connection where RLS does not apply. */
async function idsOf(table: string, idColumn: string, tenantColumn: string, tenantId: string) {
  const { rows } = await systemPool.query<{ id: string }>(
    `SELECT ${idColumn}::text AS id FROM ${table} WHERE ${tenantColumn} = $1`,
    [tenantId],
  );
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  await migrate(SYSTEM_URL);
  systemPool = new pg.Pool({ connectionString: SYSTEM_URL });
  ids = await seed(SYSTEM_URL);
  appPool = new pg.Pool({ connectionString: APP_URL });
}, 60_000);

afterAll(async () => {
  await appPool?.end();
  await systemPool?.end();
});

describe('preconditions', () => {
  // If either of these is wrong, every test below passes for the wrong reason.
  it('the application role is NOT a superuser', async () => {
    const { rows } = await appPool.query<{ is_super: boolean; who: string }>(
      `SELECT current_user AS who,
              (SELECT usesuper FROM pg_user WHERE usename = current_user) AS is_super`,
    );
    expect(rows[0]?.who).toBe('vega_app');
    expect(rows[0]?.is_super).toBe(false);
  });

  it('every tenant-scoped table has RLS enabled AND forced', async () => {
    const { rows } = await systemPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname = ANY($1)`,
      [TENANT_TABLES.map((t) => t.table)],
    );
    expect(rows).toHaveLength(TENANT_TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname}: RLS not enabled`).toBe(true);
      // Without FORCE, the owner bypasses every policy on this table.
      expect(row.relforcerowsecurity, `${row.relname}: RLS not FORCED`).toBe(true);
    }
  });

  it('the two seeded tenants both hold data in every table', async () => {
    for (const { table, idColumn, tenantColumn } of TENANT_TABLES) {
      const a = await idsOf(table, idColumn, tenantColumn, ids.tenantA);
      const b = await idsOf(table, idColumn, tenantColumn, ids.tenantB);
      // Identically-shaped data on both sides: otherwise a passing isolation test might
      // only mean tenant B had nothing to find.
      expect(a.length, `${table}: tenant A has no rows`).toBeGreaterThan(0);
      expect(b.length, `${table}: tenant B has no rows`).toBeGreaterThan(0);
    }
  });
});

describe.each(TENANT_TABLES)('$table — cross-tenant access', ({ table, idColumn, tenantColumn, appendOnly, shared }) => {
  it('SELECT by primary key returns nothing', async () => {
    const victims = await idsOf(table, idColumn, tenantColumn, ids.tenantB);
    await asTenant(ids.tenantA, async (c) => {
      for (const victim of victims) {
        const { rows } = await c.query(
          `SELECT * FROM ${table} WHERE ${idColumn}::text = $1`,
          [victim],
        );
        expect(rows, `${table}: leaked row ${victim}`).toHaveLength(0);
      }
    });
  });

  it('an unqualified SELECT returns only this tenant', async () => {
    const mine = await idsOf(table, idColumn, tenantColumn, ids.tenantA);
    const common = shared ? (await systemPool.query<{ id: string }>(`SELECT ${idColumn}::text AS id FROM ${table} WHERE ${shared}`)).rows.map((r) => r.id) : [];
    await asTenant(ids.tenantA, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT ${idColumn}::text AS id FROM ${table}`,
      );
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([...mine, ...common]));
    });
  });

  it('UPDATE affects zero rows', async () => {
    const victims = await idsOf(table, idColumn, tenantColumn, ids.tenantB);
    await asTenant(ids.tenantA, async (c) => {
      for (const victim of victims) {
        const update = c.query(
          `UPDATE ${table} SET ${tenantColumn} = ${tenantColumn} WHERE ${idColumn}::text = $1`,
          [victim],
        );
        if (appendOnly) {
          await expect(update, `${table}: append-only, yet UPDATE was permitted`).rejects.toThrow(/permission denied/);
          return;
        }
        expect((await update).rowCount, `${table}: updated foreign row ${victim}`).toBe(0);
      }
    });
  });

  it('DELETE affects zero rows', async () => {
    const victims = await idsOf(table, idColumn, tenantColumn, ids.tenantB);
    await asTenant(ids.tenantA, async (c) => {
      for (const victim of victims) {
        const del = c.query(`DELETE FROM ${table} WHERE ${idColumn}::text = $1`, [victim]);
        if (appendOnly) {
          await expect(del, `${table}: append-only, yet DELETE was permitted`).rejects.toThrow(/permission denied/);
          return;
        }
        expect((await del).rowCount, `${table}: deleted foreign row ${victim}`).toBe(0);
      }
    });
    // and the rows are still there afterwards
    const survivors = await idsOf(table, idColumn, tenantColumn, ids.tenantB);
    expect(survivors.length).toBeGreaterThan(0);
  });
});

describe('write-side isolation (WITH CHECK)', () => {
  // USING alone filters reads. Without WITH CHECK, tenant A can INSERT rows *into* tenant B —
  // the direction most RLS write-ups forget.
  it('cannot INSERT a row belonging to another tenant', async () => {
    await expect(
      asTenant(ids.tenantA, (c) =>
        c.query(
          `INSERT INTO platform_events (tenant_id, kind, payload)
           VALUES ($1, 'intrusion.attempt', '{}'::jsonb)`,
          [ids.tenantB],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot re-parent one of its own rows into another tenant', async () => {
    await expect(
      asTenant(ids.tenantA, (c) =>
        c.query(`UPDATE users SET tenant_id = $1 WHERE tenant_id = $2`, [
          ids.tenantB,
          ids.tenantA,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('tenant context cannot be forged', () => {
  it('no context means no rows, not all rows (fail-closed)', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM users');
      expect(rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('a blank tenant context yields no rows and does not raise', async () => {
    // A naive `current_setting(...)::uuid` raises 22P02 on an empty string. The NULLIF in
    // current_tenant_id() is what keeps this a clean zero-row result.
    await asTenantRaw('', async (c) => {
      const { rows } = await c.query('SELECT * FROM users');
      expect(rows).toHaveLength(0);
    });
  });

  it('a hostile tenant id is treated as a value, never as SQL', async () => {
    // set_config is parameterised, so the payload lands as a *string* that then fails to
    // cast to uuid. The failure mode is a cast error, not a `1=1` predicate — which is the
    // property being asserted here.
    //
    // Erroring is deliberate rather than returning zero rows. A malformed context can only
    // reach the database if something bypassed withTenant(), and that is a bug worth
    // surfacing loudly. It is still fail-closed: the statement aborts and returns nothing.
    await expect(
      asTenantRaw("' OR '1'='1", async (c) => {
        await c.query('SELECT * FROM users');
      }),
    ).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  it('withTenant refuses a malformed tenant id before it reaches the database', async () => {
    // The shape check in withTenant is the first line of defence; the cast error above is
    // the second. Both exist because either one alone is a single point of failure.
    const { withTenant } = await import('../src/client.js');
    for (const bad of ["' OR '1'='1", '', 'not-a-uuid', '../../etc/passwd']) {
      await expect(withTenant(bad, async () => undefined, appPool)).rejects.toThrow(
        /invalid tenant id/,
      );
    }
  });

  it('the context does not survive the transaction that set it', async () => {
    // set_config(..., true) is transaction-local. If it leaked, a pooled connection would
    // carry one tenant's context into the next tenant's request.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['vega.tenant_id', ids.tenantA]);
      const inside = await client.query('SELECT * FROM users');
      expect(inside.rows.length).toBeGreaterThan(0);
      await client.query('COMMIT');

      const outside = await client.query('SELECT * FROM users');
      expect(outside.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });
});

/** Sets a raw (possibly invalid) context string, to prove the failure mode is safe. */
async function asTenantRaw(raw: string, fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['vega.tenant_id', raw]);
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {
      /* assertion result already captured */
    });
    client.release();
  }
}
