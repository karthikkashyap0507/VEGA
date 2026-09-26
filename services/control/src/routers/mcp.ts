import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { problems } from '@vega/shared';
import { schema } from '@vega/db';
import { AttachMcpServer, DeclareMcpTool, Uuid } from '@vega/contracts';
import { toRecord } from '@vega/connector-sdk';
import { autonomyCap, buildTool, checkDeclaration, checkServerConfig } from '@vega/connector-mcp';
import { ProblemError, procedure, requireCapability, router, type AuthedContext } from '../trpc.js';
import { emitEvent, isUniqueViolation } from '../lib.js';
import { asProblem, connectorDeps, connectorEvent, loadConnector, toConnector } from '../connectors/common.js';

/**
 * MCP servers — docs/module2.md §5.6, §7. Attaching a server discovers its tools (in the
 * execution plane: that is outbound traffic) and registers every one of them under the
 * conservative defaults. Nothing the server says about its own tools is applied until an
 * admin declares or adopts a declaration.
 */

async function loadMcp(ctx: AuthedContext, id: string) {
  const row = await loadConnector(ctx, id);
  if (row.kind !== 'mcp') throw new ProblemError(problems.notFound('MCP server not found'));
  return row;
}

async function discover(ctx: AuthedContext, connectorId: string) {
  try {
    const tools = await connectorDeps(ctx).execution.discoverMcp(ctx.principal.tenantId, connectorId);
    await ctx.db(async (db) => {
      await db
        .update(schema.connectors)
        .set({ status: 'active', lastOkAt: new Date(), healthJson: { discoveredTools: tools.length, lastDiscovery: new Date().toISOString() } })
        .where(eq(schema.connectors.id, connectorId));
      await connectorEvent(db, ctx.principal.tenantId, connectorId, 'discovered', { tools: tools.length });
    });
    return { tools, error: null as string | null };
  } catch (error) {
    ctx.log.warn({ err: error, connectorId }, 'MCP discovery failed');
    const message = error instanceof Error ? error.message : 'discovery failed';
    await ctx.db((db) => connectorEvent(db, ctx.principal.tenantId, connectorId, 'error', { phase: 'discovery', message }));
    return { tools: [], error: message };
  }
}

export const mcpRouter = router({
  attach: procedure.input(AttachMcpServer).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.manage');
    const d = connectorDeps(ctx);
    let config: { serverUrl: string; slug: string };
    try {
      config = checkServerConfig({ serverUrl: input.serverUrl, slug: input.slug });
    } catch (error) {
      return asProblem(error);
    }
    const secretRefId = input.apiKey ? await d.vault.save(ctx.principal.tenantId, { accessToken: input.apiKey, scopesGranted: [] }) : null;
    let row;
    try {
      row = await ctx.db(async (db) => {
        const [created] = await db
          .insert(schema.connectors)
          .values({
            tenantId: ctx.principal.tenantId,
            workspaceId: input.workspaceId ?? null,
            kind: 'mcp',
            displayName: input.displayName,
            accountRef: config.serverUrl,
            ownerUserId: ctx.principal.userId,
            config,
            secretRefId,
            status: 'pending',
          })
          .returning();
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'mcp.attached', { connectorId: created!.id, serverUrl: config.serverUrl });
        return created!;
      });
    } catch (error) {
      if (secretRefId) await d.vault.delete(ctx.principal.tenantId, secretRefId).catch(() => undefined);
      if (isUniqueViolation(error)) throw new ProblemError(problems.conflict('an MCP server with this slug or URL is already attached'));
      throw error;
    }
    const discovery = await discover(ctx, row.id);
    return { connector: toConnector(await loadMcp(ctx, row.id)), tools: discovery.tools, discoveryError: discovery.error };
  }),

  rediscover: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.manage');
    await loadMcp(ctx, input.id);
    const discovery = await discover(ctx, input.id);
    if (discovery.error) throw new ProblemError(problems.upstreamUnavailable('MCP server'));
    return { tools: discovery.tools };
  }),

  /** GET /v1/mcp/servers/:id/tools — discovered tools; `declaredBy: default` ones await declaration. */
  tools: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.read');
    await loadMcp(ctx, input.id);
    const rows = await connectorDeps(ctx).mcpStore.list(ctx.principal.tenantId, input.id);
    return {
      items: rows.map((r) => ({
        toolId: r.toolId,
        name: r.name,
        title: r.title,
        description: r.description,
        inputSchema: r.inputSchema,
        annotations: r.annotations,
        declaredBy: r.declaredBy,
        declaration: r.declaration,
        published: r.published,
        autonomyCap: autonomyCap(r),
        effective: toRecord(buildTool(r)),
      })),
    };
  }),

  declare: procedure
    .input(z.intersection(z.object({ id: Uuid, toolId: z.string().min(3).max(200) }), DeclareMcpTool))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'connectors.manage');
      const d = connectorDeps(ctx);
      await loadMcp(ctx, input.id);
      const siblings = await d.mcpStore.list(ctx.principal.tenantId, input.id);
      const row = siblings.find((r) => r.toolId === input.toolId);
      if (!row) throw new ProblemError(problems.notFound('tool not found on this server'));
      const proposed = 'adoptPublished' in input ? row.published : input.declaration;
      if (!proposed) throw new ProblemError(problems.preconditionFailed('the server published no declaration for this tool'));
      let declaration;
      try {
        declaration = checkDeclaration(row, proposed, siblings);
      } catch (error) {
        return asProblem(error);
      }
      await d.mcpStore.declare(ctx.principal.tenantId, row.toolId, declaration, ctx.principal.userId);
      await ctx.db((db) =>
        emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'mcp.tool_declared', {
          connectorId: input.id,
          toolId: row.toolId,
          reversibility: declaration.reversibility,
          adopted: 'adoptPublished' in input,
        }),
      );
      const updated = (await d.mcpStore.get(ctx.principal.tenantId, row.toolId))!;
      return { toolId: updated.toolId, declaredBy: updated.declaredBy, autonomyCap: autonomyCap(updated), effective: toRecord(buildTool(updated)) };
    }),
});
