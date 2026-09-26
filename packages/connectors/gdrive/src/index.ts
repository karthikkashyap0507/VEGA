import { z } from 'zod';
import { SourcedSchema } from '@vega/contracts';
import { Address, defineTool, externalOnly, sourced, type ConnectorDefinition } from '@vega/connector-sdk';

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

export const gdrive: ConnectorDefinition = {
  kind: 'gdrive',
  displayName: 'Google Drive',
  provider: 'google',
  apiBase: 'https://www.googleapis.com',
  tools: [read, write, share],
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
