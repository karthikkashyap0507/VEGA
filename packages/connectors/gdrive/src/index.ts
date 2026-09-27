import { z } from 'zod';
import { SourcedSchema } from '@vega/contracts';
import { Address, DAY_MS, defineCompensator, defineTool, externalOnly, sourced, ToolError, type ConnectorDefinition, type ToolContext } from '@vega/connector-sdk';

/**
 * Google Drive — docs/module2.md §5.2.
 *
 * | Tool         | Egress   | Rev | Max taint | Idempotency | Hold | Compensator             |
 * | gdrive.read  | INTERNAL | R0  | UNTRUSTED | NATIVE      | –    |                         |
 * | gdrive.write | INTERNAL | R1  | ORG       | KEYED       | –    | restore prior revision  |
 * | gdrive.share | EXTERNAL | R1  | TRUSTED   | KEYED       | ✅   | revoke permission       |
 *
 * SCOPE NOTE (module2.md §14, "document each unavoidable case"): acting on files the agent did
 * not create requires the broad `drive` scope for writes and sharing; `drive.file` would only
 * reach files created through this app. The consent screen shows this plainly.
 */

const SCOPE = {
  read: 'https://www.googleapis.com/auth/drive.readonly',
  write: 'https://www.googleapis.com/auth/drive',
} as const;
const FILES = '/drive/v3/files';

interface DFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  headRevisionId?: string;
  owners?: Array<{ emailAddress?: string }>;
}
interface DPermission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
}

const EXPORTABLE: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

const FileView = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), modifiedTime: z.string(), content: z.string() });

export const read = defineTool({
  toolId: 'gdrive.read',
  connectorKind: 'gdrive',
  version: 1,
  title: 'Read a file',
  description: 'Read a file’s text content. Content is always UNTRUSTED: anyone can share a file with you.',
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
  argsSchema: z.object({ fileId: z.string().min(1).max(256), maxBytes: z.number().int().min(1).max(5_000_000).default(1_000_000) }),
  effectSchema: z.object({ file: SourcedSchema(FileView).nullable() }),
  async simulate(args) {
    return { summary: `Reads file ${args.fileId}. Changes nothing.`, fidelity: 'DERIVED', externalRecipients: [], recordsAffected: [], detail: { file: null } };
  },
  async execute(args, ctx) {
    const meta = await ctx.http.json<DFile>(`${FILES}/${encodeURIComponent(args.fileId)}`, {
      query: { fields: 'id,name,mimeType,modifiedTime,size' },
    });
    const exportAs = meta.mimeType ? EXPORTABLE[meta.mimeType] : undefined;
    const raw = exportAs
      ? await ctx.http.text(`${FILES}/${encodeURIComponent(args.fileId)}/export`, { query: { mimeType: exportAs } })
      : await ctx.http.text(`${FILES}/${encodeURIComponent(args.fileId)}`, { query: { alt: 'media' } });
    const value = {
      id: meta.id,
      name: meta.name ?? '',
      mimeType: meta.mimeType ?? '',
      modifiedTime: meta.modifiedTime ?? '',
      content: raw.slice(0, args.maxBytes),
    };
    return {
      effect: {
        summary: `Read "${value.name}".`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [],
        detail: { file: sourced(value, { system: 'gdrive:file', id: meta.id, taint: 'UNTRUSTED' }) },
      },
    };
  },
});

