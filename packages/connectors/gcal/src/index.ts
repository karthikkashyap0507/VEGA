import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SourcedSchema } from '@vega/contracts';
import { Address, defineTool, externalOnly, sourced, ToolError, type ConnectorDefinition, type ToolContext } from '@vega/connector-sdk';

/**
 * Google Calendar — docs/module2.md §5.2.
 *
 * | Tool        | Egress   | Rev | Max taint | Idempotency | Hold | Compensator            |
 * | gcal.list   | INTERNAL | R0  | ORG       | NATIVE      | –    |                        |
 * | gcal.create | EXTERNAL | R1  | ORG       | KEYED       | ✅   | delete + notify        |
 * | gcal.update | EXTERNAL | R1  | ORG       | KEYED       | ✅   | restore snapshot       |
 * | gcal.delete | EXTERNAL | R1  | ORG       | KEYED       | ✅   | recreate from snapshot |
 *
 * Calendar changes are EXTERNAL because attendees are notified. The compensators undo the
 * record; they cannot un-notify — every effect says so in `reversibilityNote`.
 */

const SCOPE = {
  read: 'https://www.googleapis.com/auth/calendar.events.readonly',
  write: 'https://www.googleapis.com/auth/calendar.events',
  freebusy: 'https://www.googleapis.com/auth/calendar.freebusy',
} as const;
const EVENTS = '/calendar/v3/calendars/primary/events';

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email: string; responseStatus?: string }>;
  organizer?: { email?: string };
  htmlLink?: string;
}

const EventView = z.object({
  id: z.string(),
  summary: z.string(),
  description: z.string(),
  location: z.string(),
  start: z.string(),
  end: z.string(),
  attendees: z.array(z.string()),
  organizer: z.string(),
});
type EventView = z.infer<typeof EventView>;

function view(e: GEvent): EventView {
  return {
    id: e.id,
    summary: e.summary ?? '',
    description: e.description ?? '',
    location: e.location ?? '',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    attendees: (e.attendees ?? []).map((a) => a.email.toLowerCase()),
    organizer: e.organizer?.email ?? '',
  };
}

const IsoDateTime = z.string().datetime({ offset: true });
const EventInput = z
  .object({
    summary: z.string().min(1).max(1024),
    description: z.string().max(8192).optional(),
    location: z.string().max(1024).optional(),
    start: IsoDateTime,
    end: IsoDateTime,
    attendees: z.array(Address).max(200).default([]),
  })
  .refine((e) => Date.parse(e.end) > Date.parse(e.start), { message: 'end must be after start', path: ['end'] });

/**
 * Google accepts a client-chosen event id (base32hex, 5–1024 chars). Deriving it from the
 * idempotency key makes a retried create a provider-side 409 rather than a duplicate event.
 */
function eventIdFor(ctx: ToolContext): string | undefined {
  if (!ctx.idempotencyKey) return undefined;
  const hex = createHash('sha256').update(ctx.idempotencyKey).digest('hex');
  return `a${hex.slice(0, 40)}`.replace(/[^a-v0-9]/g, '0');
}

async function conflicts(ctx: ToolContext, start: string, end: string): Promise<number> {
  const fb = await ctx.http.json<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> }>(
    '/calendar/v3/freeBusy',
    { method: 'POST', json: { timeMin: start, timeMax: end, items: [{ id: 'primary' }] } },
  );
  return fb.calendars?.['primary']?.busy?.length ?? 0;
}

const EventEffect = z.object({ eventId: z.string().nullable(), event: EventView.nullable(), conflicts: z.number().int() });

export const list = defineTool({
  toolId: 'gcal.list',
  connectorKind: 'gcal',
  version: 1,
  title: 'List events',
  description: 'List events on the primary calendar in a time window.',
  scopes: [SCOPE.read],
  egressClass: 'INTERNAL',
  reversibility: 'R0',
  maxTaint: 'ORG',
  idempotency: 'NATIVE',
  sensitivityHint: 30,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  // Titles and descriptions are written by whoever sent the invite, often outside the tenant.
  outputTaint: 'UNTRUSTED',
  recipientArgs: [],
  argsSchema: z.object({ timeMin: IsoDateTime, timeMax: IsoDateTime, maxResults: z.number().int().min(1).max(250).default(50) }),
  effectSchema: z.object({ events: z.array(SourcedSchema(EventView)) }),
  async simulate(args) {
    return {
      summary: `Reads events between ${args.timeMin} and ${args.timeMax}. Changes nothing.`,
      fidelity: 'DERIVED',
      externalRecipients: [],
      recordsAffected: [],
      detail: { events: [] },
    };
  },
  async execute(args, ctx) {
    const res = await ctx.http.json<{ items?: GEvent[] }>(EVENTS, {
      query: { timeMin: args.timeMin, timeMax: args.timeMax, maxResults: args.maxResults, singleEvents: true, orderBy: 'startTime' },
    });
    const events = (res.items ?? []).map((e) => sourced(view(e), { system: 'gcal:event', id: e.id, taint: 'UNTRUSTED' }));
    return {
      effect: { summary: `Read ${events.length} event(s).`, fidelity: 'PROVIDER', externalRecipients: [], recordsAffected: [], detail: { events } },
    };
  },
});

