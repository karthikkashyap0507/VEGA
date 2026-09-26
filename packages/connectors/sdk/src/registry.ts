import type { ConnectorKind, ToolDeclarationRecord } from '@vega/contracts';
import type { AnyTool, ConnectorDefinition } from './connector.js';
import { DeclarationError, toRecord, validateDeclaration } from './define.js';

/**
 * The tool registry. A connector registers as a whole; each of its tools is validated again
 * here, so nothing reaches the registry by a path that skipped defineTool().
 */
export class ToolRegistry {
  private readonly connectors = new Map<ConnectorKind, ConnectorDefinition>();
  private readonly tools = new Map<string, { tool: AnyTool; connector: ConnectorDefinition }>();

  register(connector: ConnectorDefinition): this {
    if (this.connectors.has(connector.kind)) throw new Error(`connector "${connector.kind}" registered twice`);
    for (const tool of connector.tools) {
      const problems = validateDeclaration(tool);
      if (problems.length) throw new DeclarationError(tool.toolId, problems);
      if (tool.connectorKind !== connector.kind) {
        throw new DeclarationError(tool.toolId, [`declared for "${tool.connectorKind}" but registered under "${connector.kind}"`]);
      }
      if (this.tools.has(tool.toolId)) throw new DeclarationError(tool.toolId, ['toolId registered twice']);
      this.tools.set(tool.toolId, { tool, connector });
    }
    this.connectors.set(connector.kind, connector);
    return this;
  }

  connector(kind: ConnectorKind): ConnectorDefinition | undefined {
    return this.connectors.get(kind);
  }

  allConnectors(): ConnectorDefinition[] {
    return [...this.connectors.values()];
  }

  get(toolId: string): { tool: AnyTool; connector: ConnectorDefinition } | undefined {
    return this.tools.get(toolId);
  }

  toolsFor(kind: ConnectorKind): AnyTool[] {
    return this.connectors.get(kind)?.tools ?? [];
  }

  records(filter: { kind?: ConnectorKind } = {}): ToolDeclarationRecord[] {
    return [...this.tools.values()]
      .filter((t) => !filter.kind || t.tool.connectorKind === filter.kind)
      .map((t) => toRecord(t.tool))
      .sort((a, b) => a.toolId.localeCompare(b.toolId));
  }
}
