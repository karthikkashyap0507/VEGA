import { z } from 'zod';
import { SourcedSchema } from '@vega/contracts';
import {
  Address,
  allRecipients,
  defineTool,
  externalOnly,
  htmlToText,
  rawMessage,
  sourced,
  type ConnectorDefinition,
  type ToolContext,
} from '@vega/connector-sdk';

/**
 * Gmail — docs/module2.md §5.2.
 *
 * | Tool         | Egress   | Rev | Max taint | Idempotency | Hold |
 * | gmail.search | INTERNAL | R0  | UNTRUSTED | NATIVE      | –    |
 * | gmail.read   | INTERNAL | R0  | UNTRUSTED | NATIVE      | –    |
 * | gmail.draft  | INTERNAL | R1  | UNTRUSTED | KEYED       | –    |
 * | gmail.send   | EXTERNAL | R2  | TRUSTED   | KEYED       | ✅   |
 * | gmail.label  | INTERNAL | R1  | ORG       | KEYED       | –    |
 *
 * `gmail.send` has maxTaint TRUSTED: a body derived from an untrusted email may be SHOWN to a
 * human, never sent autonomously, and an untrusted value can never populate a recipient.
 * Module 3 enforces it; this file declares it.
 */

const SCOPE = {
  read: 'https://www.googleapis.com/auth/gmail.readonly',
  compose: 'https://www.googleapis.com/auth/gmail.compose',
  send: 'https://www.googleapis.com/auth/gmail.send',
  modify: 'https://www.googleapis.com/auth/gmail.modify',
} as const;

const BASE = '/gmail/v1/users/me';

// ------------------------------------------------------------------ provider shapes

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: GmailHeader[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
}

const headerOf = (m: GmailMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const addresses = (v: string) =>
  v
    .split(',')
    .map((a) => (a.match(/<([^>]+)>/)?.[1] ?? a).trim().toLowerCase())
    .filter(Boolean);

function decode(data?: string): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

/** Prefer text/plain; fall back to text/html converted to text. Attachments are not read here. */
function bodyOf(part?: GmailPart): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain') return decode(part.body?.data);
  if (part.parts?.length) {
    const plain = part.parts.find((p) => p.mimeType === 'text/plain');
    if (plain) return decode(plain.body?.data);
    for (const p of part.parts) {
      const nested = bodyOf(p);
      if (nested) return nested;
    }
  }
  if (part.mimeType === 'text/html') return htmlToText(decode(part.body?.data));
  return '';
}

// ------------------------------------------------------------------ schemas

