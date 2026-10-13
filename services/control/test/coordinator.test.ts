import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, migrate } from '@vega/db';
import { RunStore } from '@vega/runs';
import { RunCoordinator, type AgentCoreDeps } from '../src/agent/coordinator.js';

/**
 * A run whose stored record no longer parses (written by an older version, or by hand) must not
 * become a poison pill: the sweep picks it up every two seconds, so "the next sweep retries" would
 * repeat the same failure forever. It is failed once, with the validation issues as the reason.
 */

process.env['DATABASE_URL'] ??= 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
process.env['DATABASE_APP_URL'] ??= 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';

let pool: pg.Pool;
const warnings: Array<{ obj: object; msg: string }> = [];
const log = { warn: (obj: object, msg: string) => void warnings.push({ obj, msg }), error: () => undefined, info: () => undefined, child: () => log };

async function runWithObjective(objective: unknown): Promise<{ tenantId: string; runId: string }> {
  const slug = `coord-${randomBytes(4).toString('hex')}`;
  const q = async (sql: string, params: unknown[]) => (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const tenantId = await q(`INSERT INTO tenants (name, slug, plan, retention_days) VALUES ($1,$2,'business',400) RETURNING id`, [slug, slug]);
  const userId = await q(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1,$2,'o','OWNER','active') RETURNING id`, [tenantId, `o@${slug}.example`]);
  const workspaceId = await q(`INSERT INTO workspaces (tenant_id, name, slug) VALUES ($1,'W','w') RETURNING id`, [tenantId]);
  const agentId = await q(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1,$2,'a',$3,'m','active') RETURNING id`, [tenantId, workspaceId, userId]);
  const runId = await q(
    `INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status) VALUES ($1,$2,$3,$4,'api',$5,'CREATED') RETURNING id`,
    [tenantId, workspaceId, agentId, userId, JSON.stringify(objective)],
  );
  return { tenantId, runId };
}

beforeAll(async () => {
  await migrate(process.env['DATABASE_URL']);
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 2 });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await closePools();
});

describe('a run record that does not parse', () => {
  it('is failed once, with the validation issues as its reason — not retried on every sweep', async () => {
    const { tenantId, runId } = await runWithObjective({ objective: 'x' }); // no entities, constraints, origin …
    const coordinator = new RunCoordinator({ store: new RunStore(), log } as unknown as AgentCoreDeps);

    await coordinator.process(tenantId, runId);

    const [row] = (await pool.query<{ status: string; status_reason: string; error_json: { code: string; issues: string[] } }>(`SELECT status, status_reason, error_json FROM runs WHERE id = $1`, [runId])).rows;
    expect(row).toMatchObject({ status: 'FAILED', error_json: { code: 'RUN_RECORD_INVALID' } });
    expect(row!.status_reason).toMatch(/stored record could not be read .*entities/);
    expect(row!.error_json.issues.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /does not parse/.test(w.msg))).toBe(true);

    // The next sweep finds nothing to do: the run is terminal, and processing it again is a no-op.
    const before = warnings.length;
    await expect(coordinator.process(tenantId, runId)).resolves.toBeUndefined();
    expect(warnings.length).toBe(before);
  });
});
