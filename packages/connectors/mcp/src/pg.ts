import { and, eq, notInArray } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import { McpDeclaration, toolIdFor, type DiscoveredTool, type McpServerConfig, type McpToolRow, type McpToolStore } from './declaration.js';

/** mcp_tools under withTenant(): discovered MCP tools are tenant data like any other. */
export class PgMcpToolStore implements McpToolStore {
  private toRow(r: typeof schema.mcpTools.$inferSelect, serverUrl: string): McpToolRow {
    const declaration = r.declaration ? McpDeclaration.parse(r.declaration) : null;
    const published = r.published ? McpDeclaration.safeParse(r.published) : null;
    return {
      tenantId: r.tenantId,
      connectorId: r.connectorId,
      toolId: r.toolId,
      name: r.name,
      title: r.title,
      description: r.description,
      inputSchema: r.inputSchema as Record<string, unknown>,
      annotations: r.annotations as Record<string, unknown>,
      declaredBy: r.declaredBy === 'admin' && declaration ? 'admin' : 'default',
      declaration,
      published: published?.success ? published.data : null,
      serverUrl,
    };
  }

  async get(tenantId: string, toolId: string) {
    const [hit] = await withTenant(tenantId, (db) =>
      db
        .select({ tool: schema.mcpTools, config: schema.connectors.config })
        .from(schema.mcpTools)
        .innerJoin(schema.connectors, eq(schema.connectors.id, schema.mcpTools.connectorId))
        .where(eq(schema.mcpTools.toolId, toolId)),
    );
    return hit ? this.toRow(hit.tool, String((hit.config as { serverUrl?: string }).serverUrl ?? '')) : undefined;
  }

  async list(tenantId: string, connectorId: string) {
    const rows = await withTenant(tenantId, (db) =>
      db
        .select({ tool: schema.mcpTools, config: schema.connectors.config })
        .from(schema.mcpTools)
        .innerJoin(schema.connectors, eq(schema.connectors.id, schema.mcpTools.connectorId))
        .where(eq(schema.mcpTools.connectorId, connectorId))
        .orderBy(schema.mcpTools.toolId),
    );
    return rows.map((h) => this.toRow(h.tool, String((h.config as { serverUrl?: string }).serverUrl ?? '')));
  }

  async sync(tenantId: string, connectorId: string, server: McpServerConfig, tools: DiscoveredTool[]) {
    await withTenant(tenantId, async (db) => {
      const ids = tools.map((t) => toolIdFor(server.slug, t.name));
      await db
        .delete(schema.mcpTools)
        .where(ids.length ? and(eq(schema.mcpTools.connectorId, connectorId), notInArray(schema.mcpTools.toolId, ids)) : eq(schema.mcpTools.connectorId, connectorId));
      for (const t of tools) {
        const values = {
          tenantId,
          connectorId,
          toolId: toolIdFor(server.slug, t.name),
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
          published: t.published,
          discoveredAt: new Date(),
        };
        // Re-discovery refreshes what the server says; it never touches the admin's declaration.
        await db
          .insert(schema.mcpTools)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.mcpTools.tenantId, schema.mcpTools.toolId],
            set: { name: values.name, title: values.title, description: values.description, inputSchema: values.inputSchema, annotations: values.annotations, published: values.published, discoveredAt: values.discoveredAt },
          });
      }
    });
    return this.list(tenantId, connectorId);
  }

  async declare(tenantId: string, toolId: string, declaration: McpDeclaration, userId?: string) {
    await withTenant(tenantId, (db) =>
      db
        .update(schema.mcpTools)
        .set({ declaredBy: 'admin', declaration, declaredAt: new Date(), ...(userId ? { declaredByUser: userId } : {}) })
        .where(eq(schema.mcpTools.toolId, toolId)),
    );
  }
}
