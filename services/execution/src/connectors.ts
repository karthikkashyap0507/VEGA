import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ToolError, type ConnectorRuntime } from '@vega/connector-sdk';
import { checkServerConfig, discover, type McpToolStore } from '@vega/connector-mcp';

/**
 * Execution-plane connector API — docs/module2.md §7, §8.
 *
 * INTERNAL ONLY. Reached from the control plane (simulate, health, MCP discovery) and, from
 * Module 4 on, from the orchestrator in this plane (execute). It is never routed from the
 * public gateway: direct execution would bypass planning, policy, taint and audit.
 *
 * Callers authenticate with a service token; in a cluster the listener is also mTLS-only and
 * Cilium admits control → execution and nothing else inbound. The tenant arrives in the body
 * because the CALLER already authorized the request against a verified principal; every store
 * the runtime touches still applies RLS for that tenant.
 */

export interface ConnectorApiDeps {
  runtime: ConnectorRuntime;
  mcpStore: McpToolStore;
  /** Bearer token the control plane presents. Absent: the API is not mounted. */
  token: string;
}

const Invoke = z.object({
  tenantId: z.string().uuid(),
  connectorId: z.string().uuid(),
  toolId: z.string().min(3).max(200),
  args: z.unknown(),
  runId: z.string().max(200).optional(),
  nodeId: z.string().max(200).optional(),
});
const ConnectorRef = z.object({ tenantId: z.string().uuid(), connectorId: z.string().uuid() });

function authorized(req: FastifyRequest, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function toolFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof ToolError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'VALIDATION' ? 400 : error.code === 'EGRESS_DENIED' ? 403 : 502;
    return reply.code(status).send({ ok: false, error: { code: error.code, message: error.message } });
  }
  return reply.code(500).send({ ok: false, error: { code: 'PROVIDER_ERROR', message: 'unexpected failure' } });
}

export function registerConnectorApi(app: FastifyInstance, deps: ConnectorApiDeps): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/internal/')) return;
    if (!authorized(req, deps.token)) return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'service token required' } });
  });

  app.post('/internal/tools/simulate', async (req, reply) => {
    const input = Invoke.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ ok: false, error: { code: 'VALIDATION', message: input.error.message } });
    return deps.runtime.simulate(input.data);
  });

  app.post('/internal/tools/execute', async (req, reply) => {
    const input = Invoke.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ ok: false, error: { code: 'VALIDATION', message: input.error.message } });
    return deps.runtime.execute(input.data);
  });

  app.post('/internal/connectors/health', async (req, reply) => {
    const input = ConnectorRef.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ ok: false, error: { code: 'VALIDATION', message: input.error.message } });
    try {
      return { ok: true, report: await deps.runtime.health(input.data.tenantId, input.data.connectorId) };
    } catch (error) {
      return toolFailure(reply, error);
    }
  });

  /** tools/list on an attached MCP server, then store what it said (module2.md §5.6). */
  app.post('/internal/mcp/discover', async (req, reply) => {
    const input = ConnectorRef.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ ok: false, error: { code: 'VALIDATION', message: input.error.message } });
    try {
      const { record, ctx } = await deps.runtime.connectorContext(input.data.tenantId, input.data.connectorId);
      if (record.kind !== 'mcp') throw new ToolError('VALIDATION', 'not an MCP connector', { committed: 'no' });
      const server = checkServerConfig(record.config);
      const tools = await discover(ctx);
      const rows = await deps.mcpStore.sync(record.tenantId, record.id, server, tools);
      return { ok: true, tools: rows.map((r) => ({ toolId: r.toolId, name: r.name, declaredBy: r.declaredBy })) };
    } catch (error) {
      return toolFailure(reply, error);
    }
  });
}
