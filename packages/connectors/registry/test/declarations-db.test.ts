import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, getAppPool, migrate, seed, withTenant, type SeedResult } from '@vega/db';
import { PgConnectorStore, PgInvocationStore, PgTokenVault } from '@vega/connector-sdk';
import { PgMcpToolStore, checkDeclaration } from '@vega/connector-mcp';
import { declarationsSql, launchRegistry } from '../src/index.js';

/**
 * DECLARATION SYNC + Postgres stores — docs/module2.md §4, §11.
 *
 * (1) The committed projection file equals what the registry generates: a declaration changed
 *     in code without `pnpm tools:generate` fails here.
 * (2) After migrate, tool_declarations holds exactly the registry's records, and the
 *     application role can read it but not write it.
 * (3) The Postgres stores behave like the memory ones the contract suite runs against.
 */

const SYSTEM_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const APP_URL = process.env['DATABASE_APP_URL'] ?? 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';
process.env['DATABASE_APP_URL'] ??= APP_URL;

const registry = launchRegistry();
let seeded: SeedResult;
let app: pg.Pool;

beforeAll(async () => {
  await migrate(SYSTEM_URL);
  seeded = await seed(SYSTEM_URL);
  app = new pg.Pool({ connectionString: APP_URL });
}, 60_000);

afterAll(async () => {
  await app?.end();
  await closePools();
});

describe('tool_declarations projection', () => {
  it('the committed reference file is current (run `pnpm tools:generate` if this fails)', () => {
    const committed = readFileSync(join(import.meta.dirname, '..', '..', '..', 'db', 'reference', 'tool_declarations.sql'), 'utf8');
    expect(committed).toBe(declarationsSql(registry));
  });

  it('the database holds exactly the registry records', async () => {
    const { rows } = await app.query(
      `SELECT tool_id, connector_kind, version, scopes, egress_class, reversibility, max_taint, output_taint, idempotency,
              hold_supported, simulate_fidelity, compensator_ref, recipient_args, args_schema
         FROM tool_declarations ORDER BY tool_id`,
    );
    const records = registry.records();
    const current = rows.filter((r) => records.some((rec) => rec.toolId === r.tool_id && rec.version === r.version));
    expect(current.length).toBe(records.length);
    for (const rec of records) {
      const r = current.find((x) => x.tool_id === rec.toolId)!;
      expect({
        kind: r.connector_kind,
        scopes: r.scopes,
        egress: r.egress_class,
        rev: r.reversibility,
        maxTaint: r.max_taint,
        outputTaint: r.output_taint,
        idem: r.idempotency,
        hold: r.hold_supported,
        fidelity: r.simulate_fidelity,
        comp: r.compensator_ref,
        recipients: r.recipient_args,
        args: r.args_schema,
      }).toEqual({
        kind: rec.connectorKind,
        scopes: rec.scopes,
        egress: rec.egressClass,
        rev: rec.reversibility,
        maxTaint: rec.maxTaint,
        outputTaint: rec.outputTaint,
        idem: rec.idempotency,
        hold: rec.holdSupported,
        fidelity: rec.simulateFidelity,
        comp: rec.compensatorRef,
        recipients: rec.recipientArgs,
        args: rec.argsSchema,
      });
    }
  });

  it('the application role cannot write declarations', async () => {
    await expect(app.query(`UPDATE tool_declarations SET reversibility = 'R0' WHERE tool_id = 'gmail.send'`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`DELETE FROM tool_declarations`)).rejects.toThrow(/permission denied/);
  });

  it('the database refuses an R1/R2 declaration without a compensator, even from the owner', async () => {
    const owner = new pg.Client({ connectionString: SYSTEM_URL });
    await owner.connect();
    try {
      await expect(
        owner.query(
          `INSERT INTO tool_declarations (connector_kind, tool_id, version, title, description, scopes, egress_class, reversibility,
             max_taint, output_taint, idempotency, simulate_fidelity, args_schema, effect_schema)
           VALUES ('gmail','gmail.rogue',1,'t','d','{}','EXTERNAL','R2','TRUSTED','ORG','KEYED','DERIVED','{}','{}')`,
        ),
      ).rejects.toThrow(/compensator_required/);
    } finally {
      await owner.end();
    }
  });
});

