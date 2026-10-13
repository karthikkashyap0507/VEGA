import { randomBytes } from 'node:crypto';
import type pg from 'pg';

/** Seeded history for the certification / mining suites: real rows in every table they read. */

export const OWNER_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';

export interface Tenant {
  tenantId: string;
  userId: string;
  approverId: string;
  workspaceId: string;
  agentId: string;
}

export async function seedTenant(pool: pg.Pool): Promise<Tenant> {
  const slug = `auto-${randomBytes(4).toString('hex')}`;
  const t = (await pool.query<{ id: string }>(`INSERT INTO tenants (name, slug, plan, retention_days) VALUES ($1,$2,'business',400) RETURNING id`, [slug, slug])).rows[0]!.id;
  const user = async (n: string, role: string) => (await pool.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1,$2,$3,$4,'active') RETURNING id`, [t, `${n}@${slug}.example`, n, role])).rows[0]!.id;
  const userId = await user('owner', 'OWNER');
  const approverId = await user('approver', 'APPROVER');
  const ws = (await pool.query<{ id: string }>(`INSERT INTO workspaces (tenant_id, name, slug) VALUES ($1,'Ops','ops') RETURNING id`, [t])).rows[0]!.id;
  const ag = (await pool.query<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1,$2,'assistant',$3,'m','active') RETURNING id`, [t, ws, userId])).rows[0]!.id;
  return { tenantId: t, userId, approverId, workspaceId: ws, agentId: ag };
}

export interface DecisionSpec {
  decision?: 'approve' | 'reject';
  edited?: boolean;
  diff?: Array<{ path: string; op: string; before?: unknown; after?: unknown }>;
  reason?: string;
  daysAgo?: number;
  latencyMs?: number;
  toolId?: string;
  agentId?: string;
  modelId?: string;
}

/** One run → one node → one approval request → one decision, the way the executor writes them. */
export async function addDecision(pool: pg.Pool, t: Tenant, d: DecisionSpec = {}): Promise<{ runId: string; decisionId: string; nodeId: string }> {
  const toolId = d.toolId ?? 'gmail.send';
  const agentId = d.agentId ?? t.agentId;
  const when = new Date(Date.now() - (d.daysAgo ?? 1) * 86_400_000);
  const run = (await pool.query<{ id: string }>(
    `INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status, started_at) VALUES ($1,$2,$3,$4,'api','{"objective":"x"}','COMPLETED',$5) RETURNING id`,
    [t.tenantId, t.workspaceId, agentId, t.userId, when],
  )).rows[0]!.id;
  const node = (await pool.query<{ id: string }>(`INSERT INTO task_nodes (tenant_id, run_id, program_version, step_index, kind, tool_id, status) VALUES ($1,$2,1,0,'TOOL_CALL',$3,'done') RETURNING id`, [t.tenantId, run, toolId])).rows[0]!.id;
  if (d.modelId) await pool.query(`INSERT INTO programs (tenant_id, run_id, ast_json, ast_digest, model_id, valid) VALUES ($1,$2,'{}',$3,$4,true)`, [t.tenantId, run, `sha256:${randomBytes(8).toString('hex')}`, d.modelId]);
  const decision = d.decision ?? 'approve';
  const req = (await pool.query<{ id: string }>(
    `INSERT INTO approval_requests (tenant_id, run_id, node_id, approval_key, tool_id, requester, approver_role, packet_json, packet_digest, expires_at, fallback, state)
     VALUES ($1,$2,$3,$4,$5,$6,'APPROVER','{}','sha256:x',now() + interval '1 day','AUTO_REJECT',$7) RETURNING id`,
    [t.tenantId, run, node, `k-${randomBytes(6).toString('hex')}`, toolId, t.userId, decision === 'reject' ? 'rejected' : 'approved'],
  )).rows[0]!.id;
  const dec = (await pool.query<{ id: string }>(
    `INSERT INTO approval_decisions (tenant_id, request_id, run_id, tool_id, approver_id, decision, reason, edited, edit_diff_json, latency_ms, evidence_opened, surface, packet_digest, packet_chars, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,'web','sha256:x',300,$11) RETURNING id`,
    [t.tenantId, req, run, toolId, t.approverId, decision, d.reason ?? null, d.edited ?? false, d.diff ? JSON.stringify(d.diff) : null, d.latencyMs ?? 6000, when],
  )).rows[0]!.id;
  return { runId: run, decisionId: dec, nodeId: node };
}

export async function addMany(pool: pg.Pool, t: Tenant, n: number, d: DecisionSpec = {}) {
  for (let i = 0; i < n; i++) await addDecision(pool, t, { ...d, daysAgo: (d.daysAgo ?? 5) + (i % 40) / 10 });
}
