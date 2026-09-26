import { getAppPool } from './client.js';

/**
 * Cross-tenant WORK DISCOVERY for the control plane's background loops (Module 4): the run
 * coordinator, the schedule trigger and webhook delivery. Like the resolvers in auth.ts these
 * call SECURITY DEFINER functions owned by a NOLOGIN role (vega_sched, migration 0007), which
 * return ids and statuses only — never content. Everything a loop then reads or writes about a
 * run goes through withTenant() for that run's tenant, like any request.
 */

export async function schedRunQueue(statuses: string[], limit: number): Promise<Array<{ tenantId: string; runId: string; status: string; updatedAt: Date }>> {
  const { rows } = await getAppPool().query<{ tenant_id: string; run_id: string; status: string; updated_at: Date }>('SELECT * FROM sched_run_queue($1, $2)', [statuses, limit]);
  return rows.map((r) => ({ tenantId: r.tenant_id, runId: r.run_id, status: r.status, updatedAt: r.updated_at }));
}

export async function schedScheduleAgents(): Promise<Array<{ tenantId: string; agentId: string; triggers: Array<{ kind: string; cron?: string; tz?: string }> }>> {
  const { rows } = await getAppPool().query<{ tenant_id: string; agent_id: string; triggers: Array<{ kind: string; cron?: string; tz?: string }> | null }>('SELECT * FROM sched_schedule_agents()');
  return rows.map((r) => ({ tenantId: r.tenant_id, agentId: r.agent_id, triggers: r.triggers ?? [] }));
}

/** An inbound webhook trigger: agent id + SHA-256 of the presented secret → its tenant, or null. */
export async function schedWebhookAgent(agentId: string, secretHash: string): Promise<string | null> {
  const { rows } = await getAppPool().query<{ tenant_id: string }>('SELECT tenant_id FROM sched_webhook_agent($1, $2)', [agentId, secretHash]);
  return rows[0]?.tenant_id ?? null;
}

export async function schedWebhookTenants(): Promise<string[]> {
  const { rows } = await getAppPool().query<{ tenant_id: string }>('SELECT * FROM sched_webhook_tenants()');
  return rows.map((r) => r.tenant_id);
}

/** Every tenant's active policy bundle (Module 5): what the signed OPA discovery bundle lists. */
export async function schedPolicyBundles(): Promise<Array<{ tenantId: string; version: number; bundleRef: string }>> {
  const { rows } = await getAppPool().query<{ tenant_id: string; version: number; bundle_ref: string }>('SELECT * FROM sched_policy_bundles()');
  return rows.map((r) => ({ tenantId: r.tenant_id, version: r.version, bundleRef: r.bundle_ref }));
}