export const write = defineTool({
  toolId: 'gdrive.write',
  connectorKind: 'gdrive',
  version: 1,
  title: 'Update a file',
  description: 'Replace a file’s content. The previous revision is kept and can be restored.',
  scopes: [SCOPE.write],
  egressClass: 'INTERNAL',
  reversibility: 'R1',
  compensatorRef: 'gdrive.revision.restore',
  maxTaint: 'ORG',
  idempotency: 'KEYED',
  sensitivityHint: 40,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: [],
  argsSchema: z.object({ fileId: z.string().min(1), content: z.string().max(5_000_000), mimeType: z.string().default('text/plain') }),
  effectSchema: z.object({ fileId: z.string(), previousRevisionId: z.string().nullable(), newRevisionId: z.string().nullable(), bytes: z.number().int() }),
  async simulate(args, ctx) {
    const meta = await ctx.http.json<DFile>(`${FILES}/${encodeURIComponent(args.fileId)}`, {
      query: { fields: 'id,name,size,headRevisionId' },
    });
    const bytes = Buffer.byteLength(args.content, 'utf8');
    return {
      summary: `Replaces the content of "${meta.name}" (${meta.size ?? '?'} → ${bytes} bytes). The current revision is kept.`,
      fidelity: 'DERIVED',
      externalRecipients: [],
      recordsAffected: [{ system: 'gdrive', id: args.fileId, field: 'content', before: { revisionId: meta.headRevisionId ?? null, size: Number(meta.size ?? 0) }, after: { size: bytes } }],
      detail: { fileId: args.fileId, previousRevisionId: meta.headRevisionId ?? null, newRevisionId: null, bytes },
    };
  },
  async execute(args, ctx) {
    const before = await ctx.http.json<DFile>(`${FILES}/${encodeURIComponent(args.fileId)}`, { query: { fields: 'id,name,size,headRevisionId' } });
    const updated = await ctx.http.json<DFile>(`/upload${FILES}/${encodeURIComponent(args.fileId)}`, {
      method: 'PATCH',
      query: { uploadType: 'media', fields: 'id,name,size,headRevisionId' },
      body: args.content,
      contentType: args.mimeType,
    });
    const bytes = Buffer.byteLength(args.content, 'utf8');
    return {
      providerRef: updated.headRevisionId ?? updated.id,
      effect: {
        summary: `Updated "${updated.name ?? before.name}".`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [{ system: 'gdrive', id: args.fileId, field: 'content', before: { revisionId: before.headRevisionId ?? null, size: Number(before.size ?? 0) }, after: { revisionId: updated.headRevisionId ?? null, size: bytes } }],
        detail: { fileId: args.fileId, previousRevisionId: before.headRevisionId ?? null, newRevisionId: updated.headRevisionId ?? null, bytes },
      },
    };
  },
});

