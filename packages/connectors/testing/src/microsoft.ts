import { type FakeCore, formOf, json } from './core.js';

/** Microsoft Graph fake: OAuth token, /me, mail, sendMail, events, drive items + invite. */

interface GMsg {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  receivedDateTime: string;
  from: { emailAddress: { address: string } };
  toRecipients: Array<{ emailAddress: { address: string } }>;
  ccRecipients: Array<{ emailAddress: { address: string } }>;
  body: { contentType: 'text' | 'html'; content: string };
  isDraft: boolean;
}

interface GItem {
  id: string;
  name: string;
  content: string;
  cTag: string;
  permissions: Array<{ id: string; email: string; role: string }>;
}

export class FakeMicrosoft {
  readonly messages = new Map<string, Map<string, GMsg>>();
  readonly sent: Array<{ account: string; subject: string; to: string[]; headers: Array<{ name: string; value: string }> }> = [];
  readonly events = new Map<string, { id: string; subject: string; transactionId?: string; attendees: string[] }>();
  readonly items = new Map<string, GItem>();

  constructor(readonly core: FakeCore) {}

  private box(account: string) {
    let b = this.messages.get(account);
    if (!b) this.messages.set(account, (b = new Map()));
    return b;
  }

  seedMessage(account: string, m: { from: string; subject: string; body: string; html?: boolean }) {
    const id = this.core.id('AAMk');
    this.box(account).set(id, {
      id,
      conversationId: this.core.id('c'),
      subject: m.subject,
      bodyPreview: m.body.slice(0, 100),
      receivedDateTime: new Date().toISOString(),
      from: { emailAddress: { address: m.from } },
      toRecipients: [{ emailAddress: { address: account } }],
      ccRecipients: [],
      body: { contentType: m.html ? 'html' : 'text', content: m.body },
      isDraft: false,
    });
    return id;
  }

  seedItem(driveId: string, name: string, content: string) {
    const id = this.core.id('01');
    this.items.set(`${driveId}/${id}`, { id, name, content, cTag: this.core.id('ctag'), permissions: [] });
    return id;
  }

