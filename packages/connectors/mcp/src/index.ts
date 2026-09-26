import { isIP } from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SourcedSchema } from '@vega/contracts';
import { BRAND } from '@vega/shared';
import {
  DeclarationError,
  defineRuntimeTool,
  sourced,
  ToolError,
  validateDeclaration,
  type AnyTool,
  type ConnectorDefinition,
  type DynamicToolSource,
  type ToolContext,
} from '@vega/connector-sdk';
import { isPublicAddress } from '@vega/connector-web';
import { DECLARATION_META_KEY, McpDeclaration, toolIdFor, UNDECLARED_AUTONOMY_CAP, type DiscoveredTool, type McpServerConfig, type McpToolRow, type McpToolStore } from './declaration.js';

export * from './declaration.js';
export { MemoryMcpToolStore } from './memory.js';
export { PgMcpToolStore } from './pg.js';

/**
 * MCP client — docs/module2.md §5.6.
 *
 * A third-party MCP server attaches as a connector of kind `mcp`. Its tools are discovered with
 * `tools/list`, stored per tenant (`mcp_tools`), and exposed to the runtime through a
 * DynamicToolSource under ids `mcp.<server>.<tool>`.
 *
 * Declarations. MCP tool metadata (including `annotations.readOnlyHint`) is a claim by a third
 * party, so none of it relaxes governance. Until an admin declares a tool it is registered
 *
 *     EXTERNAL / R3 / TRUSTED / NONE, held for approval, output UNTRUSTED, autonomy ≤ SUPERVISED
 *
 * A server may publish a declaration in our extension format (`_meta[DECLARATION_META_KEY]`);
 * that is stored as a PROPOSAL the admin can adopt, never applied automatically.
 */

export function checkServerConfig(config: Record<string, unknown>): McpServerConfig {
  const parsed = z
    .object({ serverUrl: z.string().url(), slug: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/) })
    .safeParse(config);
  if (!parsed.success) throw new ToolError('VALIDATION', 'MCP connector needs config.serverUrl and a lowercase config.slug', { committed: 'no' });
  const url = new URL(parsed.data.serverUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ToolError('EGRESS_DENIED', 'MCP servers are reached over HTTP(S)', { committed: 'no' });
  if (url.username || url.password) throw new ToolError('EGRESS_DENIED', 'credentials in URL are not allowed', { committed: 'no' });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const reserved =
    /^localhost$/i.test(host) ||
    /^metadata(\.google\.internal)?$/i.test(host) ||
    (isIP(host) !== 0 && !isPublicAddress(host) && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host));
  // Private ranges are allowed (enterprise MCP servers live there); loopback and metadata never.
  if (reserved && process.env['MCP_ALLOW_LOOPBACK'] !== '1') {
    throw new ToolError('EGRESS_DENIED', `${host} is a reserved address`, { committed: 'no' });
  }
  return parsed.data;
}

/** An MCP client whose HTTP goes through the connector's authenticated ProviderHttp. */
async function connect(ctx: Pick<ToolContext, 'http'>, serverUrl: string): Promise<Client> {
  const client = new Client({ name: `${BRAND.slug}-agent`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      return ctx.http.raw(String(url), {
        absolute: true,
        method: (init?.method ?? 'GET') as 'GET',
        headers,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
      });
    },
  });
  try {
    await client.connect(transport as never);
  } catch (cause) {
    throw new ToolError('CONNECTOR_UNAVAILABLE', 'MCP server did not complete the handshake', { committed: 'no', cause });
  }
  return client;
}

/** `tools/list` against a server. Runs in the execution plane (it is outbound traffic). */
export async function discover(ctx: Pick<ToolContext, 'http' | 'config'>): Promise<DiscoveredTool[]> {
  const server = checkServerConfig(ctx.config);
  const client = await connect(ctx, server.serverUrl);
  try {
    const out: DiscoveredTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const t of page.tools) {
        const meta = (t._meta ?? {}) as Record<string, unknown>;
        const proposal = McpDeclaration.safeParse(meta[DECLARATION_META_KEY]);
        out.push({
          name: t.name,
          title: t.title ?? t.annotations?.title ?? t.name,
          description: (t.description ?? '').slice(0, 2000),
          inputSchema: t.inputSchema as Record<string, unknown>,
          annotations: { ...(t.annotations ?? {}) },
          published: proposal.success ? proposal.data : null,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && out.length < 500);
    return out;
  } finally {
    await client.close().catch(() => undefined);
  }
}

const Content = z.object({ type: z.string(), text: z.string() });
const McpEffect = z.object({ content: z.array(SourcedSchema(Content)), isError: z.boolean() });

function argsSchemaFrom(inputSchema: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(inputSchema as never);
  } catch {
    // A schema Zod cannot express still gets a shape check; the server validates the rest.
    return z.record(z.string(), z.unknown());
  }
}

