import type { CompensationToken } from '@vega/connector-sdk';

/**
 * MANUAL REMEDIATION — docs/module6.md §6.4: when a compensation fails, the screen says what
 * failed, what state the world is in now, and exactly what to do by hand. It is read by someone
 * under stress, so every step is one plain instruction, in the provider's own words for things.
 */

type Loose = Record<string, unknown>;
const str = (v: unknown, fallback = '') => (typeof v === 'string' && v ? v : fallback);
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : str((x as Loose)?.['email']))).filter(Boolean) : []);
const when = (v: unknown) => {
  const raw = typeof v === 'string' ? v : str((v as Loose | undefined)?.['dateTime'] ?? (v as Loose | undefined)?.['date']);
  const d = Date.parse(raw);
  return Number.isNaN(d) ? raw : new Date(d).toUTCString().replace(':00 GMT', ' UTC');
};

/** The first step depends on WHY it failed: some failures a person can clear, then retry. */
export function firstStep(errorCode: string | undefined, connectorName: string): string | null {
  switch (errorCode) {
    case 'AUTH_EXPIRED':
      return `Reconnect ${connectorName} (Admin → Connectors), then choose “Retry undo”. Nothing else is needed if the retry succeeds.`;
    case 'PERMISSION_DENIED':
      return `${connectorName} no longer has the permission this undo needs. An admin can re-consent to it (Admin → Connectors), then choose “Retry undo”.`;
    case 'CONNECTOR_UNAVAILABLE':
      return `${connectorName} is disconnected. Reconnect it, then choose “Retry undo” — or follow the steps below by hand.`;
    case 'RATE_LIMITED':
    case 'TRANSIENT':
    case 'PROVIDER_ERROR':
      return `${connectorName} did not respond properly. Wait a few minutes and choose “Retry undo” — or follow the steps below by hand.`;
    default:
      return null;
  }
}

export function remediationSteps(token: CompensationToken, opts: { errorCode?: string | undefined; connectorName?: string | undefined } = {}): string[] {
  const a = (token.args ?? {}) as Loose;
  const pre = (token.pre ?? {}) as Loose;
  const fwd = (token.forward?.detail ?? {}) as Loose;
  const steps: string[] = [];
  const first = firstStep(opts.errorCode, opts.connectorName ?? token.toolId.split('.')[0]!);
  if (first) steps.push(first);

  switch (token.ref) {
    case 'gmail.draft.delete':
      steps.push(`Open Gmail and go to Drafts.`, `Find the draft “${str(a['subject'], 'untitled')}” and delete it.`);
      break;
    case 'outlook.draft.delete':
      steps.push(`Open Outlook and go to Drafts.`, `Find the draft “${str(a['subject'], 'untitled')}” and delete it.`);
      break;
    case 'gmail.label.remove': {
      const added = list(a['labelIds']).filter((l) => !list(pre['labelIds']).includes(l));
      steps.push(`Open the message in Gmail.`, `Remove the label${added.length === 1 ? '' : 's'} ${added.join(', ') || '(none were added)'}.`);
      break;
    }
    case 'gcal.event.delete': {
      steps.push(
        `Open Google Calendar and find “${str(a['summary'], 'the event')}” on ${when(a['start'])}.`,
        `Delete it, and choose to send a cancellation to the guests when asked.`,
      );
      break;
    }
    case 'gcal.event.restore': {
      const s = (pre['snapshot'] ?? {}) as Loose;
      steps.push(
        `Open “${str(s['summary'], 'the event')}” in Google Calendar.`,
        `Set it back to: ${[`starts ${when(s['start'])}`, `ends ${when(s['end'])}`, s['location'] ? `location “${str(s['location'])}”` : null, `guests ${list(s['attendees']).join(', ') || 'none'}`].filter(Boolean).join('; ')}.`,
        `Save, and send the update to the guests when asked.`,
      );
      break;
    }
    case 'gcal.event.recreate': {
      const s = (pre['snapshot'] ?? {}) as Loose;
      steps.push(
        `In Google Calendar, create a new event “${str(s['summary'], 'the event')}” from ${when(s['start'])} to ${when(s['end'])}.`,
        `Invite: ${list(s['attendees']).join(', ') || 'nobody'}.`,
        ...(s['description'] ? [`Copy back its description: “${str(s['description']).slice(0, 200)}”.`] : []),
      );
      break;
    }
    case 'outlook.event.delete':
      steps.push(`Open the meeting “${str(a['subject'], 'the meeting')}” in Outlook.`, `Choose “Cancel meeting” and send the cancellation.`);
      break;
    case 'gdrive.revision.restore':
      steps.push(`Open “${str(pre['name'], 'the file')}” in Google Drive.`, `Open File → Version history, and restore the version from before this change (revision ${str(pre['revisionId'], 'before the change')}).`);
      break;
    case 'sharepoint.version.restore':
      steps.push(`Open “${str(pre['name'], 'the document')}” in SharePoint.`, `Open Version history and restore version ${str(pre['versionId'], 'before the change')}.`);
      break;
    case 'gdrive.permission.revoke':
    case 'sharepoint.permission.revoke': {
      const prior = pre['prior'] as { role?: string } | null | undefined;
      const email = str(a['email'], 'the person');
      steps.push(
        `Open the ${token.ref.startsWith('gdrive') ? 'file in Google Drive and choose Share' : 'document in SharePoint and choose Manage access'}.`,
        prior?.role ? `Change ${email} back to ${prior.role}.` : `Remove ${email}. They may already have opened it while they had access.`,
      );
      break;
    }
    case 'slack.message.delete':
      steps.push(`Open ${str(fwd['channel'] ?? a['channel'], 'the channel')} in Slack.`, `Find the message, open its ⋯ menu and choose “Delete message”.`);
      break;
    default:
      if (token.ref.startsWith('mcp.')) {
        steps.push(`Run the undo tool “${token.ref.split('.').slice(2).join('.')}” on the MCP server by hand, with the same arguments as the original call.`);
      } else {
        const records = token.forward?.recordsAffected ?? [];
        steps.push(`Open the app this action changed and put it back by hand.`, ...(records.length ? [`It changed: ${records.map((r) => `${r.system} ${r.id}${r.field ? ` (${r.field})` : ''}`).join('; ')}.`] : []));
      }
  }
  steps.push('Then mark this incident resolved, so the record shows the world is consistent again.');
  return steps;
}
