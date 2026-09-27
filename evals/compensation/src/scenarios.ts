import type { ConnectorRecord } from '@vega/connector-sdk';
import type { Sandbox } from '@vega/eval-simulation';

/**
 * One or more scenarios per compensator (docs/module6.md §11.1): what the sandbox holds first,
 * the forward call's arguments, and the PROVIDER STATE the action touches — read straight from
 * the sandbox provider, never from our own records, so "restored" means the provider agrees.
 *
 * `comparable` strips what the compensator declares approximate (a recreated event's new id,
 * replies that a new invitation resets). Everything else must match the snapshot exactly.
 */
export interface CompensationScenario {
  name: string;
  toolId: string;
  kind: ConnectorRecord['kind'];
  setup(s: Sandbox): Promise<Record<string, unknown>> | Record<string, unknown>;
  state(s: Sandbox, args: Record<string, unknown>): unknown;
  comparable?(state: unknown): unknown;
  /** Compensate as if the executor never learned the forward call's outcome (§8.4 UNKNOWN). */
  forwardUnknown?: boolean;
}

const acct = (s: Sandbox) => s.account;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;
const live = (s: Sandbox) => s.providers.google.events(acct(s)).filter((e) => e.status !== 'cancelled');
const drafts = (s: Sandbox) => s.providers.google.drafts(acct(s)).map((d) => ({ subject: d.message.headers['Subject'], to: d.message.headers['To'] }));
const msDrafts = (s: Sandbox) => [...(s.providers.microsoft.messages.get(acct(s))?.values() ?? [])].filter((m) => m.isDraft).map((m) => ({ subject: m.subject }));
const noIds = (events: unknown) =>
  (events as Array<Record<string, unknown>>).map((e) => {
    const { id: _id, organizer: _organizer, ...rest } = e;
    return { ...rest, attendees: ((rest['attendees'] as Array<{ email: string }> | undefined) ?? []).map((a) => ({ email: a.email })) };
  });

