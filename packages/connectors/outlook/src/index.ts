import { z } from 'zod';
import { SourcedSchema } from '@vega/contracts';
import { Address, allRecipients, defineTool, externalOnly, htmlToText, sourced, type ConnectorDefinition } from '@vega/connector-sdk';

/**
 * Outlook / Exchange via Microsoft Graph — docs/module2.md §5.2 (declared by analogy with Gmail).
 *
 * | Tool                 | Egress   | Rev | Max taint | Idempotency | Hold |
 * | outlook.search       | INTERNAL | R0  | UNTRUSTED | NATIVE      | –    |
 * | outlook.read         | INTERNAL | R0  | UNTRUSTED | NATIVE      | –    |
 * | outlook.draft        | INTERNAL | R1  | UNTRUSTED | KEYED       | –    |
 * | outlook.send         | EXTERNAL | R2  | TRUSTED   | KEYED       | ✅   |
 * | outlook.event_create | EXTERNAL | R1  | ORG       | KEYED       | ✅   |
 */

const SCOPE = {
  read: 'Mail.Read',
  write: 'Mail.ReadWrite',
  send: 'Mail.Send',
  calendar: 'Calendars.ReadWrite',
  me: 'User.Read',
} as const;

interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  internetMessageId?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  body?: { contentType: 'text' | 'html'; content: string };
}

const addr = (r?: GraphRecipient[]) => (r ?? []).map((x) => x.emailAddress.address.toLowerCase());
const recipients = (list: string[] | undefined) => (list ?? []).map((address) => ({ emailAddress: { address } }));

const Summary = z.object({ id: z.string(), conversationId: z.string(), from: z.string(), subject: z.string(), date: z.string(), snippet: z.string() });
const Full = Summary.extend({ to: z.array(z.string()), cc: z.array(z.string()), body: z.string(), internetMessageId: z.string() });

const summary = (m: GraphMessage) => ({
  id: m.id,
  conversationId: m.conversationId ?? '',
  from: m.from?.emailAddress.address ?? '',
  subject: m.subject ?? '',
  date: m.receivedDateTime ?? '',
  snippet: m.bodyPreview ?? '',
});

const Outgoing = z.object({
  to: z.array(Address).min(1).max(100),
  cc: z.array(Address).max(100).optional(),
  bcc: z.array(Address).max(100).optional(),
  subject: z.string().min(1).max(998),
  body: z.string().max(200_000),
});

export const search = defineTool({
  toolId: 'outlook.search',
  connectorKind: 'outlook',
  version: 1,
  title: 'Search mail',
  description: 'Find messages matching a search query.',
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
  argsSchema: z.object({ query: z.string().min(1).max(500), top: z.number().int().min(1).max(50).default(10) }),
  effectSchema: z.object({ messages: z.array(SourcedSchema(Summary)) }),
  async simulate(args) {
    return { summary: `Reads up to ${args.top} messages matching "${args.query}". Changes nothing.`, fidelity: 'DERIVED', externalRecipients: [], recordsAffected: [], detail: { messages: [] } };
  },
  async execute(args, ctx) {
    const res = await ctx.http.json<{ value?: GraphMessage[] }>('/me/messages', {
      query: { $search: `"${args.query.replace(/"/g, '')}"`, $top: args.top, $select: 'id,conversationId,subject,bodyPreview,receivedDateTime,from' },
    });
    const messages = (res.value ?? []).map((m) => sourced(summary(m), { system: 'outlook:message', id: m.id, taint: 'UNTRUSTED' }));
    return { effect: { summary: `Read ${messages.length} message header(s).`, fidelity: 'PROVIDER', externalRecipients: [], recordsAffected: [], detail: { messages } } };
  },
});

export const read = defineTool({
  toolId: 'outlook.read',
  connectorKind: 'outlook',
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
  argsSchema: z.object({ messageId: z.string().min(1).max(512) }),
  effectSchema: z.object({ message: SourcedSchema(Full).nullable() }),
  async simulate(args) {
    return { summary: `Reads message ${args.messageId}. Changes nothing.`, fidelity: 'DERIVED', externalRecipients: [], recordsAffected: [], detail: { message: null } };
  },
  async execute(args, ctx) {
    const m = await ctx.http.json<GraphMessage>(`/me/messages/${encodeURIComponent(args.messageId)}`);
    const body = m.body?.contentType === 'html' ? htmlToText(m.body.content) : (m.body?.content ?? '');
    const value = { ...summary(m), to: addr(m.toRecipients), cc: addr(m.ccRecipients), body, internetMessageId: m.internetMessageId ?? '' };
    return {
      effect: {
        summary: `Read message "${value.subject}".`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [],
        detail: { message: sourced(value, { system: 'outlook:message', id: m.id, taint: 'UNTRUSTED' }) },
      },
    };
  },
});

