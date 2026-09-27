import { z } from 'zod';
import { SourcedSchema } from '@vega/contracts';
import { Address, DAY_MS, defineCompensator, defineTool, externalOnly, forwardDetail, sourced, ToolError, type ConnectorDefinition, type ToolContext } from '@vega/connector-sdk';

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

// ------------------------------------------------------------------ compensators (docs/module6.md §5.4)

interface GraphPermission {
  id: string;
  roles?: string[];
  grantedToV2?: { user?: { email?: string } };
}

async function permissionFor(ctx: ToolContext, driveId: string, itemId: string, email: string): Promise<GraphPermission | undefined> {
  const res = await ctx.http.json<{ value?: GraphPermission[] }>(`${item(driveId, itemId)}/permissions`);
  return (res.value ?? []).find((p) => p.grantedToV2?.user?.email?.toLowerCase() === email.toLowerCase());
}

/** Undoes `sharepoint.write` with Graph's own restoreVersion. EXACT for the content. */
export const versionRestore = defineCompensator<{ driveId: string; itemId: string; content: string }, { versionId: string | null; name: string }>({
  ref: 'sharepoint.version.restore',
  toolId: 'sharepoint.write',
  confidence: 'EXACT',
  sideEffects: 'SILENT',
  ttlMs: 30 * DAY_MS,
  describe: (t) => `Puts “${t.pre.name}” back to the version it had before this change (version ${t.pre.versionId ?? '?'}). The changed version stays in its history.`,
  async capture(args, ctx) {
    const meta = await ctx.http.json<DriveItem>(item(args.driveId, args.itemId));
    const versions = await ctx.http.json<{ value?: Array<{ id: string }> }>(`${item(args.driveId, args.itemId)}/versions`);
    return { versionId: versions.value?.[0]?.id ?? null, name: meta.name ?? args.itemId };
  },
  async compensate(t, ctx) {
    if (!t.pre.versionId) throw new ToolError('NOT_FOUND', 'SharePoint reported no version to restore', { committed: 'no' });
    const base = item(t.args.driveId, t.args.itemId);
    const before = await ctx.http.text(`${base}/versions/${encodeURIComponent(t.pre.versionId)}/content`);
    const now = await ctx.http.text(`${base}/content`);
    if (now === before) {
      return t.forward
        ? { outcome: 'already_restored', summary: `“${t.pre.name}” already has its earlier content.`, notified: [] }
        : { outcome: 'not_needed', summary: `“${t.pre.name}” was never changed.`, notified: [] };
    }
    await ctx.http.json(`${base}/versions/${encodeURIComponent(t.pre.versionId)}/restoreVersion`, { method: 'POST' });
    return { outcome: 'restored', summary: `Restored “${t.pre.name}” to version ${t.pre.versionId}.`, notified: [], residual: 'The version this action wrote is still in the document’s history.' };
  },
});

/** Undoes `sharepoint.share`: removes the access granted, or restores someone's previous role. */
export const permissionRevoke = defineCompensator<{ driveId: string; itemId: string; email: string; role: string }, { prior: { id: string; role: string } | null }>({
  ref: 'sharepoint.permission.revoke',
  toolId: 'sharepoint.share',
  confidence: 'EXACT',
  sideEffects: 'SILENT',
  ttlMs: 90 * DAY_MS,
  describe: (t) =>
    t.pre.prior
      ? `Changes ${t.args.email} back to the ${t.pre.prior.role} access they had before.`
      : `Removes ${t.args.email}’s access to the document. They were sent an invitation and may already have opened it.`,
  async capture(args, ctx) {
    const prior = await permissionFor(ctx, args.driveId, args.itemId, args.email);
    return { prior: prior ? { id: prior.id, role: prior.roles?.[0] ?? 'read' } : null };
  },
  async compensate(t, ctx) {
    const base = item(t.args.driveId, t.args.itemId);
    const current = await permissionFor(ctx, t.args.driveId, t.args.itemId, t.args.email);
    const prior = t.pre.prior;
    if (prior) {
      if (!current) throw new ToolError('NOT_FOUND', `${t.args.email} no longer has any access; their earlier ${prior.role} access has to be granted again by hand`, { committed: 'no' });
      if ((current.roles?.[0] ?? 'read') === prior.role) return { outcome: 'already_restored', summary: `${t.args.email} already has ${prior.role} access again.`, notified: [] };
      await ctx.http.json(`${base}/permissions/${encodeURIComponent(current.id)}`, { method: 'PATCH', json: { roles: [prior.role] } });
      return { outcome: 'restored', summary: `${t.args.email} is back to ${prior.role} access.`, notified: [] };
    }
    const granted = forwardDetail<{ permissionId: string | null }>(t)?.permissionId ?? current?.id;
    if (!current || (granted && current.id !== granted)) {
      return t.forward
        ? { outcome: 'already_restored', summary: `${t.args.email} already has no access.`, notified: [] }
        : { outcome: 'not_needed', summary: `${t.args.email} was never given access.`, notified: [] };
    }
    try {
      await ctx.http.json(`${base}/permissions/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
    } catch (e) {
      if (!(e instanceof ToolError && e.code === 'NOT_FOUND')) throw e;
    }
    return { outcome: 'restored', summary: `Removed ${t.args.email}’s access.`, notified: [], residual: 'They may have opened the document while they had access.' };
  },
});

export const sharepoint: ConnectorDefinition = {
  kind: 'sharepoint',
  displayName: 'SharePoint',
  provider: 'microsoft',
  apiBase: 'https://graph.microsoft.com/v1.0',
  tools: [read, write, share],
  compensators: [versionRestore, permissionRevoke],
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
