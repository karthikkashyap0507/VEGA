import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { GLOBAL_TABLES, TENANT_SCOPED_TABLES } from '../src/schema.js';

/**
 * SCHEMA COVERAGE — the guard against the failure mode that actually happens.
 *
 * Nobody forgets RLS on the table they are thinking about. They forget it on the fourth
 * table added six months later, in a module nobody associates with tenancy. This suite
 * enumerates the database rather than a hand-maintained list, so a new table is isolated
 * by default or the build fails.
 *
 * Adding a table to GLOBAL_TABLES requires writing down WHY it is not tenant-scoped.
 */

const SYSTEM_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';

let pool: pg.Pool;

beforeAll(async () => {
  await migrate(SYSTEM_URL);
  pool = new pg.Pool({ connectionString: SYSTEM_URL });
}, 60_000);

afterAll(async () => {
  await pool?.end();
});

async function allTables(): Promise<
  Array<{ relname: string; rls: boolean; forced: boolean }>
> {
  const { rows } = await pool.query<{ relname: string; rls: boolean; forced: boolean }>(
    `SELECT relname,
            relrowsecurity      AS rls,
            relforcerowsecurity AS forced
       FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relkind = 'r'
      ORDER BY relname`,
  );
  return rows;
}

describe('RLS coverage', () => {
  it('every table is either tenant-scoped or explicitly declared global', async () => {
    const tables = await allTables();
    const known = new Set<string>([...TENANT_SCOPED_TABLES, ...Object.keys(GLOBAL_TABLES)]);

    const undeclared = tables.map((t) => t.relname).filter((name) => !known.has(name));

    expect(
      undeclared,
      `Undeclared table(s): ${undeclared.join(', ')}. ` +
        `Add to TENANT_SCOPED_TABLES (with an RLS policy and isolation tests), ` +
        `or to GLOBAL_TABLES with a written reason.`,
    ).toEqual([]);
  });

  it('every table has RLS enabled and forced — including the global ones', async () => {
    const tables = await allTables();
    for (const t of tables) {
      if (t.relname === '_migrations') continue; // system ledger, no app grants at all
      expect(t.rls, `${t.relname}: RLS not enabled`).toBe(true);
      expect(t.forced, `${t.relname}: RLS not FORCED (the owner would bypass it)`).toBe(true);
    }
  });

  it('every tenant-scoped table carries a policy with USING and WITH CHECK', async () => {
    const { rows } = await pool.query<{
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
      cmd: string;
    }>(
      `SELECT tablename, policyname, qual, with_check, cmd
         FROM pg_policies
        WHERE schemaname = 'public'`,
    );

    for (const table of TENANT_SCOPED_TABLES) {
      const policies = rows.filter((r) => r.tablename === table);
      expect(policies.length, `${table}: no policy`).toBeGreaterThan(0);

      const all = policies.find((p) => p.cmd === 'ALL');
      expect(all, `${table}: expected a policy covering ALL commands`).toBeDefined();
      expect(all?.qual, `${table}: policy has no USING clause`).toBeTruthy();
      // Without WITH CHECK, this tenant can write rows into another tenant.
      expect(all?.with_check, `${table}: policy has no WITH CHECK clause`).toBeTruthy();
    }
  });

  it('the application role holds no write grants on reference data', async () => {
    const { rows } = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'vega_app'
          AND table_name = 'plan_entitlements'`,
    );
    const privileges = rows.map((r) => r.privilege_type);
    expect(privileges).toContain('SELECT');
    expect(privileges).not.toContain('INSERT');
    expect(privileges).not.toContain('UPDATE');
    expect(privileges).not.toContain('DELETE');
  });

  it('the application role has no access to the migration ledger', async () => {
    const { rows } = await pool.query(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'vega_app' AND table_name = '_migrations'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('migration ledger', () => {
  it('records every applied migration with a checksum', async () => {
    const { rows } = await pool.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM _migrations ORDER BY name',
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is idempotent — re-running applies nothing', async () => {
    const applied = await migrate(SYSTEM_URL);
    expect(applied).toEqual([]);
  });
});