export const draft = defineTool({
  toolId: 'outlook.draft',
  connectorKind: 'outlook',
  version: 1,
  title: 'Create a draft',
  description: 'Create a draft. Nothing is sent; the draft can be deleted.',
  scopes: [SCOPE.write],
  egressClass: 'INTERNAL',
  reversibility: 'R1',
  compensatorRef: 'outlook.draft.delete',
  maxTaint: 'UNTRUSTED',
  idempotency: 'KEYED',
  sensitivityHint: 30,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: [],
  argsSchema: Outgoing,
  effectSchema: z.object({ draftId: z.string().nullable(), to: z.array(z.string()), subject: z.string() }),
  async simulate(args) {
    return {
      summary: `Creates a draft to ${allRecipients(args).join(', ')} titled "${args.subject}". Nothing is sent.`,
      fidelity: 'DERIVED',
      externalRecipients: [],
      recordsAffected: [{ system: 'outlook', id: '(new draft)', field: 'draft', after: { to: args.to, subject: args.subject } }],
      detail: { draftId: null, to: args.to, subject: args.subject },
    };
  },
  async execute(args, ctx) {
    const created = await ctx.http.json<GraphMessage>('/me/messages', {
      method: 'POST',
      json: {
        subject: args.subject,
        body: { contentType: 'text', content: args.body },
        toRecipients: recipients(args.to),
        ccRecipients: recipients(args.cc),
        bccRecipients: recipients(args.bcc),
      },
    });
    return {
      providerRef: created.id,
      effect: {
        summary: `Created draft to ${allRecipients(args).join(', ')}.`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [{ system: 'outlook', id: created.id, field: 'draft', after: { to: args.to, subject: args.subject } }],
        detail: { draftId: created.id, to: args.to, subject: args.subject },
      },
    };
  },
});

export const send = defineTool({
  toolId: 'outlook.send',
  connectorKind: 'outlook',
  version: 1,
  title: 'Send a message',
  description: 'Send an email on the user’s behalf. Held before release; recipients must be TRUSTED.',
  scopes: [SCOPE.send],
  egressClass: 'EXTERNAL',
  reversibility: 'R2',
  compensatorRef: 'outlook.send.recall',
  maxTaint: 'TRUSTED',
  idempotency: 'KEYED',
  sensitivityHint: 70,
  holdSupported: true,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: ['to', 'cc', 'bcc'],
  argsSchema: Outgoing,
  effectSchema: z.object({ recipients: z.array(z.string()), subject: z.string() }),
  async simulate(args, ctx) {
    const all = allRecipients(args);
    const external = externalOnly(all, ctx.internalDomains);
    return {
      summary: `Sends "${args.subject}" to ${all.length} recipient(s)${external.length ? `, ${external.length} outside your organization` : ''}.`,
      fidelity: 'DERIVED',
      externalRecipients: external,
      recordsAffected: [{ system: 'outlook', id: '(new message)', field: 'sent', after: { to: all, subject: args.subject } }],
      reversibilityNote: 'Held before release. Once released, recipients have the message; only a correction can follow.',
      detail: { recipients: all, subject: args.subject },
    };
  },
  async execute(args, ctx) {
    const all = allRecipients(args);
    // Graph's sendMail answers 202 with no body; the message has no id we can return.
    await ctx.http.json('/me/sendMail', {
      method: 'POST',
      json: {
        message: {
          subject: args.subject,
          body: { contentType: 'text', content: args.body },
          toRecipients: recipients(args.to),
          ccRecipients: recipients(args.cc),
          bccRecipients: recipients(args.bcc),
          ...(ctx.idempotencyKey ? { internetMessageHeaders: [{ name: 'x-idempotency-key', value: ctx.idempotencyKey }] } : {}),
        },
        saveToSentItems: true,
      },
    });
    return {
      effect: {
        summary: `Sent "${args.subject}" to ${all.length} recipient(s).`,
        fidelity: 'PROVIDER',
        externalRecipients: externalOnly(all, ctx.internalDomains),
        recordsAffected: [{ system: 'outlook', id: ctx.idempotencyKey ?? '(sent)', field: 'sent', after: { to: all, subject: args.subject } }],
        reversibilityNote: 'Recipients have the message; only a correction can follow.',
        detail: { recipients: all, subject: args.subject },
      },
    };
  },
});

