import type { ToolResult } from '@vega/contracts';
import type { OAuthClientConfig, TokenVault, ToolRegistry } from '@vega/connector-sdk';
import type { McpToolStore } from '@vega/connector-mcp';

/**
 * What the control plane needs to manage connectors (docs/module2.md §7–§8).
 *
 * The control plane owns connector ROWS, the OAuth round-trip (it holds the OAuth client
 * secrets and exchanges codes) and credential storage. Anything that calls a provider API
 * with a tenant's credential — simulate, health probes, MCP discovery — goes to the execution
 * plane, the only plane with egress to providers' data APIs.
 */
export interface ConnectorDeps {
  registry: ToolRegistry;
  oauthClients: Partial<Record<'google' | 'microsoft' | 'slack', OAuthClientConfig>>;
  vault: TokenVault;
  execution: ExecutionClient;
  mcpStore: McpToolStore;
  /** Key material for sealing OAuth state (HKDF-derived per purpose). */
  stateSecret: string;
}

export interface ProbeReport {
  ok: boolean;
  latencyMs: number;
  detail?: string;
  accountRef?: string;
}

export interface ProgramRunInput {
  tenantId: string;
  runId: string;
  program: unknown;
  mode: 'execute' | 'simulate';
  modelId: string;
  now: string;
  bindings: Record<string, string>;
  approvedNodes?: string[];
  objective?: string;
}

export interface ExecutionClient {
  simulate(input: { tenantId: string; connectorId: string; toolId: string; args: unknown }): Promise<ToolResult<unknown>>;
  runProgram(input: ProgramRunInput): Promise<Record<string, unknown> & { status: string }>;
  validateProgram(tenantId: string, program: unknown): Promise<{ valid: boolean; errors: Array<{ code: string; message: string; nodeId?: string; path?: string; severity?: string }>; calls: unknown[]; program?: unknown }>;
  programCatalog(): Promise<{ schemas: Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>; templates: string[] }>;
  health(tenantId: string, connectorId: string): Promise<ProbeReport>;
  discoverMcp(tenantId: string, connectorId: string): Promise<Array<{ toolId: string; name: string; declaredBy: string }>>;
}

export class ExecutionUnavailable extends Error {}
export class ExecutionRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Control → execution over the internal API (mTLS in a cluster, plus a service token). */
export class HttpExecutionClient implements ExecutionClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new ExecutionUnavailable('execution plane unreachable', { cause });
    }
    const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: { code: string; message: string } };
    if (res.status >= 500 && !data.error) throw new ExecutionUnavailable(`execution plane ${res.status}`);
    if (!res.ok && data.error) throw new ExecutionRefused(data.error.code, data.error.message);
    return data;
  }

  simulate(input: { tenantId: string; connectorId: string; toolId: string; args: unknown }) {
    return this.post<ToolResult<unknown>>('/internal/tools/simulate', input);
  }

  async health(tenantId: string, connectorId: string) {
    return (await this.post<{ report: ProbeReport }>('/internal/connectors/health', { tenantId, connectorId })).report;
  }

  runProgram(input: ProgramRunInput) {
    return this.post<Record<string, unknown> & { status: string }>('/internal/programs/run', input);
  }

  validateProgram(tenantId: string, program: unknown) {
    return this.post<{ valid: boolean; errors: Array<{ code: string; message: string; nodeId?: string; path?: string; severity?: string }>; calls: unknown[]; program?: unknown }>(
      '/internal/programs/validate',
      { tenantId, program },
    );
  }

  async programCatalog() {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/internal/programs/catalog`, { headers: { authorization: `Bearer ${this.token}` } });
    } catch (cause) {
      throw new ExecutionUnavailable('execution plane unreachable', { cause });
    }
    if (!res.ok) throw new ExecutionUnavailable(`execution plane ${res.status}`);
    return (await res.json()) as { schemas: Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>; templates: string[] };
  }

  async discoverMcp(tenantId: string, connectorId: string) {
    return (await this.post<{ tools: Array<{ toolId: string; name: string; declaredBy: string }> }>('/internal/mcp/discover', { tenantId, connectorId }))
      .tools;
  }
}