export const SCENARIOS: CompensationScenario[] = [
  // ------------------------------------------------------------------ gmail
  {
    name: 'delete the draft it created',
    toolId: 'gmail.draft',
    kind: 'gmail',
    setup: () => ({ to: ['client@partner.example'], subject: 'Proposal', body: 'Draft text' }),
    state: (s) => drafts(s),
  },
  {
    name: 'find and delete a draft whose creation was never recorded',
    toolId: 'gmail.draft',
    kind: 'gmail',
    forwardUnknown: true,
    setup: () => ({ to: ['client@partner.example'], subject: 'Lost outcome', body: 'x' }),
    state: (s) => drafts(s),
  },
  {
    name: 'remove only the labels it added',
    toolId: 'gmail.label',
    kind: 'gmail',
    setup: (s) => ({ messageId: s.providers.google.seedMessage(acct(s), { from: 'a@acme.example', subject: 'Hi', body: 'b', labels: ['INBOX', 'STARRED'] }).id, labelIds: ['IMPORTANT', 'STARRED'] }),
    state: (s, a) => clone(s.providers.google.mailboxes.get(acct(s))?.messages.get(String(a['messageId']))?.labelIds),
  },
  // ------------------------------------------------------------------ gcal
  {
    name: 'delete a created event and cancel it for the attendees',
    toolId: 'gcal.create',
    kind: 'gcal',
    setup: () => ({ summary: 'Kickoff', start: '2026-10-05T09:00:00Z', end: '2026-10-05T09:30:00Z', attendees: ['c@partner.example', 'me@acme.example'] }),
    state: (s) => clone(live(s)),
  },
  {
    name: 'find and delete an event whose creation was never recorded (deterministic id)',
    toolId: 'gcal.create',
    kind: 'gcal',
    forwardUnknown: true,
    setup: () => ({ summary: 'Unrecorded', start: '2026-10-05T11:00:00Z', end: '2026-10-05T11:30:00Z', attendees: ['c@partner.example'] }),
    state: (s) => clone(live(s)),
  },
  {
    // Capture discipline (§5.4): recurrence, reminders and conference data survive the restore.
    name: 'restore every field of an updated event, not just the changed ones',
    toolId: 'gcal.update',
    kind: 'gcal',
    setup: (s) => {
      const ev = s.providers.google.seedEvent(acct(s), {
        summary: 'Weekly sync',
        description: 'Agenda in the doc',
        location: 'Room 4',
        start: { dateTime: '2026-10-07T09:00:00Z' },
        end: { dateTime: '2026-10-07T09:30:00Z' },
        attendees: [{ email: 'a@acme.example', responseStatus: 'accepted' }, { email: 'x@partner.example', responseStatus: 'tentative' }],
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
        conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.example/abc' }] },
      });
      return { eventId: ev.id, patch: { summary: 'Weekly sync (moved)', start: '2026-10-07T10:00:00Z', end: '2026-10-07T10:30:00Z', attendees: ['a@acme.example'] } };
    },
    state: (s, a) => clone(s.providers.google.events(acct(s)).find((e) => e.id === a['eventId'])),
  },
  {
    name: 'recreate a cancelled event from its complete snapshot and re-invite',
    toolId: 'gcal.delete',
    kind: 'gcal',
    setup: (s) => ({
      eventId: s.providers.google.seedEvent(acct(s), {
        summary: 'Board review',
        description: 'Q3 numbers',
        start: { dateTime: '2026-10-08T09:00:00Z' },
        end: { dateTime: '2026-10-08T10:00:00Z' },
        attendees: [{ email: 'x@partner.example', responseStatus: 'accepted' }],
        reminders: { useDefault: true },
      }).id,
    }),
    state: (s) => clone(live(s)),
    // APPROXIMATE by declaration: a new id, and replies reset by the new invitation.
    comparable: noIds,
  },
  // ------------------------------------------------------------------ gdrive
  {
    name: 'put the previous revision’s content back',
    toolId: 'gdrive.write',
    kind: 'gdrive',
    setup: (s) => ({ fileId: s.providers.google.seedFile({ name: 'plan.txt', content: 'v1 — the plan' }).id, content: 'v2 — overwritten' }),
    state: (s, a) => s.providers.google.files.get(String(a['fileId']))?.revisions.at(-1)?.content,
  },
  {
    name: 'revoke access it granted',
    toolId: 'gdrive.share',
    kind: 'gdrive',
    setup: (s) => ({ fileId: s.providers.google.seedFile({ name: 'deck.pdf', content: 'x' }).id, email: 'buyer@partner.example', role: 'reader' }),
    state: (s, a) => s.providers.google.files.get(String(a['fileId']))?.permissions.map((p) => ({ email: p.emailAddress, role: p.role })),
  },
  {
    name: 'restore the role of someone who already had access (never revoke it)',
    toolId: 'gdrive.share',
    kind: 'gdrive',
    setup: (s) => ({ fileId: s.providers.google.seedFile({ name: 'deck.pdf', content: 'x', sharedWith: ['buyer@partner.example'] }).id, email: 'buyer@partner.example', role: 'writer' }),
    state: (s, a) => s.providers.google.files.get(String(a['fileId']))?.permissions.map((p) => ({ email: p.emailAddress, role: p.role })),
  },
  // ------------------------------------------------------------------ outlook
  {
    name: 'delete the draft it created',
    toolId: 'outlook.draft',
    kind: 'outlook',
    setup: () => ({ to: ['c@partner.example'], subject: 'Draft', body: 'B' }),
    state: (s) => msDrafts(s),
  },
  {
    name: 'cancel the meeting it created',
    toolId: 'outlook.event_create',
    kind: 'outlook',
    setup: () => ({ subject: 'Review', start: '2026-10-09T09:00:00Z', end: '2026-10-09T10:00:00Z', attendees: ['c@partner.example'] }),
    state: (s) => [...s.providers.microsoft.events.values()].filter((e) => !e.isCancelled).map((e) => ({ subject: e.subject, attendees: e.attendees })),
  },
  // ------------------------------------------------------------------ sharepoint
  {
    name: 'restore the previous version with Graph’s restoreVersion',
    toolId: 'sharepoint.write',
    kind: 'sharepoint',
    setup: (s) => ({ driveId: 'd1', itemId: s.providers.microsoft.seedItem('d1', 'terms.txt', 'old terms'), content: 'new terms' }),
    state: (s, a) => s.providers.microsoft.item('d1', String(a['itemId']))?.content,
  },
  {
    name: 'remove access it granted',
    toolId: 'sharepoint.share',
    kind: 'sharepoint',
    setup: (s) => ({ driveId: 'd1', itemId: s.providers.microsoft.seedItem('d1', 'terms.txt', 'x'), email: 'x@partner.example', role: 'read' }),
    state: (s, a) => s.providers.microsoft.item('d1', String(a['itemId']))?.permissions.map((p) => ({ email: p.email, role: p.role })),
  },
  {
    name: 'restore the role of someone who already had access',
    toolId: 'sharepoint.share',
    kind: 'sharepoint',
    setup: (s) => ({ driveId: 'd1', itemId: s.providers.microsoft.seedItem('d1', 'terms.txt', 'x', { sharedWith: ['x@partner.example'] }), email: 'x@partner.example', role: 'write' }),
    state: (s, a) => s.providers.microsoft.item('d1', String(a['itemId']))?.permissions.map((p) => ({ email: p.email, role: p.role })),
  },
  // ------------------------------------------------------------------ slack
  {
    name: 'delete a released message',
    toolId: 'slack.post',
    kind: 'slack',
    setup: () => ({ channel: 'C002', text: 'Deal closed' }),
    state: (s) => s.providers.slack.posts.filter((p) => !p.deleted).map((p) => ({ channel: p.channel, text: p.text })),
  },
];
