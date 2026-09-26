import { z } from 'zod';
import { Timestamp, Uuid } from './common.js';
import { ConnectorKind, ConnectorStatus, EgressClass, Idempotency, TaintLevel, ToolDeclarationRecord } from './tools.js';

/** Connector management API contracts — docs/module2.md §7. */

export const Connector = z.object({
  id: Uuid,
  tenantId: Uuid,
  workspaceId: Uuid.nullable(),
  kind: ConnectorKind,
  displayName: z.string(),
  accountRef: z.string().nullable(),
  ownerUserId: Uuid,
  status: ConnectorStatus,
  scopesGranted: z.array(z.string()),
  scopesRequired: z.array(z.string()),
  enabledTools: z.array(z.string()),
  config: z.record(z.string(), z.unknown()),
  health: z.record(z.string(), z.unknown()),
  lastOkAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Connector = z.infer<typeof Connector>;

const ToolIds = z.array(z.string().min(3).max(200)).max(200);

export const CreateConnector = z.object({
  kind: ConnectorKind.exclude(['mcp']),
  displayName: z.string().trim().min(1).max(120),
  workspaceId: Uuid.optional(),
  enabledTools: ToolIds.default([]),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type CreateConnector = z.infer<typeof CreateConnector>;

export const UpdateConnector = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  workspaceId: Uuid.nullable().optional(),
  enabledTools: ToolIds.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateConnector = z.infer<typeof UpdateConnector>;

/** Creating or widening a connector may require the user to visit the provider's consent screen. */
export const ConnectorWithConsent = z.object({
  connector: Connector,
  authorizeUrl: z.string().url().nullable(),
});

export const ConsentView = z.object({
  connector: z.string(),
  scopes: z.array(z.string()),
  permissions: z.array(z.object({ toolId: z.string(), title: z.string(), scopes: z.array(z.string()), safeguard: z.string().optional() })),
  neverDoes: z.array(z.string()),
  toolCount: z.number().int(),
});
export type ConsentView = z.infer<typeof ConsentView>;

export const ConnectorCatalogEntry = z.object({
  kind: ConnectorKind,
  displayName: z.string(),
  provider: z.enum(['google', 'microsoft', 'slack', 'none', 'mcp']),
  /** False when the deployment has no OAuth client for this provider. */
  available: z.boolean(),
  tools: z.array(ToolDeclarationRecord),
});

export const HealthView = z.object({
  status: ConnectorStatus,
  lastOkAt: Timestamp.nullable(),
  health: z.record(z.string(), z.unknown()),
  events: z.array(z.object({ kind: z.string(), detail: z.record(z.string(), z.unknown()), createdAt: Timestamp })),
});

export const ProbeResult = z.object({ ok: z.boolean(), latencyMs: z.number(), detail: z.string().optional() });

/** A tool as the API lists it: the declaration, plus governance facts that are not part of it. */
export const ToolView = ToolDeclarationRecord.extend({
  source: z.enum(['builtin', 'mcp']),
  /** MCP only: 'default' means the conservative defaults apply. */
  declaredBy: z.enum(['code', 'default', 'admin']),
  /** Highest autonomy tier this tool may reach; null = no cap beyond policy. */
  autonomyCap: z.enum(['SUPERVISED']).nullable(),
  connectorId: Uuid.nullable(),
});
export type ToolView = z.infer<typeof ToolView>;

export const SimulateTool = z.object({
  connectorId: Uuid,
  args: z.unknown(),
});

// ------------------------------------------------------------------ MCP

export const AttachMcpServer = z.object({
  displayName: z.string().trim().min(1).max(120),
  serverUrl: z.string().url().max(2048),
  slug: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'lowercase letters, digits and _'),
  apiKey: z.string().min(1).max(4096).optional(),
  workspaceId: Uuid.optional(),
});
export type AttachMcpServer = z.infer<typeof AttachMcpServer>;

export const McpDeclarationInput = z.object({
  egressClass: EgressClass,
  reversibility: z.enum(['R0', 'R1', 'R2', 'R3']),
  maxTaint: TaintLevel,
  idempotency: Idempotency.exclude(['KEYED']),
  compensatorTool: z.string().min(1).nullable().optional(),
  outputTaint: z.enum(['ORG', 'UNTRUSTED']).optional(),
  recipientArgs: z.array(z.string()).optional(),
  sensitivityHint: z.number().int().min(0).max(100).optional(),
  holdSupported: z.boolean().optional(),
});

export const DeclareMcpTool = z.union([
  z.object({ adoptPublished: z.literal(true) }),
  z.object({ declaration: McpDeclarationInput }),
]);

export const McpToolView = z.object({
  toolId: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()),
  declaredBy: z.enum(['default', 'admin']),
  declaration: z.record(z.string(), z.unknown()).nullable(),
  published: z.record(z.string(), z.unknown()).nullable(),
  autonomyCap: z.enum(['SUPERVISED']).nullable(),
  effective: ToolDeclarationRecord,
});