  async handle(req: Request, url: URL): Promise<Response | undefined> {
    if (url.hostname === 'login.microsoftonline.com' && url.pathname.endsWith('/oauth2/v2.0/token')) {
      return this.core.token('microsoft', await formOf(req));
    }
    if (url.hostname !== 'graph.microsoft.com') return undefined;
    const path = url.pathname.replace('/v1.0', '');
    const method = req.method;
    const auth = (scopes: string[]) => this.core.authenticate(req, 'microsoft', scopes);

    if (path === '/me' && method === 'GET') {
      const g = auth([]);
      if (g instanceof Response) return g;
      return json(200, { id: 'me', mail: g.account, userPrincipalName: g.account });
    }
    if (path === '/me/drive' && method === 'GET') {
      const g = auth(['Files.Read.All', 'Files.ReadWrite.All']);
      if (g instanceof Response) return g;
      return json(200, { id: 'drive-me' });
    }
    if (path === '/me/messages' && method === 'GET') {
      const g = auth(['Mail.Read', 'Mail.ReadWrite']);
      if (g instanceof Response) return g;
      const q = (url.searchParams.get('$search') ?? '').replace(/"/g, '').toLowerCase();
      const value = [...this.box(g.account).values()].filter((m) => !m.isDraft && (!q || `${m.subject} ${m.body.content}`.toLowerCase().includes(q)));
      return json(200, { value: value.slice(0, Number(url.searchParams.get('$top') ?? 10)) });
    }
    if (path === '/me/messages' && method === 'POST') {
      const g = auth(['Mail.ReadWrite']);
      if (g instanceof Response) return g;
      const body = (await req.json()) as Partial<GMsg>;
      const id = this.core.id('AAMkD');
      this.box(g.account).set(id, {
        id,
        conversationId: this.core.id('c'),
        subject: body.subject ?? '',
        bodyPreview: body.body?.content.slice(0, 100) ?? '',
        receivedDateTime: new Date().toISOString(),
        from: { emailAddress: { address: g.account } },
        toRecipients: body.toRecipients ?? [],
        ccRecipients: body.ccRecipients ?? [],
        body: body.body ?? { contentType: 'text', content: '' },
        isDraft: true,
      });
      return json(201, this.box(g.account).get(id));
    }
    const msg = path.match(/^\/me\/messages\/([^/]+)$/);
    if (msg) {
      const g = auth(method === 'GET' ? ['Mail.Read', 'Mail.ReadWrite'] : ['Mail.ReadWrite']);
      if (g instanceof Response) return g;
      const m = this.box(g.account).get(decodeURIComponent(msg[1]!));
      if (!m) return json(404, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } });
      if (method === 'GET') return json(200, m);
      if (method === 'DELETE') {
        this.box(g.account).delete(m.id);
        return new Response(null, { status: 204 });
      }
    }
    if (path === '/me/sendMail' && method === 'POST') {
      const g = auth(['Mail.Send']);
      if (g instanceof Response) return g;
      const body = (await req.json()) as {
        message: { subject: string; toRecipients: Array<{ emailAddress: { address: string } }>; internetMessageHeaders?: Array<{ name: string; value: string }> };
      };
      this.sent.push({
        account: g.account,
        subject: body.message.subject,
        to: body.message.toRecipients.map((r) => r.emailAddress.address),
        headers: body.message.internetMessageHeaders ?? [],
      });
      return new Response(null, { status: 202 });
    }
    if (path === '/me/events' && method === 'POST') {
      const g = auth(['Calendars.ReadWrite']);
      if (g instanceof Response) return g;
      const body = (await req.json()) as { subject: string; transactionId?: string; attendees?: Array<{ emailAddress: { address: string } }> };
      // Graph's documented idempotency: a repeated transactionId returns the existing event.
      const existing = body.transactionId ? [...this.events.values()].find((e) => e.transactionId === body.transactionId) : undefined;
      if (existing) return json(201, existing);
      const ev = {
        id: this.core.id('AAMkE'),
        subject: body.subject,
        ...(body.transactionId ? { transactionId: body.transactionId } : {}),
        attendees: (body.attendees ?? []).map((a) => a.emailAddress.address),
      };
      this.events.set(ev.id, ev);
      return json(201, ev);
    }
    const drive = path.match(/^\/drives\/([^/]+)\/items\/([^/]+)(\/content|\/invite)?$/);
    if (drive) {
      const key = `${decodeURIComponent(drive[1]!)}/${decodeURIComponent(drive[2]!)}`;
      const write = method !== 'GET' || drive[3] === '/invite';
      const g = auth(write ? ['Files.ReadWrite.All'] : ['Files.Read.All', 'Files.ReadWrite.All']);
      if (g instanceof Response) return g;
      const item = this.items.get(key);
      if (!item) return json(404, { error: { code: 'itemNotFound', message: 'The resource could not be found.' } });
      if (drive[3] === '/content' && method === 'GET') return new Response(item.content, { status: 200, headers: { 'content-type': 'text/plain' } });
      if (drive[3] === '/content' && method === 'PUT') {
        item.content = await req.text();
        item.cTag = this.core.id('ctag');
        return json(200, { id: item.id, name: item.name, size: Buffer.byteLength(item.content), cTag: item.cTag });
      }
      if (drive[3] === '/invite' && method === 'POST') {
        const body = (await req.json()) as { recipients: Array<{ email: string }>; roles: string[] };
        const value = body.recipients.map((r) => {
          const p = { id: this.core.id('perm'), email: r.email, role: body.roles[0] ?? 'read' };
          item.permissions.push(p);
          return { id: p.id, roles: [p.role] };
        });
        return json(200, { value });
      }
      return json(200, { id: item.id, name: item.name, size: Buffer.byteLength(item.content), cTag: item.cTag, file: { mimeType: 'text/plain' } });
    }
    return json(404, { error: { code: 'BadRequest', message: `no route ${method} ${path}` } });
  }
}
