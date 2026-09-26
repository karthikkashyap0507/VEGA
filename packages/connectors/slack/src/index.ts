import { z } from 'zod';
import { SourcedSchema } from '@vega/contracts';
import { defineTool, sourced, ToolError, type ConnectorDefinition, type ToolContext } from '@vega/connector-sdk';

/**
 * Slack — docs/module2.md §5.2.
 *
 * | Tool           | Egress   | Rev | Max taint | Idempotency | Hold | Notes                                   |
 * | slack.channels | INTERNAL | R0  | ORG       | NATIVE      | –    |                                         |
 * | slack.post     | EXTERNAL | R2  | TRUSTED   | KEYED       | ✅   | delete works but is visible: APPROXIMATE |
 */

const SCOPE = { post: 'chat:write', channels: 'channels:read' } as const;

/** Slack answers 200 with `{ ok: false, error }`. Normalize that into ToolError like any HTTP failure. */
async function slack<T>(ctx: ToolContext, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await ctx.http.json<{ ok: boolean; error?: string } & T>(`/${method}`, body ? { method: 'POST', json: body } : {});
  if (!res.ok) {
    const e = res.error ?? 'unknown_error';
    const code =
      e === 'invalid_auth' || e === 'token_expired' || e === 'not_authed'
        ? 'AUTH_EXPIRED'
        : e === 'channel_not_found' || e === 'message_not_found'
          ? 'NOT_FOUND'
          : e === 'not_in_channel' || e === 'restricted_action' || e === 'missing_scope'
            ? 'PERMISSION_DENIED'
            : e === 'ratelimited'
              ? 'RATE_LIMITED'
              : 'PROVIDER_ERROR';
    throw new ToolError(code, `slack: ${e}`, { committed: code === 'PROVIDER_ERROR' ? 'maybe' : 'no' });
  }
  return res;
}

const Channel = z.object({ id: z.string(), name: z.string(), isPrivate: z.boolean(), topic: z.string() });

export const channels = defineTool({
  toolId: 'slack.channels',
  connectorKind: 'slack',
  version: 1,
  title: 'List channels',
  description: 'List public channels in the workspace.',
  scopes: [SCOPE.channels],
  egressClass: 'INTERNAL',
  reversibility: 'R0',
  maxTaint: 'ORG',
  idempotency: 'NATIVE',
  sensitivityHint: 10,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: [],
  argsSchema: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
  effectSchema: z.object({ channels: z.array(SourcedSchema(Channel)) }),
  async simulate(args) {
    return { summary: `Lists up to ${args.limit} channels. Changes nothing.`, fidelity: 'DERIVED', externalRecipients: [], recordsAffected: [], detail: { channels: [] } };
  },
  async execute(args, ctx) {
    const res = await slack<{ channels?: Array<{ id: string; name: string; is_private?: boolean; topic?: { value?: string } }> }>(
      ctx,
      `conversations.list?limit=${args.limit}&exclude_archived=true`,
    );
    const list = (res.channels ?? []).map((c) =>
      sourced({ id: c.id, name: c.name, isPrivate: Boolean(c.is_private), topic: c.topic?.value ?? '' }, { system: 'slack:channel', id: c.id, taint: 'ORG' }),
    );
    return { effect: { summary: `Listed ${list.length} channel(s).`, fidelity: 'PROVIDER', externalRecipients: [], recordsAffected: [], detail: { channels: list } } };
  },
});

export const post = defineTool({
  toolId: 'slack.post',
  connectorKind: 'slack',
  version: 1,
  title: 'Post a message',
  description: 'Post to a channel. Held before release; deleting later is visible to readers (APPROXIMATE undo).',
  scopes: [SCOPE.post],
  egressClass: 'EXTERNAL',
  reversibility: 'R2',
  compensatorRef: 'slack.message.delete',
  maxTaint: 'TRUSTED',
  idempotency: 'KEYED',
  sensitivityHint: 50,
  holdSupported: true,
  simulateFidelity: 'DERIVED',
  outputTaint: 'ORG',
  recipientArgs: ['channel'],
  argsSchema: z.object({ channel: z.string().min(1).max(80), text: z.string().min(1).max(40_000), threadTs: z.string().optional() }),
  effectSchema: z.object({ channel: z.string(), ts: z.string().nullable() }),
  async simulate(args) {
    return {
      summary: `Posts ${args.text.length} characters to ${args.channel}${args.threadTs ? ' (in a thread)' : ''}.`,
      fidelity: 'DERIVED',
      // Channel members may include guests from other organizations; M5 weighs the channel.
      externalRecipients: [],
      recordsAffected: [{ system: 'slack', id: `${args.channel}:(new message)`, field: 'message', after: { text: args.text.slice(0, 200) } }],
      reversibilityNote: 'Held before release. Deleting after release leaves a visible trace for anyone who saw it.',
      detail: { channel: args.channel, ts: null },
    };
  },
  async execute(args, ctx) {
    const res = await slack<{ ts: string; channel: string }>(ctx, 'chat.postMessage', {
      channel: args.channel,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
      // Plain text only: no link unfurls that fetch attacker-chosen URLs on our behalf.
      unfurl_links: false,
      unfurl_media: false,
    });
    return {
      providerRef: `${res.channel}:${res.ts}`,
      effect: {
        summary: `Posted to ${args.channel}.`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [{ system: 'slack', id: `${res.channel}:${res.ts}`, field: 'message', after: { text: args.text.slice(0, 200) } }],
        reversibilityNote: 'Readers may have seen it; deletion is visible.',
        detail: { channel: res.channel, ts: res.ts },
      },
    };
  },
});

export const slackConnector: ConnectorDefinition = {
  kind: 'slack',
  displayName: 'Slack',
  provider: 'slack',
  apiBase: 'https://slack.com/api',
  tools: [channels, post],
  neverDoes: ['Read private channels or direct messages', 'Invite or remove members', 'Change workspace settings'],
  async health(ctx) {
    const started = Date.now();
    await slack(ctx, 'auth.test', {});
    return { ok: true, latencyMs: Date.now() - started };
  },
  async accountRef(ctx) {
    const res = await slack<{ team_id: string; user_id: string }>(ctx, 'auth.test', {});
    return `${res.team_id}:${res.user_id}`;
  },
};

export default slackConnector;