export const share = defineTool({
  toolId: 'gdrive.share',
  connectorKind: 'gdrive',
  version: 1,
  title: 'Share a file',
  description: 'Give someone access to a file. The recipient must be TRUSTED; revoking undoes it.',
  scopes: [SCOPE.write],
  egressClass: 'EXTERNAL',
  reversibility: 'R1',
  compensatorRef: 'gdrive.permission.revoke',
  maxTaint: 'TRUSTED',
  idempotency: 'KEYED',
  sensitivityHint: 70,
  holdSupported: true,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: ['email'],
  argsSchema: z.object({ fileId: z.string().min(1), email: Address, role: z.enum(['reader', 'commenter', 'writer']) }),
  effectSchema: z.object({ fileId: z.string(), permissionId: z.string().nullable(), email: z.string(), role: z.string(), alreadyHadAccess: z.boolean() }),
  async simulate(args, ctx) {
    const perms = await ctx.http.json<{ permissions?: DPermission[] }>(`${FILES}/${encodeURIComponent(args.fileId)}/permissions`, {
      query: { fields: 'permissions(id,type,role,emailAddress)' },
    });
    const existing = (perms.permissions ?? []).find((p) => p.emailAddress?.toLowerCase() === args.email.toLowerCase());
    return {
      summary: existing
        ? `${args.email} already has ${existing.role} access; this changes it to ${args.role}.`
        : `Gives ${args.email} ${args.role} access and emails them a link.`,
      fidelity: 'DERIVED',
      externalRecipients: externalOnly([args.email], ctx.internalDomains),
      recordsAffected: [{ system: 'gdrive', id: args.fileId, field: 'permissions', before: existing ? { role: existing.role } : null, after: { email: args.email, role: args.role } }],
      reversibilityNote: 'The recipient is notified by email; revoking removes access but not the notification.',
      detail: { fileId: args.fileId, permissionId: existing?.id ?? null, email: args.email, role: args.role, alreadyHadAccess: Boolean(existing) },
    };
  },
  async execute(args, ctx) {
    // Someone who already has access keeps their permission object: the compensator (M6) must
    // restore THEIR prior role, never revoke access they had before this action.
    const perms = await ctx.http.json<{ permissions?: DPermission[] }>(`${FILES}/${encodeURIComponent(args.fileId)}/permissions`, {
      query: { fields: 'permissions(id,type,role,emailAddress)' },
    });
    const prior = (perms.permissions ?? []).find((p) => p.emailAddress?.toLowerCase() === args.email.toLowerCase());
    const perm =
      prior && prior.role === args.role
        ? prior
        : await ctx.http.json<DPermission>(`${FILES}/${encodeURIComponent(args.fileId)}/permissions`, {
            method: 'POST',
            query: { sendNotificationEmail: !prior, fields: 'id,type,role,emailAddress' },
            json: { type: 'user', role: args.role, emailAddress: args.email },
          });
    return {
      providerRef: perm.id,
      effect: {
        summary: prior ? `${args.email} already had ${prior.role} access; now ${args.role}.` : `Shared with ${args.email} as ${args.role}.`,
        fidelity: 'PROVIDER',
        externalRecipients: externalOnly([args.email], ctx.internalDomains),
        recordsAffected: [
          { system: 'gdrive', id: args.fileId, field: 'permissions', before: prior ? { role: prior.role } : null, after: { permissionId: perm.id, email: args.email, role: args.role } },
        ],
        reversibilityNote: prior ? 'Undo restores their previous role.' : 'The recipient was notified by email.',
        detail: { fileId: args.fileId, permissionId: perm.id, email: args.email, role: args.role, alreadyHadAccess: Boolean(prior) },
      },
    };
  },
});

// ------------------------------------------------------------------ compensators (docs/module6.md §5.4)

async function permissionFor(ctx: ToolContext, fileId: string, email: string): Promise<DPermission | undefined> {
  const perms = await ctx.http.json<{ permissions?: DPermission[] }>(`${FILES}/${encodeURIComponent(fileId)}/permissions`, {
    query: { fields: 'permissions(id,type,role,emailAddress)' },
  });
  return (perms.permissions ?? []).find((p) => p.emailAddress?.toLowerCase() === email.toLowerCase());
}

/**
 * Undoes `gdrive.write` by writing the previous revision's content back. EXACT for the content;
 * the version this action wrote stays in the file's history (Drive keeps revisions ~30 days).
 */
export const revisionRestore = defineCompensator<{ fileId: string; content: string; mimeType: string }, { revisionId: string | null; name: string; mimeType: string }>({
  ref: 'gdrive.revision.restore',
  toolId: 'gdrive.write',
  confidence: 'EXACT',
  sideEffects: 'SILENT',
  ttlMs: 30 * DAY_MS,
  describe: (t) => `Puts “${t.pre.name}” back to the version it had before this change. The changed version stays in the file’s history.`,
  async capture(args, ctx) {
    const meta = await ctx.http.json<DFile>(`${FILES}/${encodeURIComponent(args.fileId)}`, { query: { fields: 'id,name,mimeType,headRevisionId' } });
    return { revisionId: meta.headRevisionId ?? null, name: meta.name ?? args.fileId, mimeType: meta.mimeType ?? args.mimeType };
  },
  async compensate(t, ctx) {
    if (!t.pre.revisionId) throw new ToolError('NOT_FOUND', 'Drive reported no revision to restore', { committed: 'no' });
    const file = encodeURIComponent(t.args.fileId);
    const before = await ctx.http.text(`${FILES}/${file}/revisions/${encodeURIComponent(t.pre.revisionId)}`, { query: { alt: 'media' } });
    const now = await ctx.http.text(`${FILES}/${file}`, { query: { alt: 'media' } });
    if (now === before) {
      return t.forward
        ? { outcome: 'already_restored', summary: `“${t.pre.name}” already has its earlier content.`, notified: [] }
        : { outcome: 'not_needed', summary: `“${t.pre.name}” was never changed.`, notified: [] };
    }
    await ctx.http.json(`/upload${FILES}/${file}`, { method: 'PATCH', query: { uploadType: 'media', fields: 'id,headRevisionId' }, body: before, contentType: t.pre.mimeType });
    return { outcome: 'restored', summary: `Restored “${t.pre.name}” to its earlier version.`, notified: [], residual: 'The version this action wrote is still in the file’s history.' };
  },
});