const MessageSummary = z.object({
  id: z.string(),
  threadId: z.string(),
  from: z.string(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
});

const MessageFull = MessageSummary.extend({
  to: z.array(z.string()),
  cc: z.array(z.string()),
  body: z.string(),
  labelIds: z.array(z.string()),
  rfc822MessageId: z.string(),
});

const Outgoing = z.object({
  to: z.array(Address).min(1).max(100),
  cc: z.array(Address).max(100).optional(),
  bcc: z.array(Address).max(100).optional(),
  subject: z.string().min(1).max(998),
  body: z.string().max(200_000),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
});

function summary(m: GmailMessage) {
  return {
    id: m.id,
    threadId: m.threadId,
    from: headerOf(m, 'From'),
    subject: headerOf(m, 'Subject'),
    date: headerOf(m, 'Date'),
    snippet: m.snippet ?? '',
  };
}

/** Deterministic RFC 5322 Message-ID from the run's idempotency key, when there is one. */
function messageIdFor(ctx: ToolContext): string | undefined {
  return ctx.idempotencyKey ? `<${ctx.idempotencyKey}@agent.invalid>` : undefined;
}

// ------------------------------------------------------------------ tools

export const search = defineTool({
  toolId: 'gmail.search',
  connectorKind: 'gmail',
  version: 1,
  title: 'Search mail',
  description: 'Find messages matching a Gmail search query. Returns headers and snippets.',
  scopes: [SCOPE.read],
  egressClass: 'INTERNAL',
  reversibility: 'R0',
  maxTaint: 'UNTRUSTED',
  idempotency: 'NATIVE',
  sensitivityHint: 40,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'UNTRUSTED',
  recipientArgs: [],
  argsSchema: z.object({ query: z.string().min(1).max(500), maxResults: z.number().int().min(1).max(50).default(10) }),
  effectSchema: z.object({ messages: z.array(SourcedSchema(MessageSummary)) }),
  async simulate(args) {
    return {
      summary: `Reads up to ${args.maxResults} messages matching "${args.query}". Changes nothing.`,
      fidelity: 'DERIVED',
      externalRecipients: [],
      recordsAffected: [],
      detail: { messages: [] },
    };
  },
  async execute(args, ctx) {
    const list = await ctx.http.json<{ messages?: Array<{ id: string }> }>(`${BASE}/messages`, {
      query: { q: args.query, maxResults: args.maxResults },
    });
    const messages = await Promise.all(
      (list.messages ?? []).map(async ({ id }) => {
        const m = await ctx.http.json<GmailMessage>(`${BASE}/messages/${encodeURIComponent(id)}`, {
          query: { format: 'metadata', metadataHeaders: 'From,Subject,Date' },
        });
        // Headers and snippets are attacker-controlled: whoever sent the mail wrote them.
        return sourced(summary(m), { system: 'gmail:message', id: m.id, taint: 'UNTRUSTED' });
      }),
    );
    return {
      effect: {
        summary: `Read ${messages.length} message header(s).`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [],
        detail: { messages },
      },
    };
  },
});

export const read = defineTool({
  toolId: 'gmail.read',
  connectorKind: 'gmail',
  version: 1,
  title: 'Read a message',
  description: 'Read one message including its body. The body is always UNTRUSTED.',
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
  argsSchema: z.object({ messageId: z.string().min(1).max(256) }),
  effectSchema: z.object({ message: SourcedSchema(MessageFull).nullable() }),
  async simulate(args) {
    return {
      summary: `Reads message ${args.messageId}. Changes nothing.`,
      fidelity: 'DERIVED',
      externalRecipients: [],
      recordsAffected: [],
      detail: { message: null },
    };
  },
  async execute(args, ctx) {
    const m = await ctx.http.json<GmailMessage>(`${BASE}/messages/${encodeURIComponent(args.messageId)}`, {
      query: { format: 'full' },
    });
    const value = {
      ...summary(m),
      to: addresses(headerOf(m, 'To')),
      cc: addresses(headerOf(m, 'Cc')),
      body: bodyOf(m.payload),
      labelIds: m.labelIds ?? [],
      rfc822MessageId: headerOf(m, 'Message-ID'),
    };
    return {
      effect: {
        summary: `Read message "${value.subject}".`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [],
        detail: { message: sourced(value, { system: 'gmail:message', id: m.id, taint: 'UNTRUSTED' }) },
      },
    };
  },
});

const DraftDetail = z.object({ draftId: z.string().nullable(), messageId: z.string().nullable(), to: z.array(z.string()), subject: z.string() });

export const draft = defineTool({
  toolId: 'gmail.draft',
  connectorKind: 'gmail',
  version: 1,
  title: 'Create a draft',
  description: 'Create a draft in the mailbox. Nothing is sent; the draft can be deleted.',
  scopes: [SCOPE.compose],
  egressClass: 'INTERNAL',
  reversibility: 'R1',
  compensatorRef: 'gmail.draft.delete',
  maxTaint: 'UNTRUSTED',
  idempotency: 'KEYED',
  sensitivityHint: 30,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: [],
  argsSchema: Outgoing,
  effectSchema: DraftDetail,
  async simulate(args) {
    return {
      summary: `Creates a draft to ${allRecipients(args).join(', ')} titled "${args.subject}". Nothing is sent.`,
      fidelity: 'DERIVED',
      externalRecipients: [],
      recordsAffected: [{ system: 'gmail', id: '(new draft)', field: 'draft', after: { to: args.to, subject: args.subject } }],
      detail: { draftId: null, messageId: null, to: args.to, subject: args.subject },
    };
  },
  async execute(args, ctx) {
    const created = await ctx.http.json<{ id: string; message: { id: string } }>(`${BASE}/drafts`, {
      method: 'POST',
      json: {
        message: {
          raw: rawMessage({ ...args, messageId: messageIdFor(ctx) }),
          ...(args.threadId ? { threadId: args.threadId } : {}),
        },
      },
    });
    return {
      providerRef: created.id,
      effect: {
        summary: `Created draft to ${allRecipients(args).join(', ')}.`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [{ system: 'gmail', id: created.id, field: 'draft', after: { to: args.to, subject: args.subject } }],
        detail: { draftId: created.id, messageId: created.message.id, to: args.to, subject: args.subject },
      },
    };
  },
});

export const send = defineTool({
  toolId: 'gmail.send',
  connectorKind: 'gmail',
  version: 1,
  title: 'Send a message',
  description: 'Send an email on the user’s behalf. Held before release; recipients must be TRUSTED.',
  scopes: [SCOPE.send],
  egressClass: 'EXTERNAL',
  reversibility: 'R2',
  // R2: the hold buffer (M6) is the undo. Once released, a follow-up correction is all that is possible.
  compensatorRef: 'gmail.send.recall',
  maxTaint: 'TRUSTED',
  idempotency: 'KEYED',
  sensitivityHint: 70,
  holdSupported: true,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: ['to', 'cc', 'bcc'],
  argsSchema: Outgoing,
  effectSchema: z.object({ messageId: z.string().nullable(), threadId: z.string().nullable(), recipients: z.array(z.string()), subject: z.string() }),
  async simulate(args, ctx) {
    const recipients = allRecipients(args);
    const external = externalOnly(recipients, ctx.internalDomains);
    return {
      summary: `Sends "${args.subject}" to ${recipients.length} recipient(s)${external.length ? `, ${external.length} outside your organization` : ''}.`,
      fidelity: 'DERIVED',
      externalRecipients: external,
      recordsAffected: [{ system: 'gmail', id: '(new message)', field: 'sent', after: { to: recipients, subject: args.subject } }],
      reversibilityNote: 'Held before release. Once released, recipients have the message; only a correction can follow.',
      detail: { messageId: null, threadId: args.threadId ?? null, recipients, subject: args.subject },
    };
  },
  async execute(args, ctx) {
    const recipients = allRecipients(args);
    const sent = await ctx.http.json<{ id: string; threadId: string }>(`${BASE}/messages/send`, {
      method: 'POST',
      json: {
        raw: rawMessage({ ...args, messageId: messageIdFor(ctx) }),
        ...(args.threadId ? { threadId: args.threadId } : {}),
      },
    });
    return {
      providerRef: sent.id,
      effect: {
        summary: `Sent "${args.subject}" to ${recipients.length} recipient(s).`,
        fidelity: 'PROVIDER',
        externalRecipients: externalOnly(recipients, ctx.internalDomains),
        recordsAffected: [{ system: 'gmail', id: sent.id, field: 'sent', after: { to: recipients, subject: args.subject } }],
        reversibilityNote: 'Recipients have the message; only a correction can follow.',
        detail: { messageId: sent.id, threadId: sent.threadId, recipients, subject: args.subject },
      },
    };
  },
});

export const label = defineTool({
  toolId: 'gmail.label',
  connectorKind: 'gmail',
  version: 1,
  title: 'Label a message',
  description: 'Add labels to a message. Removing the same labels undoes it.',
  scopes: [SCOPE.modify],
  egressClass: 'INTERNAL',
  reversibility: 'R1',
  compensatorRef: 'gmail.label.remove',
  maxTaint: 'ORG',
  idempotency: 'KEYED',
  sensitivityHint: 10,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: [],
  argsSchema: z.object({ messageId: z.string().min(1), labelIds: z.array(z.string().min(1)).min(1).max(10) }),
  effectSchema: z.object({ messageId: z.string(), added: z.array(z.string()) }),
  async simulate(args, ctx) {
    const m = await ctx.http.json<GmailMessage>(`${BASE}/messages/${encodeURIComponent(args.messageId)}`, {
      query: { format: 'minimal' },
    });
    const before = m.labelIds ?? [];
    const added = args.labelIds.filter((l) => !before.includes(l));
    return {
      summary: added.length ? `Adds label(s) ${added.join(', ')} to one message.` : 'No change: the message already has these labels.',
      fidelity: 'DERIVED',
      externalRecipients: [],
      recordsAffected: [{ system: 'gmail', id: args.messageId, field: 'labelIds', before, after: [...new Set([...before, ...args.labelIds])] }],
      detail: { messageId: args.messageId, added },
    };
  },
  async execute(args, ctx) {
    const before = (
      await ctx.http.json<GmailMessage>(`${BASE}/messages/${encodeURIComponent(args.messageId)}`, { query: { format: 'minimal' } })
    ).labelIds ?? [];
    const after = await ctx.http.json<GmailMessage>(`${BASE}/messages/${encodeURIComponent(args.messageId)}/modify`, {
      method: 'POST',
      json: { addLabelIds: args.labelIds },
    });
    const added = args.labelIds.filter((l) => !before.includes(l));
    return {
      providerRef: args.messageId,
      effect: {
        summary: `Added ${added.length} label(s).`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [{ system: 'gmail', id: args.messageId, field: 'labelIds', before, after: after.labelIds ?? [] }],
        detail: { messageId: args.messageId, added },
      },
    };
  },
});

export const gmail: ConnectorDefinition = {
  kind: 'gmail',
  displayName: 'Gmail',
  provider: 'google',
  apiBase: 'https://gmail.googleapis.com',
  tools: [search, read, draft, send, label],
  neverDoes: ['Delete messages', 'Change your mail settings or filters', 'Forward mail automatically'],
  async health(ctx) {
    const started = Date.now();
    await ctx.http.json(`${BASE}/profile`);
    return { ok: true, latencyMs: Date.now() - started };
  },
  async accountRef(ctx) {
    const profile = await ctx.http.json<{ emailAddress: string }>(`${BASE}/profile`);
    return profile.emailAddress.toLowerCase();
  },
};

export default gmail;
