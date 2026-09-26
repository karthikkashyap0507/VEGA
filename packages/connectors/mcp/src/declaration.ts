import { z } from 'zod';
import { EgressClass, Idempotency, TaintLevel } from '@vega/contracts';
import { BRAND } from '@vega/shared';

/** Declaration types and the per-tenant store interface for discovered MCP tools. */

export const DECLARATION_META_KEY = `${BRAND.slug}/tool-declaration`;
/** Undeclared MCP tools cannot be promoted past this tier (Module 10 reads it). */
export const UNDECLARED_AUTONOMY_CAP = 'SUPERVISED' as const;

export interface McpServerConfig {
  serverUrl: string;
  /** `[a-z][a-z0-9_]*` — the middle segment of every tool id from this server. */
  slug: string;
}

export interface DiscoveredTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The server's own hints. Displayed to the admin; never used to relax a declaration. */
  annotations: Record<string, unknown>;
  published: McpDeclaration | null;
}

/** What an admin can declare about an MCP tool. Output is never TRUSTED: it came from a third party. */
export const McpDeclaration = z
  .object({
    egressClass: EgressClass,
    reversibility: z.enum(['R0', 'R1', 'R2', 'R3']),
    maxTaint: TaintLevel,
    idempotency: Idempotency.exclude(['KEYED']),
    /** Name of the tool ON THE SAME SERVER that undoes this one (required for R1/R2). */
    compensatorTool: z.string().min(1).nullable().default(null),
    outputTaint: z.enum(['ORG', 'UNTRUSTED']).default('UNTRUSTED'),
    recipientArgs: z.array(z.string()).default([]),
    sensitivityHint: z.number().int().min(0).max(100).default(50),
    holdSupported: z.boolean().default(false),
  })
  .strict();
export type McpDeclaration = z.infer<typeof McpDeclaration>;

export interface McpToolRow {
  tenantId: string;
  connectorId: string;
  toolId: string;
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  declaredBy: 'default' | 'admin';
  declaration: McpDeclaration | null;
  published: McpDeclaration | null;
  serverUrl: string;
}

export interface McpToolStore {
  get(tenantId: string, toolId: string): Promise<McpToolRow | undefined>;
  list(tenantId: string, connectorId: string): Promise<McpToolRow[]>;
  /** Replaces the discovered set; admin declarations survive for tools that still exist. */
  sync(tenantId: string, connectorId: string, server: McpServerConfig, tools: DiscoveredTool[]): Promise<McpToolRow[]>;
  declare(tenantId: string, toolId: string, declaration: McpDeclaration, userId?: string): Promise<void>;
}

export function toolIdFor(slug: string, name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '');
  return `mcp.${slug}.${normalized || 'tool'}`;
}