export const create = defineTool({
  toolId: 'gcal.create',
  connectorKind: 'gcal',
  version: 1,
  title: 'Create an event',
  description: 'Create an event and invite attendees. Attendees are notified.',
  scopes: [SCOPE.write, SCOPE.freebusy],
  egressClass: 'EXTERNAL',
  reversibility: 'R1',
  compensatorRef: 'gcal.event.delete',
  maxTaint: 'ORG',
  idempotency: 'KEYED',
  sensitivityHint: 40,
  holdSupported: true,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: ['attendees'],
  argsSchema: EventInput,
  effectSchema: EventEffect,
  async simulate(args, ctx) {
    const clash = await conflicts(ctx, args.start, args.end);
    const external = externalOnly(args.attendees, ctx.internalDomains);
    return {
      summary: `Creates "${args.summary}" with ${args.attendees.length} attendee(s)${clash ? `; overlaps ${clash} existing event(s)` : ''}.`,
      fidelity: 'DERIVED',
      externalRecipients: external,
      recordsAffected: [{ system: 'gcal', id: '(new event)', after: { summary: args.summary, start: args.start, end: args.end } }],
      reversibilityNote: 'Attendees receive an invitation; undoing it sends them a cancellation.',
      detail: { eventId: null, event: null, conflicts: clash },
    };
  },
  async execute(args, ctx) {
    const id = eventIdFor(ctx);
    let created: GEvent;
    try {
      created = await ctx.http.json<GEvent>(EVENTS, {
        method: 'POST',
        query: { sendUpdates: 'all' },
        json: {
          ...(id ? { id } : {}),
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: { dateTime: args.start },
          end: { dateTime: args.end },
          attendees: args.attendees.map((email) => ({ email })),
        },
      });
    } catch (error) {
      // Our own id already exists: a previous attempt committed. Return that event.
      if (id && error instanceof ToolError && error.code === 'CONFLICT') {
        created = await ctx.http.json<GEvent>(`${EVENTS}/${id}`);
      } else throw error;
    }
    return {
      providerRef: created.id,
      effect: {
        summary: `Created "${args.summary}" and notified ${args.attendees.length} attendee(s).`,
        fidelity: 'PROVIDER',
        externalRecipients: externalOnly(args.attendees, ctx.internalDomains),
        recordsAffected: [{ system: 'gcal', id: created.id, after: view(created) }],
        reversibilityNote: 'Attendees were invited; undoing it sends them a cancellation.',
        detail: { eventId: created.id, event: view(created), conflicts: 0 },
      },
    };
  },
});

const Patch = z.object({
  summary: z.string().min(1).max(1024).optional(),
  description: z.string().max(8192).optional(),
  location: z.string().max(1024).optional(),
  start: IsoDateTime.optional(),
  end: IsoDateTime.optional(),
  attendees: z.array(Address).max(200).optional(),
});

function patchBody(p: z.infer<typeof Patch>) {
  return {
    ...(p.summary !== undefined ? { summary: p.summary } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.location !== undefined ? { location: p.location } : {}),
    ...(p.start ? { start: { dateTime: p.start } } : {}),
    ...(p.end ? { end: { dateTime: p.end } } : {}),
    ...(p.attendees ? { attendees: p.attendees.map((email) => ({ email })) } : {}),
  };
}

