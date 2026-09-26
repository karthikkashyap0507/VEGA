import { toolIdFor, type DiscoveredTool, type McpDeclaration, type McpServerConfig, type McpToolRow, type McpToolStore } from './declaration.js';

export class MemoryMcpToolStore implements McpToolStore {
  readonly rows = new Map<string, McpToolRow>();

  async get(tenantId: string, toolId: string) {
    return this.rows.get(`${tenantId}:${toolId}`);
  }

  async list(tenantId: string, connectorId: string) {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.connectorId === connectorId);
  }

  async sync(tenantId: string, connectorId: string, server: McpServerConfig, tools: DiscoveredTool[]) {
    const keep = new Set<string>();
    for (const t of tools) {
      const toolId = toolIdFor(server.slug, t.name);
      keep.add(toolId);
      const prior = this.rows.get(`${tenantId}:${toolId}`);
      this.rows.set(`${tenantId}:${toolId}`, {
        tenantId,
        connectorId,
        toolId,
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
        declaredBy: prior?.declaredBy ?? 'default',
        declaration: prior?.declaration ?? null,
        published: t.published,
        serverUrl: server.serverUrl,
      });
    }
    for (const [k, r] of this.rows) if (r.tenantId === tenantId && r.connectorId === connectorId && !keep.has(r.toolId)) this.rows.delete(k);
    return this.list(tenantId, connectorId);
  }

  async declare(tenantId: string, toolId: string, declaration: McpDeclaration) {
    const row = this.rows.get(`${tenantId}:${toolId}`);
    if (row) this.rows.set(`${tenantId}:${toolId}`, { ...row, declaredBy: 'admin', declaration });
  }
}