const IsoDateTime = z.string().datetime({ offset: true });

export const eventCreate = defineTool({
  toolId: 'outlook.event_create',
  connectorKind: 'outlook',
  version: 1,
  title: 'Create an event',
  description: 'Create a calendar event and invite attendees. Attendees are notified.',
  scopes: [SCOPE.calendar],
  egressClass: 'EXTERNAL',
  reversibility: 'R1',
  compensatorRef: 'outlook.event.delete',
  maxTaint: 'ORG',
  idempotency: 'KEYED',
  sensitivityHint: 40,
  holdSupported: true,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: ['attendees'],
  argsSchema: z
    .object({ subject: z.string().min(1).max(255), start: IsoDateTime, end: IsoDateTime, attendees: z.array(Address).max(200).default([]), body: z.string().max(8192).optional() })
    .refine((e) => Date.parse(e.end) > Date.parse(e.start), { message: 'end must be after start', path: ['end'] }),
  effectSchema: z.object({ eventId: z.string().nullable(), subject: z.string(), attendees: z.array(z.string()) }),
  async simulate(args, ctx) {
    return {
      summary: `Creates "${args.subject}" with ${args.attendees.length} attendee(s).`,
      fidelity: 'DERIVED',
      externalRecipients: externalOnly(args.attendees, ctx.internalDomains),
      recordsAffected: [{ system: 'outlook', id: '(new event)', after: { subject: args.subject, start: args.start, end: args.end } }],
      reversibilityNote: 'Attendees receive an invitation; undoing it sends them a cancellation.',
      detail: { eventId: null, subject: args.subject, attendees: args.attendees },
    };
  },
  async execute(args, ctx) {
    const created = await ctx.http.json<{ id: string }>('/me/events', {
      method: 'POST',
      ...(ctx.idempotencyKey ? { headers: { 'transaction-id': ctx.idempotencyKey } } : {}),
      json: {
        subject: args.subject,
        ...(args.body ? { body: { contentType: 'text', content: args.body } } : {}),
        start: { dateTime: args.start, timeZone: 'UTC' },
        end: { dateTime: args.end, timeZone: 'UTC' },
        attendees: args.attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
        // Graph dedupes event creation on transactionId (native idempotency for this call).
        ...(ctx.idempotencyKey ? { transactionId: ctx.idempotencyKey } : {}),
      },
    });
    return {
      providerRef: created.id,
      effect: {
        summary: `Created "${args.subject}" and notified ${args.attendees.length} attendee(s).`,
        fidelity: 'PROVIDER',
        externalRecipients: externalOnly(args.attendees, ctx.internalDomains),
        recordsAffected: [{ system: 'outlook', id: created.id, after: { subject: args.subject, start: args.start, end: args.end } }],
        reversibilityNote: 'Attendees were invited; undoing it sends them a cancellation.',
        detail: { eventId: created.id, subject: args.subject, attendees: args.attendees },
      },
    };
  },
});

export const outlook: ConnectorDefinition = {
  kind: 'outlook',
  displayName: 'Outlook',
  provider: 'microsoft',
  apiBase: 'https://graph.microsoft.com/v1.0',
  tools: [search, read, draft, send, eventCreate],
  neverDoes: ['Delete messages', 'Change mailbox rules or forwarding', 'Access other people’s mailboxes'],
  async health(ctx) {
    const started = Date.now();
    await ctx.http.json('/me', { query: { $select: 'id' } });
    return { ok: true, latencyMs: Date.now() - started };
  },
  async accountRef(ctx) {
    const me = await ctx.http.json<{ mail?: string; userPrincipalName?: string }>('/me', { query: { $select: 'mail,userPrincipalName' } });
    return (me.mail ?? me.userPrincipalName ?? 'unknown').toLowerCase();
  },
};

export default outlook;