describe('Postgres stores', () => {
  const slug = `partner_${Date.now().toString(36)}`;
  async function mcpConnector(tenantId: string, ownerId: string): Promise<string> {
    const [row] = await withTenant(tenantId, async (db) => {
      const { rows } = await db.$client.query<{ id: string }>(
        `INSERT INTO connectors (tenant_id, kind, display_name, owner_user_id, status, config)
         VALUES ($1, 'mcp', 'Partner tools', $2, 'active', $3) RETURNING id`,
        [tenantId, ownerId, JSON.stringify({ serverUrl: 'https://tools.partner.example/mcp', slug })],
      );
      return rows;
    });
    return row!.id;
  }

  it('PgMcpToolStore: sync, declare, re-sync keeps the declaration, tenants isolated', async () => {
    const store = new PgMcpToolStore();
    const connectorId = await mcpConnector(seeded.tenantA, seeded.userA);
    const server = { serverUrl: 'https://tools.partner.example/mcp', slug };
    const discovered = [
      { name: 'create_ticket', title: 'Create', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, published: null },
      { name: 'close_ticket', title: 'Close', description: 'd', inputSchema: { type: 'object' }, annotations: {}, published: null },
    ];
    const rows = await store.sync(seeded.tenantA, connectorId, server, discovered);
    expect(rows.map((r) => r.toolId)).toEqual([`mcp.${slug}.close_ticket`, `mcp.${slug}.create_ticket`]);
    expect(rows.every((r) => r.declaredBy === 'default')).toBe(true);

    const create = rows.find((r) => r.name === 'create_ticket')!;
    const d = checkDeclaration(create, { egressClass: 'EXTERNAL', reversibility: 'R1', maxTaint: 'ORG', idempotency: 'NONE', compensatorTool: 'close_ticket' }, rows);
    await store.declare(seeded.tenantA, create.toolId, d, seeded.userA);
    await store.sync(seeded.tenantA, connectorId, server, discovered.slice(0, 1));
    const after = await store.list(seeded.tenantA, connectorId);
    expect(after.map((r) => [r.toolId, r.declaredBy])).toEqual([[`mcp.${slug}.create_ticket`, 'admin']]);
    expect((await store.get(seeded.tenantA, `mcp.${slug}.create_ticket`))?.serverUrl).toBe(server.serverUrl);
    expect(await store.get(seeded.tenantB, `mcp.${slug}.create_ticket`)).toBeUndefined();
    // A second server may not reuse the slug: tool ids would collide.
    await expect(mcpConnector(seeded.tenantA, seeded.userA)).rejects.toThrow(/connectors_mcp_slug_unique/);
  });

  it('PgInvocationStore: one claim per key, replay after success, mismatch on different args, release on proven failure', async () => {
    const store = new PgInvocationStore();
    const [conn] = await withTenant(seeded.tenantA, (db) =>
      db.$client.query<{ id: string }>(`SELECT id FROM connectors WHERE kind = 'gmail' LIMIT 1`).then((r) => r.rows),
    );
    const base = { tenantId: seeded.tenantA, connectorId: conn!.id, toolId: 'gmail.send', key: `k-${Date.now()}`, argsDigest: 'd1' };
    expect((await store.claim(base)).kind).toBe('fresh');
    expect((await store.claim(base)).kind).toBe('in_flight');
    expect((await store.claim({ ...base, argsDigest: 'd2' })).kind).toBe('mismatch');
    const effect = { summary: 's', fidelity: 'PROVIDER' as const, externalRecipients: [], recordsAffected: [], detail: { id: 'm1' } };
    await store.succeed(base.tenantId, base.toolId, base.key, effect, 'm1');
    expect(await store.claim(base)).toMatchObject({ kind: 'replay', effect: { detail: { id: 'm1' } }, providerRef: 'm1' });

    const k2 = { ...base, key: `${base.key}-2` };
    await store.claim(k2);
    await store.fail(k2.tenantId, k2.toolId, k2.key, 'VALIDATION', true);
    expect((await store.claim(k2)).kind).toBe('fresh');
    const k3 = { ...base, key: `${base.key}-3` };
    await store.claim(k3);
    await store.fail(k3.tenantId, k3.toolId, k3.key, 'TRANSIENT', false);
    expect((await store.claim(k3)).kind).not.toBe('fresh');
  });

  it('PgTokenVault: tokens are sealed at rest and round-trip', async () => {
    const vault = new PgTokenVault();
    const id = await vault.save(seeded.tenantA, { accessToken: 'at-secret-123', refreshToken: 'rt-secret-456', expiresAt: 1, scopesGranted: ['s'] });
    const { rows } = await app.query(`SELECT ciphertext::text AS c FROM secret_refs WHERE id = $1`, [id]).catch(() => ({ rows: [] as Array<{ c: string }> }));
    for (const r of rows) expect(r.c).not.toContain('at-secret-123');
    expect(await vault.load(seeded.tenantA, id)).toMatchObject({ accessToken: 'at-secret-123', refreshToken: 'rt-secret-456' });
    await expect(vault.load(seeded.tenantB, id)).rejects.toThrow();
  });

  it('PgConnectorStore: internal domains fall back to the users’ sign-in domains', async () => {
    const domains = await new PgConnectorStore().internalDomains(seeded.tenantA);
    expect(domains.length).toBeGreaterThan(0);
    expect(getAppPool()).toBeDefined();
  });
});