export const update = defineTool({
  toolId: 'gcal.update',
  connectorKind: 'gcal',
  version: 1,
  title: 'Update an event',
  description: 'Change an event. The previous version is captured so it can be restored.',
  scopes: [SCOPE.write],
  egressClass: 'EXTERNAL',
  reversibility: 'R1',
  compensatorRef: 'gcal.event.restore',
  maxTaint: 'ORG',
  idempotency: 'KEYED',
  sensitivityHint: 40,
  holdSupported: true,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: ['patch.attendees'],
  argsSchema: z.object({ eventId: z.string().min(1), patch: Patch }),
  effectSchema: EventEffect,
  async simulate(args, ctx) {
    const current = view(await ctx.http.json<GEvent>(`${EVENTS}/${encodeURIComponent(args.eventId)}`));
    const next = { ...current, ...args.patch, attendees: args.patch.attendees ?? current.attendees };
    return {
      summary: `Updates "${current.summary}" (${Object.keys(args.patch).join(', ')}).`,
      fidelity: 'DERIVED',
      externalRecipients: externalOnly(next.attendees, ctx.internalDomains),
      recordsAffected: [{ system: 'gcal', id: args.eventId, before: current, after: next }],
      reversibilityNote: 'Attendees are notified of the change; restoring it notifies them again.',
      detail: { eventId: args.eventId, event: current, conflicts: 0 },
    };
  },
  async execute(args, ctx) {
    const before = view(await ctx.http.json<GEvent>(`${EVENTS}/${encodeURIComponent(args.eventId)}`));
    const after = await ctx.http.json<GEvent>(`${EVENTS}/${encodeURIComponent(args.eventId)}`, {
      method: 'PATCH',
      query: { sendUpdates: 'all' },
      json: patchBody(args.patch),
    });
    return {
      providerRef: after.id,
      effect: {
        summary: `Updated "${before.summary}".`,
        fidelity: 'PROVIDER',
        externalRecipients: externalOnly(view(after).attendees, ctx.internalDomains),
        recordsAffected: [{ system: 'gcal', id: after.id, before, after: view(after) }],
        reversibilityNote: 'Attendees were notified of the change.',
        detail: { eventId: after.id, event: view(after), conflicts: 0 },
      },
    };
  },
});

export const remove = defineTool({
  toolId: 'gcal.delete',
  connectorKind: 'gcal',
  version: 1,
  title: 'Cancel an event',
  description: 'Cancel an event. A full snapshot is kept so it can be recreated.',
  scopes: [SCOPE.write],
  egressClass: 'EXTERNAL',
  reversibility: 'R1',
  compensatorRef: 'gcal.event.recreate',
  maxTaint: 'ORG',
  idempotency: 'KEYED',
  sensitivityHint: 50,
  holdSupported: true,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: [],
  argsSchema: z.object({ eventId: z.string().min(1) }),
  effectSchema: EventEffect,
  async simulate(args, ctx) {
    const snapshot = view(await ctx.http.json<GEvent>(`${EVENTS}/${encodeURIComponent(args.eventId)}`));
    return {
      summary: `Cancels "${snapshot.summary}" for ${snapshot.attendees.length} attendee(s).`,
      fidelity: 'DERIVED',
      externalRecipients: externalOnly(snapshot.attendees, ctx.internalDomains),
      recordsAffected: [{ system: 'gcal', id: args.eventId, before: snapshot, after: null }],
      reversibilityNote: 'Attendees will see a cancellation; recreating it sends a new invitation.',
      detail: { eventId: args.eventId, event: snapshot, conflicts: 0 },
    };
  },
  async execute(args, ctx) {
    const snapshot = view(await ctx.http.json<GEvent>(`${EVENTS}/${encodeURIComponent(args.eventId)}`));
    await ctx.http.json(`${EVENTS}/${encodeURIComponent(args.eventId)}`, { method: 'DELETE', query: { sendUpdates: 'all' } });
    return {
      providerRef: args.eventId,
      effect: {
        summary: `Cancelled "${snapshot.summary}".`,
        fidelity: 'PROVIDER',
        externalRecipients: externalOnly(snapshot.attendees, ctx.internalDomains),
        recordsAffected: [{ system: 'gcal', id: args.eventId, before: snapshot, after: null }],
        reversibilityNote: 'Attendees saw a cancellation.',
        detail: { eventId: args.eventId, event: snapshot, conflicts: 0 },
      },
    };
  },
});

export const gcal: ConnectorDefinition = {
  kind: 'gcal',
  displayName: 'Google Calendar',
  provider: 'google',
  apiBase: 'https://www.googleapis.com',
  tools: [list, create, update, remove],
  neverDoes: ['Share or change calendar permissions', 'Delete calendars', 'Change calendar settings'],
  async health(ctx) {
    const started = Date.now();
    await ctx.http.json(EVENTS, { query: { maxResults: 1 } });
    return { ok: true, latencyMs: Date.now() - started };
  },
  async accountRef(ctx) {
    const res = await ctx.http.json<{ summary?: string }>(EVENTS, { query: { maxResults: 1 } });
    return (res.summary ?? 'primary').toLowerCase();
  },
};

export default gcal;
