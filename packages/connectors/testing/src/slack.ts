import { type FakeCore, formOf, json } from './core.js';

/** Slack Web API fake: oauth.v2.access, auth.revoke/test, conversations.list, chat.postMessage. */
export class FakeSlack {
  readonly channels = [
    { id: 'C001', name: 'general', is_private: false, topic: { value: 'Company-wide' } },
    { id: 'C002', name: 'deals', is_private: false, topic: { value: 'Pipeline' } },
  ];
  readonly posts: Array<{ channel: string; text: string; ts: string; deleted?: boolean }> = [];

  constructor(readonly core: FakeCore) {}

  async handle(req: Request, url: URL): Promise<Response | undefined> {
    if (url.hostname !== 'slack.com') return undefined;
    const method = url.pathname.replace('/api/', '');
    if (method === 'oauth.v2.access') return this.core.token('slack', await formOf(req));
    if (method === 'auth.revoke') {
      const res = this.core.revoke((await formOf(req)).get('token') ?? '');
      return json(200, { ok: res.ok, revoked: res.ok });
    }
    const auth = (scopes: string[]) => this.core.authenticate(req, 'slack', scopes);
    if (method === 'auth.test') {
      const g = auth([]);
      if (g instanceof Response) return g;
      return json(200, { ok: true, team_id: 'T001', user_id: g.account });
    }
    if (method === 'conversations.list') {
      const g = auth(['channels:read']);
      if (g instanceof Response) return g;
      return json(200, { ok: true, channels: this.channels });
    }
    if (method === 'chat.postMessage') {
      const g = auth(['chat:write']);
      if (g instanceof Response) return g;
      const body = (await req.json()) as { channel: string; text: string };
      const channel = this.channels.find((c) => c.id === body.channel || c.name === body.channel.replace(/^#/, ''));
      if (!channel) return json(200, { ok: false, error: 'channel_not_found' });
      const ts = `${Math.floor(Date.now() / 1000)}.${String(this.posts.length).padStart(6, '0')}`;
      this.posts.push({ channel: channel.id, text: body.text, ts });
      return json(200, { ok: true, channel: channel.id, ts });
    }
    if (method === 'chat.delete') {
      const g = auth(['chat:write']);
      if (g instanceof Response) return g;
      const body = (await req.json()) as { channel: string; ts: string };
      const p = this.posts.find((x) => x.channel === body.channel && x.ts === body.ts);
      if (!p || p.deleted) return json(200, { ok: false, error: 'message_not_found' });
      p.deleted = true;
      return json(200, { ok: true });
    }
    return json(200, { ok: false, error: 'unknown_method' });
  }
}