/** Builds the runtime tool for a stored row: admin declaration if present, conservative defaults otherwise. */
export function buildTool(row: McpToolRow): AnyTool {
  const d = row.declaredBy === 'admin' ? row.declaration : null;
  const slug = row.toolId.split('.')[1] ?? 'server';
  const reversibility = d?.reversibility ?? 'R3';
  const compensatorRef = d?.compensatorTool ? toolIdFor(slug, d.compensatorTool) : undefined;
  const outputTaint = d?.outputTaint ?? 'UNTRUSTED';
  const body = {
    toolId: row.toolId,
    connectorKind: 'mcp' as const,
    version: 1,
    title: row.title || row.name,
    description: row.description || `MCP tool ${row.name}`,
    scopes: [],
    egressClass: d?.egressClass ?? 'EXTERNAL',
    reversibility,
    ...(compensatorRef ? { compensatorRef } : {}),
    maxTaint: d?.maxTaint ?? 'TRUSTED',
    idempotency: d?.idempotency ?? 'NONE',
    sensitivityHint: d?.sensitivityHint ?? 70,
    holdSupported: d ? d.holdSupported : true,
    simulateFidelity: 'DECLARED' as const,
    outputTaint,
    recipientArgs: d?.recipientArgs ?? [],
    argsSchema: argsSchemaFrom(row.inputSchema),
    effectSchema: McpEffect,
    async simulate() {
      return {
        summary: `Calls "${row.name}" on ${new URL(row.serverUrl).host}. What the server does is not known in advance.`,
        fidelity: 'DECLARED' as const,
        externalRecipients: d?.egressClass === 'INTERNAL' ? [] : [new URL(row.serverUrl).origin],
        recordsAffected: [],
        reversibilityNote: d ? `Declared ${reversibility} by an administrator.` : 'Undeclared third-party tool: treated as irreversible.',
        detail: { content: [], isError: false },
      };
    },
    async execute(args: unknown, ctx: ToolContext) {
      const client = await connect(ctx, row.serverUrl);
      try {
        const res = (await client.callTool({ name: row.name, arguments: args as Record<string, unknown> })) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };
        const content = (res.content ?? []).map((c, i) =>
          sourced(
            { type: c.type, text: c.type === 'text' ? (c.text ?? '') : `[${c.type} content omitted]` },
            { system: `mcp:${slug}`, id: `${row.name}#${i}`, taint: outputTaint },
          ),
        );
        if (res.isError) {
          // The server ran the tool and reported failure: it may have done part of the work.
          throw new ToolError('PROVIDER_ERROR', `MCP tool reported an error: ${(content[0]?.value.text ?? '').slice(0, 200)}`, { committed: 'maybe' });
        }
        return {
          effect: {
            summary: `Called "${row.name}" on ${new URL(row.serverUrl).host}.`,
            fidelity: 'PROVIDER' as const,
            externalRecipients: d?.egressClass === 'INTERNAL' ? [] : [new URL(row.serverUrl).origin],
            recordsAffected: [{ system: `mcp:${slug}`, id: row.name }],
            detail: { content, isError: false },
          },
        };
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
  return defineRuntimeTool(body as unknown as AnyTool);
}

/** Checks an admin declaration against the tool and its server before it is stored. */
export function checkDeclaration(row: McpToolRow, declaration: unknown, siblings: McpToolRow[]): McpDeclaration {
  const parsed = McpDeclaration.safeParse(declaration);
  if (!parsed.success) throw new DeclarationError(row.toolId, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const d = parsed.data;
  if (d.compensatorTool && !siblings.some((s) => s.name === d.compensatorTool)) {
    throw new DeclarationError(row.toolId, [`compensatorTool "${d.compensatorTool}" is not a tool on this server`]);
  }
  const problems = validateDeclaration(buildTool({ ...row, declaredBy: 'admin', declaration: d }));
  if (problems.length) throw new DeclarationError(row.toolId, problems);
  return d;
}

/** Resolves `mcp.*` tool ids for the runtime from the tenant's stored rows. */
export class McpToolSource implements DynamicToolSource {
  constructor(private readonly store: McpToolStore) {}

  async resolve(tenantId: string, toolId: string): Promise<AnyTool | undefined> {
    if (!toolId.startsWith('mcp.')) return undefined;
    const row = await this.store.get(tenantId, toolId);
    return row ? buildTool(row) : undefined;
  }
}

export function autonomyCap(row: Pick<McpToolRow, 'declaredBy'>): typeof UNDECLARED_AUTONOMY_CAP | null {
  return row.declaredBy === 'admin' ? null : UNDECLARED_AUTONOMY_CAP;
}

export const mcp: ConnectorDefinition = {
  kind: 'mcp',
  displayName: 'MCP server',
  provider: 'mcp',
  apiBase: 'https://invalid.example',
  tools: [],
  neverDoes: [
    'Trust what the MCP server says about its own tools',
    'Run an undeclared tool without approval',
    'Reach loopback or cloud metadata addresses',
  ],
  async health(ctx) {
    const started = Date.now();
    const tools = await discover(ctx);
    return { ok: true, latencyMs: Date.now() - started, detail: `${tools.length} tool(s)` };
  },
};

export default mcp;
