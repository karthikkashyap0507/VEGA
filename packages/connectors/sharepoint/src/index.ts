import { z } from 'zod';
import { SourcedSchema } from '@vega/contracts';
import { Address, defineTool, externalOnly, sourced, type ConnectorDefinition } from '@vega/connector-sdk';

/**
 * SharePoint / OneDrive via Microsoft Graph drives — docs/module2.md §5.2 (declared by analogy
 * with Google Drive).
 *
 * | Tool             | Egress   | Rev | Max taint | Idempotency | Hold | Compensator         |
 * | sharepoint.read  | INTERNAL | R0  | UNTRUSTED | NATIVE      | –    |                     |
 * | sharepoint.write | INTERNAL | R1  | ORG       | KEYED       | –    | restore version     |
 * | sharepoint.share | EXTERNAL | R1  | TRUSTED   | KEYED       | ✅   | revoke permission   |
 */

const SCOPE = { read: 'Files.Read.All', write: 'Files.ReadWrite.All' } as const;

interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  cTag?: string;
}

const item = (driveId: string, itemId: string) => `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
const Target = z.object({ driveId: z.string().min(1), itemId: z.string().min(1) });
const FileView = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), modified: z.string(), content: z.string() });

export const read = defineTool({
  toolId: 'sharepoint.read',
  connectorKind: 'sharepoint',
  version: 1,
  title: 'Read a document',
  description: 'Read a document’s text content. Content is always UNTRUSTED.',
  scopes: [SCOPE.read],
  egressClass: 'INTERNAL',
  reversibility: 'R0',
  maxTaint: 'UNTRUSTED',
  idempotency: 'NATIVE',
  sensitivityHint: 50,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'UNTRUSTED',
  recipientArgs: [],
  argsSchema: Target.extend({ maxBytes: z.number().int().min(1).max(5_000_000).default(1_000_000) }),
  effectSchema: z.object({ file: SourcedSchema(FileView).nullable() }),
  async simulate(args) {
    return { summary: `Reads document ${args.itemId}. Changes nothing.`, fidelity: 'DERIVED', externalRecipients: [], recordsAffected: [], detail: { file: null } };
  },
  async execute(args, ctx) {
    const meta = await ctx.http.json<DriveItem>(item(args.driveId, args.itemId));
    const content = (await ctx.http.text(`${item(args.driveId, args.itemId)}/content`)).slice(0, args.maxBytes);
    const value = { id: meta.id, name: meta.name ?? '', mimeType: meta.file?.mimeType ?? '', modified: meta.lastModifiedDateTime ?? '', content };
    return {
      effect: {
        summary: `Read "${value.name}".`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [],
        detail: { file: sourced(value, { system: 'sharepoint:item', id: meta.id, taint: 'UNTRUSTED' }) },
      },
    };
  },
});

export const write = defineTool({
  toolId: 'sharepoint.write',
  connectorKind: 'sharepoint',
  version: 1,
  title: 'Update a document',
  description: 'Replace a document’s content. Version history keeps the previous version.',
  scopes: [SCOPE.write],
  egressClass: 'INTERNAL',
  reversibility: 'R1',
  compensatorRef: 'sharepoint.version.restore',
  maxTaint: 'ORG',
  idempotency: 'KEYED',
  sensitivityHint: 40,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: [],
  argsSchema: Target.extend({ content: z.string().max(5_000_000) }),
  effectSchema: z.object({ itemId: z.string(), previousTag: z.string().nullable(), bytes: z.number().int() }),
  async simulate(args, ctx) {
    const meta = await ctx.http.json<DriveItem>(item(args.driveId, args.itemId));
    const bytes = Buffer.byteLength(args.content, 'utf8');
    return {
      summary: `Replaces the content of "${meta.name}" (${meta.size ?? '?'} → ${bytes} bytes). Version history keeps the current version.`,
      fidelity: 'DERIVED',
      externalRecipients: [],
      recordsAffected: [{ system: 'sharepoint', id: args.itemId, field: 'content', before: { tag: meta.cTag ?? null, size: meta.size ?? 0 }, after: { size: bytes } }],
      detail: { itemId: args.itemId, previousTag: meta.cTag ?? null, bytes },
    };
  },
  async execute(args, ctx) {
    const before = await ctx.http.json<DriveItem>(item(args.driveId, args.itemId));
    const after = await ctx.http.json<DriveItem>(`${item(args.driveId, args.itemId)}/content`, {
      method: 'PUT',
      body: args.content,
      contentType: 'text/plain',
    });
    const bytes = Buffer.byteLength(args.content, 'utf8');
    return {
      providerRef: after.cTag ?? after.id,
      effect: {
        summary: `Updated "${after.name ?? before.name}".`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [{ system: 'sharepoint', id: args.itemId, field: 'content', before: { tag: before.cTag ?? null, size: before.size ?? 0 }, after: { tag: after.cTag ?? null, size: bytes } }],
        detail: { itemId: args.itemId, previousTag: before.cTag ?? null, bytes },
      },
    };
  },
});

export const share = defineTool({
  toolId: 'sharepoint.share',
  connectorKind: 'sharepoint',
  version: 1,
  title: 'Share a document',
  description: 'Invite someone to a document. The recipient must be TRUSTED; revoking undoes it.',
  scopes: [SCOPE.write],
  egressClass: 'EXTERNAL',
  reversibility: 'R1',
  compensatorRef: 'sharepoint.permission.revoke',
  maxTaint: 'TRUSTED',
  idempotency: 'KEYED',
  sensitivityHint: 70,
  holdSupported: true,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: ['email'],
  argsSchema: Target.extend({ email: Address, role: z.enum(['read', 'write']) }),
  effectSchema: z.object({ itemId: z.string(), permissionId: z.string().nullable(), email: z.string(), role: z.string() }),
  async simulate(args, ctx) {
    return {
      summary: `Gives ${args.email} ${args.role} access and emails them an invitation.`,
      fidelity: 'DERIVED',
      externalRecipients: externalOnly([args.email], ctx.internalDomains),
      recordsAffected: [{ system: 'sharepoint', id: args.itemId, field: 'permissions', after: { email: args.email, role: args.role } }],
      reversibilityNote: 'The recipient is notified; revoking removes access but not the notification.',
      detail: { itemId: args.itemId, permissionId: null, email: args.email, role: args.role },
    };
  },
  async execute(args, ctx) {
    const res = await ctx.http.json<{ value?: Array<{ id: string }> }>(`${item(args.driveId, args.itemId)}/invite`, {
      method: 'POST',
      json: { recipients: [{ email: args.email }], roles: [args.role], requireSignIn: true, sendInvitation: true },
    });
    const permissionId = res.value?.[0]?.id ?? null;
    return {
      ...(permissionId ? { providerRef: permissionId } : {}),
      effect: {
        summary: `Shared with ${args.email} (${args.role}).`,
        fidelity: 'PROVIDER',
        externalRecipients: externalOnly([args.email], ctx.internalDomains),
        recordsAffected: [{ system: 'sharepoint', id: args.itemId, field: 'permissions', after: { permissionId, email: args.email, role: args.role } }],
        reversibilityNote: 'The recipient was notified.',
        detail: { itemId: args.itemId, permissionId, email: args.email, role: args.role },
      },
    };
  },
});

export const sharepoint: ConnectorDefinition = {
  kind: 'sharepoint',
  displayName: 'SharePoint',
  provider: 'microsoft',
  apiBase: 'https://graph.microsoft.com/v1.0',
  tools: [read, write, share],
  neverDoes: ['Delete documents or sites', 'Create anonymous sharing links', 'Change site permissions'],
  async health(ctx) {
    const started = Date.now();
    await ctx.http.json('/me/drive', { query: { $select: 'id' } });
    return { ok: true, latencyMs: Date.now() - started };
  },
  async accountRef(ctx) {
    const me = await ctx.http.json<{ mail?: string; userPrincipalName?: string }>('/me', { query: { $select: 'mail,userPrincipalName' } });
    return (me.mail ?? me.userPrincipalName ?? 'unknown').toLowerCase();
  },
};

export default sharepoint;
