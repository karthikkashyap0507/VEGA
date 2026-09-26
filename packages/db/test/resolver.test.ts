import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { seed, type SeedResult } from '../src/seed.js';

/**
 * The pre-tenant resolution path (0002_identity.sql).
 *
 * Sign-in and session lookup must happen before a tenant is known. These tests pin down that
 * the path is exactly as wide as intended: two functions, callable by the application role,
 * each answering one question for a caller that already holds the credential — and no way to
 * reach the underlying role-scoped policy directly.
 */

const SYSTEM_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const APP_URL = process.env['DATABASE_APP_URL'] ?? 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';

let systemPool: pg.Pool;
let appPool: pg.Pool;
let ids: SeedResult;

const subjectA = `sub-a-${randomBytes(4).toString('hex')}`;
const tokenA = randomBytes(32);
const tokenAPrev = randomBytes(32);
const sha = (b: Buffer) => createHash('sha256').update(b).digest();

beforeAll(async () => {
  await migrate(SYSTEM_URL);
  ids = await seed(SYSTEM_URL);
  systemPool = new pg.Pool({ connectionString: SYSTEM_URL });
  appPool = new pg.Pool({ connectionString: APP_URL });

  await systemPool.query('UPDATE users SET idp_subject = $1 WHERE id = $2', [subjectA, ids.userA]);
  await systemPool.query(
    `INSERT INTO sessions (tenant_id, user_id, token_hash, previous_token_hash, previous_valid_until,
                           expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '30 seconds', now() + interval '1 hour', now() + interval '1 day')`,
    [ids.tenantA, ids.userA, sha(tokenA), sha(tokenAPrev)],
  );
}, 60_000);

afterAll(async () => {
  await appPool?.end();
  await systemPool?.end();
});

describe('auth_resolve_subject', () => {
  it('resolves a verified subject to its tenant and user on the app role, with no context set', async () => {
    const { rows } = await appPool.query(
      'SELECT tenant_id, user_id, role, user_status, tenant_status FROM auth_resolve_subject($1)',
      [subjectA],
    );
    expect(rows).toEqual([
      {
        tenant_id: ids.tenantA,
        user_id: ids.userA,
        role: 'OWNER',
        user_status: 'active',
        tenant_status: 'active',
      },
    ]);
  });

  it('returns nothing for an unknown subject', async () => {
    const { rows } = await appPool.query('SELECT * FROM auth_resolve_subject($1)', ['nobody']);
    expect(rows).toHaveLength(0);
  });
});

describe('auth_resolve_session', () => {
  it('resolves the current token hash', async () => {
    const { rows } = await appPool.query<{ tenant_id: string; matched: string }>(
      'SELECT tenant_id, matched FROM auth_resolve_session($1)',
      [sha(tokenA)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: ids.tenantA, matched: 'current' });
  });

  it('reports a previous token as previous, so the caller can apply the grace window', async () => {
    const { rows } = await appPool.query<{ matched: string }>(
      'SELECT matched FROM auth_resolve_session($1)',
      [sha(tokenAPrev)],
    );
    expect(rows[0]?.matched).toBe('previous');
  });

  it('the raw token (unhashed) resolves nothing — only the hash is stored', async () => {
    const { rows } = await appPool.query('SELECT * FROM auth_resolve_session($1)', [tokenA]);
    expect(rows).toHaveLength(0);
  });
});

describe('the resolver path is no wider than the two functions', () => {
  it('the app role cannot assume the resolver role', async () => {
    await expect(appPool.query('SET ROLE vega_auth')).rejects.toThrow(/permission denied/i);
  });

  it('the resolver policy does not apply to the app role', async () => {
    // With no tenant context the app role sees nothing, even though vega_auth has a
    // USING (true) policy on the same table.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      const users = await client.query('SELECT * FROM users');
      const sessions = await client.query('SELECT * FROM sessions');
      expect(users.rows).toHaveLength(0);
      expect(sessions.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('both functions are SECURITY DEFINER, owned by vega_auth, with a pinned search_path', async () => {
    const { rows } = await systemPool.query<{
      proname: string;
      prosecdef: boolean;
      owner: string;
      proconfig: string[] | null;
    }>(
      `SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname IN ('auth_resolve_subject', 'auth_resolve_session')
        ORDER BY p.proname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.prosecdef, `${row.proname} must be SECURITY DEFINER`).toBe(true);
      expect(row.owner, `${row.proname} must be owned by the NOLOGIN resolver role`).toBe('vega_auth');
      expect(row.proconfig ?? [], `${row.proname} must pin search_path`).toContain(
        'search_path=public, pg_temp',
      );
    }
  });

  it('the resolver role cannot log in and is not a superuser', async () => {
    const { rows } = await systemPool.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'vega_auth'`,
    );
    expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
  });

  it('the resolver role holds no write privilege anywhere', async () => {
    const { rows } = await systemPool.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'vega_auth' AND privilege_type <> 'SELECT'`,
    );
    expect(rows).toHaveLength(0);
  });
});
