import type { ConnectorRecord } from '@vega/connector-sdk';
import type { Sandbox } from './sandbox.js';

/**
 * One scenario per launch tool (at least): a realistic call, with whatever the sandbox must
 * contain first. The harness simulates it, executes it, and diffs the two effects.
 */
export interface Scenario {
  name: string;
  toolId: string;
  kind: ConnectorRecord['kind'];
  config?: Record<string, unknown>;
  /** Seeds the sandbox and returns the call's arguments. */
  setup(s: Sandbox): Promise<unknown> | unknown;
}

const acct = (s: Sandbox) => s.account;

export const SCENARIOS: Scenario[] = [
  // ------------------------------------------------------------------ gmail
  { name: 'search mailbox', toolId: 'gmail.search', kind: 'gmail', setup: (s) => (s.providers.google.seedMessage(acct(s), { from: 'a@partner.example', subject: 'Invoice 42', body: 'x' }), { query: 'invoice' }) },
  { name: 'read a message', toolId: 'gmail.read', kind: 'gmail', setup: (s) => ({ messageId: s.providers.google.seedMessage(acct(s), { from: 'a@partner.example', subject: 'Hi', body: 'b' }).id }) },
  { name: 'draft to external + internal', toolId: 'gmail.draft', kind: 'gmail', setup: () => ({ to: ['client@partner.example'], cc: ['lead@acme.example'], subject: 'Proposal', body: 'Draft' }) },
  { name: 'send to external', toolId: 'gmail.send', kind: 'gmail', setup: () => ({ to: ['client@partner.example'], subject: 'Q3 summary', body: 'Attached.' }) },
  { name: 'send internal only', toolId: 'gmail.send', kind: 'gmail', setup: () => ({ to: ['team@acme.example'], bcc: ['boss@acme.example'], subject: 'Note', body: 'x' }) },
  { name: 'label a message', toolId: 'gmail.label', kind: 'gmail', setup: (s) => ({ messageId: s.providers.google.seedMessage(acct(s), { from: 'a@acme.example', subject: 'Hi', body: 'b' }).id, labelIds: ['IMPORTANT'] }) },
  // ------------------------------------------------------------------ gcal
  { name: 'list window', toolId: 'gcal.list', kind: 'gcal', setup: () => ({ timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z' }) },
  { name: 'create with external attendee', toolId: 'gcal.create', kind: 'gcal', setup: () => ({ summary: 'Kickoff', start: '2026-10-05T09:00:00Z', end: '2026-10-05T09:30:00Z', attendees: ['c@partner.example', 'me@acme.example'] }) },
  {
    name: 'create over a conflict',
    toolId: 'gcal.create',
    kind: 'gcal',
    setup: (s) => (
      s.providers.google.seedEvent(acct(s), { summary: 'Board', start: { dateTime: '2026-10-06T10:00:00Z' }, end: { dateTime: '2026-10-06T11:00:00Z' } }),
      { summary: 'Client call', start: '2026-10-06T10:30:00Z', end: '2026-10-06T11:30:00Z', attendees: ['c@partner.example'] }
    ),
  },
  {
    name: 'reschedule and add an attendee',
    toolId: 'gcal.update',
    kind: 'gcal',
    setup: (s) => {
      const ev = s.providers.google.seedEvent(acct(s), { summary: 'Sync', start: { dateTime: '2026-10-07T09:00:00Z' }, end: { dateTime: '2026-10-07T09:30:00Z' }, attendees: [{ email: 'a@acme.example' }] });
      return { eventId: ev.id, patch: { start: '2026-10-07T10:00:00Z', end: '2026-10-07T10:30:00Z', attendees: ['a@acme.example', 'x@partner.example'] } };
    },
  },
  {
    name: 'cancel an event with external attendees',
    toolId: 'gcal.delete',
    kind: 'gcal',
    setup: (s) => ({
      eventId: s.providers.google.seedEvent(acct(s), { summary: 'Standup', start: { dateTime: '2026-10-08T09:00:00Z' }, end: { dateTime: '2026-10-08T09:15:00Z' }, attendees: [{ email: 'x@partner.example' }] }).id,
    }),
  },
  // ------------------------------------------------------------------ gdrive
  { name: 'read a doc', toolId: 'gdrive.read', kind: 'gdrive', setup: (s) => ({ fileId: s.providers.google.seedFile({ name: 'plan.txt', content: 'v1' }).id }) },
  { name: 'overwrite a file', toolId: 'gdrive.write', kind: 'gdrive', setup: (s) => ({ fileId: s.providers.google.seedFile({ name: 'plan.txt', content: 'v1' }).id, content: 'v2' }) },
  { name: 'share externally', toolId: 'gdrive.share', kind: 'gdrive', setup: (s) => ({ fileId: s.providers.google.seedFile({ name: 'deck.pdf', content: 'x' }).id, email: 'buyer@partner.example', role: 'reader' }) },
  { name: 'share with someone who already has access', toolId: 'gdrive.share', kind: 'gdrive', setup: (s) => ({ fileId: s.providers.google.seedFile({ name: 'deck.pdf', content: 'x', sharedWith: ['buyer@partner.example'] }).id, email: 'buyer@partner.example', role: 'reader' }) },
  // ------------------------------------------------------------------ outlook
  { name: 'search mailbox', toolId: 'outlook.search', kind: 'outlook', setup: (s) => (s.providers.microsoft.seedMessage(acct(s), { from: 'x@partner.example', subject: 'Invoice', body: 'x' }), { query: 'Invoice' }) },
  { name: 'read a message', toolId: 'outlook.read', kind: 'outlook', setup: (s) => ({ messageId: s.providers.microsoft.seedMessage(acct(s), { from: 'x@partner.example', subject: 'Hello', body: 'Hi' }) }) },
  { name: 'draft', toolId: 'outlook.draft', kind: 'outlook', setup: () => ({ to: ['c@partner.example'], subject: 'Draft', body: 'B' }) },
  { name: 'send', toolId: 'outlook.send', kind: 'outlook', setup: () => ({ to: ['c@partner.example'], cc: ['me@acme.example'], subject: 'S', body: 'B' }) },
  { name: 'create meeting', toolId: 'outlook.event_create', kind: 'outlook', setup: () => ({ subject: 'Review', start: '2026-10-09T09:00:00Z', end: '2026-10-09T10:00:00Z', attendees: ['c@partner.example'] }) },
  // ------------------------------------------------------------------ sharepoint
  { name: 'read a document', toolId: 'sharepoint.read', kind: 'sharepoint', setup: (s) => ({ driveId: 'd1', itemId: s.providers.microsoft.seedItem('d1', 'terms.txt', 'old') }) },
  { name: 'overwrite a document', toolId: 'sharepoint.write', kind: 'sharepoint', setup: (s) => ({ driveId: 'd1', itemId: s.providers.microsoft.seedItem('d1', 'terms.txt', 'old'), content: 'new' }) },
  { name: 'share externally', toolId: 'sharepoint.share', kind: 'sharepoint', setup: (s) => ({ driveId: 'd1', itemId: s.providers.microsoft.seedItem('d1', 'terms.txt', 'x'), email: 'x@partner.example', role: 'read' }) },
  // ------------------------------------------------------------------ slack
  { name: 'list channels', toolId: 'slack.channels', kind: 'slack', setup: () => ({ limit: 50 }) },
  { name: 'post to a channel', toolId: 'slack.post', kind: 'slack', setup: () => ({ channel: 'C002', text: 'Deal closed' }) },
  // ------------------------------------------------------------------ web / http
  { name: 'fetch a page', toolId: 'web.fetch', kind: 'web', setup: () => ({ url: 'https://example.com/pricing' }) },
  { name: 'search the web', toolId: 'web.search', kind: 'web', setup: () => ({ query: 'agent governance' }) },
  { name: 'call an allowlisted API', toolId: 'http.request', kind: 'http', config: { allowlist: ['https://api.corp.example'] }, setup: () => ({ method: 'POST', url: 'https://api.corp.example/v1/orders', headers: {}, body: '{}' }) },
];
