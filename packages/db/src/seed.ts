import pg from 'pg';

/**
 * Seed for local development and the isolation suite.
 *
 * Creates TWO tenants with identically-shaped data. Identical shape is the point: it means
 * the isolation tests cannot accidentally pass because tenant B simply had nothing to find.
 *
 * Runs on the owner connection because a tenant does not exist yet, so there is no tenant
 * context to set — one of the few legitimate uses of the bypass path.
 */

export interface SeedResult {
  tenantA: string;
  tenantB: string;
  userA: string;
  userB: string;
  workspaceA: string;
  workspaceB: string;
  agentA: string;
  agentB: string;
}

export async function seed(connectionString?: string): Promise<SeedResult> {
  const url = connectionString ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query('BEGIN');

    // plan_entitlements rows come from migration 0003, so every environment has them —
    // not only databases that happened to be seeded.

    const made: Record<string, string> = {};

    for (const [key, name, slug] of [
      ['A', 'Acme Advisors', 'acme-advisors'],
      ['B', 'Borealis Partners', 'borealis-partners'],
    ] as const) {
      const t = await client.query<{ id: string }>(
        `INSERT INTO tenants (name, slug, plan, retention_days)
         VALUES ($1, $2, 'business', 400)
         ON CONFLICT (slug) DO UPDATE SET name = $1
         RETURNING id`,
        [name, slug],
      );
      const tenantId = t.rows[0]!.id;

      const u = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, display_name, role, status)
         VALUES ($1, $2, $3, 'OWNER', 'active')
         ON CONFLICT (tenant_id, email) DO UPDATE SET display_name = $3
         RETURNING id`,
        [tenantId, `owner@${slug}.example`, `Owner ${key}`],
      );
      const userId = u.rows[0]!.id;

      const ws = await client.query<{ id: string }>(
        `INSERT INTO workspaces (tenant_id, name, slug)
         VALUES ($1, 'Client Operations', 'client-ops')
         ON CONFLICT (tenant_id, slug) DO UPDATE SET name = 'Client Operations'
         RETURNING id`,
        [tenantId],
      );
      const workspaceId = ws.rows[0]!.id;

      await client.query(
        `INSERT INTO workspace_members (tenant_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [tenantId, workspaceId, userId],
      );

      const ag = await client.query<{ id: string }>(
        `INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id)
         VALUES ($1, $2, 'client-comm', $3, $4)
         ON CONFLICT (workspace_id, name, version) DO UPDATE SET owner_user_id = $3
         RETURNING id`,
        [tenantId, workspaceId, userId, `machine_${slug}`],
      );

      await client.query(
        `INSERT INTO platform_events (tenant_id, actor_id, kind, payload)
         VALUES ($1, $2, 'tenant.seeded', '{}'::jsonb)`,
        [tenantId, userId],
      );

      await client.query(
        `INSERT INTO secret_refs (tenant_id, purpose, kms_key_id, wrapped_dek, ciphertext, iv, auth_tag)
         VALUES ($1, 'connector_oauth', 'local', '\\x00', '\\x00', '\\x00', '\\x00')`,
        [tenantId],
      );

      // Session and idempotency rows exist so the isolation suite has something to try to
      // steal. The token hash is random; no cookie anywhere corresponds to it.
      await client.query(
        `INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at, absolute_expires_at)
         VALUES ($1, $2, gen_random_bytes(32), now() + interval '1 hour', now() + interval '1 day')`,
        [tenantId, userId],
      );
      await client.query(
        `INSERT INTO idempotency_keys (tenant_id, principal_id, key, method, path, request_hash)
         VALUES ($1, $2, 'seed-' || gen_random_uuid(), 'POST', '/v1/workspaces', gen_random_bytes(32))`,
        [tenantId, userId],
      );

      const conn = await client.query<{ id: string }>(
        `INSERT INTO connectors (tenant_id, kind, display_name, owner_user_id, status)
         VALUES ($1, 'gmail', 'Seed mailbox', $2, 'pending') RETURNING id`,
        [tenantId, userId],
      );
      await client.query(
        `INSERT INTO tool_invocations (tenant_id, connector_id, tool_id, idempotency_key, args_digest)
         VALUES ($1, $2, 'gmail.send', 'seed-' || gen_random_uuid(), 'x')`,
        [tenantId, conn.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO connector_events (tenant_id, connector_id, kind) VALUES ($1, $2, 'seeded')`,
        [tenantId, conn.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO mcp_tools (tenant_id, connector_id, tool_id, name, title, input_schema)
         VALUES ($1, $2, 'mcp.seed.echo_' || substr(md5(random()::text), 1, 10), 'echo', 'Echo', '{"type":"object"}')`,
        [tenantId, conn.rows[0]!.id],
      );

      await client.query(`INSERT INTO sources (tenant_id, run_id, uri, taint, digest) VALUES ($1, 'seed', 'gmail:seed', 'UNTRUSTED', 'sha256:seed') ON CONFLICT DO NOTHING`, [tenantId]);
      await client.query(
        `INSERT INTO derivations (tenant_id, run_id, value_ref, op, taint, data_taint, context_taint, step_index) VALUES ($1, 'seed', 'v1', 'literal', 'TRUSTED', 'TRUSTED', 'TRUSTED', 1) ON CONFLICT DO NOTHING`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO taint_violations (tenant_id, run_id, tool_id, kind, attempted_taint, declared_max, arg_path, program_ref, severity)
         VALUES ($1, 'seed', 'gmail.send', 'RECIPIENT', 'UNTRUSTED', 'TRUSTED', 'to[0]', 'sha256:seed', 'CRITICAL') ON CONFLICT DO NOTHING`,
        [tenantId],
      );
      await client.query(`INSERT INTO programs (tenant_id, run_id, ast_json, ast_digest, model_id, valid) VALUES ($1, 'seed', '{}', 'sha256:seed', 'seed', true) ON CONFLICT DO NOTHING`, [tenantId]);
      await client.query(
        `INSERT INTO trusted_contacts (tenant_id, email, added_by) VALUES ($1, 'seed-' || substr(md5(random()::text), 1, 8) || '@partner.example', $2)`,
        [tenantId, userId],
      );

      const run = await client.query<{ id: string }>(
        `INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status)
         VALUES ($1, $2, $3, $4, 'api', '{"objective":"seed"}', 'COMPLETED') RETURNING id`,
        [tenantId, workspaceId, ag.rows[0]!.id, userId],
      );
      const node = await client.query<{ id: string }>(
        `INSERT INTO task_nodes (tenant_id, run_id, program_version, step_index, kind, tool_id, status)
         VALUES ($1, $2, 1, 0, 'TOOL_CALL', 'gmail.search', 'done') RETURNING id`,
        [tenantId, run.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO actions (tenant_id, run_id, node_id, tool_id, args_digest, taint_level, reversibility, state)
         VALUES ($1, $2, $3, 'gmail.send', 'x', 'TRUSTED', 'R2', 'COMMITTED')`,
        [tenantId, run.rows[0]!.id, node.rows[0]!.id],
      );
      await client.query(`INSERT INTO replans (tenant_id, run_id, from_step, from_version, reason) VALUES ($1, $2, 0, 1, 'tool_failure')`, [tenantId, run.rows[0]!.id]);
      await client.query(`INSERT INTO agent_versions (tenant_id, agent_id, version, spec_json, created_by) VALUES ($1, $2, 1, '{}', $3) ON CONFLICT DO NOTHING`, [tenantId, ag.rows[0]!.id, userId]);
      const conv = await client.query<{ id: string }>(
        `INSERT INTO conversations (tenant_id, workspace_id, agent_id, user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, workspaceId, ag.rows[0]!.id, userId],
      );
      await client.query(`INSERT INTO conversation_messages (tenant_id, conversation_id, role, body) VALUES ($1, $2, 'user', 'hello')`, [tenantId, conv.rows[0]!.id]);
      await client.query(`INSERT INTO trigger_fires (tenant_id, agent_id, fire_at) VALUES ($1, $2, now() - (random() * interval '1000 days'))`, [tenantId, ag.rows[0]!.id]);
      const hook = await client.query<{ id: string }>(
        `INSERT INTO webhook_endpoints (tenant_id, url, event_kinds, secret_sealed, created_by) VALUES ($1, 'https://hooks.partner.example/vega', '{run.completed}', 'sealed', $2) RETURNING id`,
        [tenantId, userId],
      );
      await client.query(`INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, kind) VALUES ($1, $2, 1, 'run.completed')`, [tenantId, hook.rows[0]!.id]);

      made['tenant' + key] = tenantId;
      made['user' + key] = userId;
      made['workspace' + key] = workspaceId;
      made['agent' + key] = ag.rows[0]!.id;
    }

    await client.query('COMMIT');
    return made as unknown as SeedResult;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
