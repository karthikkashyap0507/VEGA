import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { problems } from '@vega/shared';
import { schema } from '@vega/db';
import { ConnectorKind, SimulateTool, Uuid, type ToolView } from '@vega/contracts';
import { toRecord } from '@vega/connector-sdk';
import { autonomyCap, buildTool, type McpToolRow } from '@vega/connector-mcp';
import { ProblemError, procedure, requireCapability, router, type AuthedContext } from '../trpc.js';
import { asProblem, connectorDeps, loadConnector } from '../connectors/common.js';

/**
 * Tools — docs/module2.md §7. Declarations are readable by anyone who builds agents; simulate
 * runs in the execution plane with the connector's credential and has no side effects.
 *
 * There is deliberately NO execute procedure here or anywhere in the control plane: execution
 * is reached only from the orchestrator (Module 4) inside the execution plane.
 */

function mcpView(row: McpToolRow): ToolView {
  return { ...toRecord(buildTool(row)), source: 'mcp', declaredBy: row.declaredBy, autonomyCap: autonomyCap(row), connectorId: row.connectorId };
}

async function mcpTools(ctx: AuthedContext, connectorId?: string): Promise<ToolView[]> {
  const d = connectorDeps(ctx);
  const servers = await ctx.db((db) =>
    db
      .select({ id: schema.connectors.id, status: schema.connectors.status })
      .from(schema.connectors)
      .where(eq(schema.connectors.kind, 'mcp')),
  );
  const views: ToolView[] = [];
  for (const s of servers) {
    if (connectorId && s.id !== connectorId) continue;
    if (s.status === 'revoked') continue;
    for (const row of await d.mcpStore.list(ctx.principal.tenantId, s.id)) views.push(mcpView(row));
  }
  return views;
}

export const toolsRouter = router({
  list: procedure
    .input(z.object({ kind: ConnectorKind.optional(), connectorId: Uuid.optional() }))
    .query(async ({ ctx, input }) => {
      requireCapability(ctx, 'agents.read');
      const d = connectorDeps(ctx);
      const builtin: ToolView[] = d.registry
        .records(input.kind ? { kind: input.kind } : {})
        .map((r) => ({ ...r, source: 'builtin' as const, declaredBy: 'code' as const, autonomyCap: null, connectorId: null }));
      const dynamic = !input.kind || input.kind === 'mcp' ? await mcpTools(ctx, input.connectorId) : [];
      return { items: [...builtin, ...dynamic] };
    }),

  get: procedure.input(z.object({ toolId: z.string().min(3).max(200) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const d = connectorDeps(ctx);
    const found = d.registry.get(input.toolId);
    if (found) return { ...toRecord(found.tool), source: 'builtin' as const, declaredBy: 'code' as const, autonomyCap: null, connectorId: null };
    const row = input.toolId.startsWith('mcp.') ? await d.mcpStore.get(ctx.principal.tenantId, input.toolId) : undefined;
    if (!row) throw new ProblemError(problems.notFound('tool not found'));
    return mcpView(row);
  }),

  /** POST /v1/tools/:toolId/simulate — the effect the call WOULD have (used by Module 6). */
  simulate: procedure
    .input(SimulateTool.extend({ toolId: z.string().min(3).max(200) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'agents.run');
      await loadConnector(ctx, input.connectorId);
      try {
        return await connectorDeps(ctx).execution.simulate({
          tenantId: ctx.principal.tenantId,
          connectorId: input.connectorId,
          toolId: input.toolId,
          args: input.args,
        });
      } catch (error) {
        return asProblem(error);
      }
    }),
});