/**
 * Undoes `gdrive.share`: removes the access it granted — or, for someone who already had
 * access, puts back THEIR previous role (never revokes access they had before).
 */
export const permissionRevoke = defineCompensator<{ fileId: string; email: string; role: string }, { prior: { id: string; role: string } | null }>({
  ref: 'gdrive.permission.revoke',
  toolId: 'gdrive.share',
  confidence: 'EXACT',
  sideEffects: 'SILENT',
  ttlMs: 90 * DAY_MS,
  describe: (t) =>
    t.pre.prior
      ? `Changes ${t.args.email} back to the ${t.pre.prior.role} access they had before.`
      : `Removes ${t.args.email}’s access to the file. They were emailed a link when it was shared and may already have opened it.`,
  async capture(args, ctx) {
    const prior = await permissionFor(ctx, args.fileId, args.email);
    return { prior: prior ? { id: prior.id, role: prior.role } : null };
  },
  async compensate(t, ctx) {
    const file = encodeURIComponent(t.args.fileId);
    const current = await permissionFor(ctx, t.args.fileId, t.args.email);
    const prior = t.pre.prior;
    if (prior) {
      if (current?.role === prior.role) return { outcome: 'already_restored', summary: `${t.args.email} already has ${prior.role} access again.`, notified: [] };
      if (current) {
        await ctx.http.json(`${FILES}/${file}/permissions/${encodeURIComponent(current.id)}`, { method: 'PATCH', json: { role: prior.role } });
      } else {
        await ctx.http.json(`${FILES}/${file}/permissions`, { method: 'POST', query: { sendNotificationEmail: false }, json: { type: 'user', role: prior.role, emailAddress: t.args.email } });
      }
      return { outcome: 'restored', summary: `${t.args.email} is back to ${prior.role} access.`, notified: [] };
    }
    if (!current) {
      return t.forward
        ? { outcome: 'already_restored', summary: `${t.args.email} already has no access.`, notified: [] }
        : { outcome: 'not_needed', summary: `${t.args.email} was never given access.`, notified: [] };
    }
    try {
      await ctx.http.json(`${FILES}/${file}/permissions/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
    } catch (e) {
      if (!(e instanceof ToolError && e.code === 'NOT_FOUND')) throw e;
    }
    return { outcome: 'restored', summary: `Removed ${t.args.email}’s access.`, notified: [], residual: 'They may have opened the file while they had access.' };
  },
});

export const gdrive: ConnectorDefinition = {
  kind: 'gdrive',
  displayName: 'Google Drive',
  provider: 'google',
  apiBase: 'https://www.googleapis.com',
  tools: [read, write, share],
  compensators: [revisionRestore, permissionRevoke],
  neverDoes: ['Delete files permanently', 'Make files public to anyone with the link', 'Transfer file ownership'],
  async health(ctx) {
    const started = Date.now();
    await ctx.http.json('/drive/v3/about', { query: { fields: 'user' } });
    return { ok: true, latencyMs: Date.now() - started };
  },
  async accountRef(ctx) {
    const about = await ctx.http.json<{ user?: { emailAddress?: string } }>('/drive/v3/about', { query: { fields: 'user' } });
    return (about.user?.emailAddress ?? 'unknown').toLowerCase();
  },
};

export default gdrive;
