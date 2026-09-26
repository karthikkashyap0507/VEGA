import { type FakeCore, formOf, json, type Grant } from './core.js';

/**
 * Google fake: OAuth (token + revoke), Gmail, Calendar and Drive — the endpoints and scope
 * rules the connectors in packages/connectors/{gmail,gcal,gdrive} use, as documented by Google.
 */

const G = {
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  gmailCompose: 'https://www.googleapis.com/auth/gmail.compose',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  gmailModify: 'https://www.googleapis.com/auth/gmail.modify',
  calRead: 'https://www.googleapis.com/auth/calendar.events.readonly',
  calWrite: 'https://www.googleapis.com/auth/calendar.events',
  freebusy: 'https://www.googleapis.com/auth/calendar.freebusy',
  driveRead: 'https://www.googleapis.com/auth/drive.readonly',
  drive: 'https://www.googleapis.com/auth/drive',
};

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: Record<string, string>;
  body: string;
  internalDate: number;
}

export interface FakeEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime: string };
  end: { dateTime: string };
  attendees?: Array<{ email: string }>;
  organizer?: { email: string };
  status: string;
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  revisions: Array<{ id: string; content: string }>;
  permissions: Array<{ id: string; type: string; role: string; emailAddress?: string }>;
  modifiedTime: string;
}

interface Mailbox {
  messages: Map<string, FakeMessage>;
  drafts: Map<string, { id: string; messageId: string }>;
}

function parseRaw(raw: string): { headers: Record<string, string>; body: string } {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const [head, ...rest] = text.split('\r\n\r\n');
  const headers: Record<string, string> = {};
  for (const line of (head ?? '').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  let body = rest.join('\r\n\r\n');
  if (/base64/i.test(headers['Content-Transfer-Encoding'] ?? '')) body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  const subject = headers['Subject'] ?? '';
  const m = subject.match(/^=\?UTF-8\?B\?(.+)\?=$/);
  if (m?.[1]) headers['Subject'] = Buffer.from(m[1], 'base64').toString('utf8');
  return { headers, body };
}

export class FakeGoogle {
  readonly mailboxes = new Map<string, Mailbox>();
  readonly calendars = new Map<string, Map<string, FakeEvent>>();
  readonly files = new Map<string, FakeFile>();
  /** Every message actually sent, in order — what "exactly one effect" is asserted against. */
  readonly sent: FakeMessage[] = [];

  constructor(readonly core: FakeCore) {}

  private mailbox(account: string): Mailbox {
    let m = this.mailboxes.get(account);
    if (!m) this.mailboxes.set(account, (m = { messages: new Map(), drafts: new Map() }));
    return m;
  }

  private calendar(account: string): Map<string, FakeEvent> {
    let c = this.calendars.get(account);
    if (!c) this.calendars.set(account, (c = new Map()));
    return c;
  }

  seedMessage(account: string, m: { from: string; to?: string; subject: string; body: string; labels?: string[] }): FakeMessage {
    const id = this.core.id('m');
    const msg: FakeMessage = {
      id,
      threadId: this.core.id('t'),
      labelIds: m.labels ?? ['INBOX'],
      headers: { From: m.from, To: m.to ?? account, Subject: m.subject, Date: new Date().toUTCString(), 'Message-ID': `<${id}@fake>` },
      body: m.body,
      internalDate: Date.now(),
    };
    this.mailbox(account).messages.set(id, msg);
    return msg;
  }

  seedEvent(account: string, e: Omit<FakeEvent, 'id' | 'status'> & { id?: string }): FakeEvent {
    const ev: FakeEvent = { ...e, id: e.id ?? this.core.id('e'), status: 'confirmed' };
    this.calendar(account).set(ev.id, ev);
    return ev;
  }

  seedFile(f: { name: string; content: string; mimeType?: string; sharedWith?: string[] }): FakeFile {
    const file: FakeFile = {
      id: this.core.id('f'),
      name: f.name,
      mimeType: f.mimeType ?? 'text/plain',
      revisions: [{ id: this.core.id('r'), content: f.content }],
      permissions: (f.sharedWith ?? []).map((email) => ({ id: this.core.id('p'), type: 'user', role: 'reader', emailAddress: email })),
      modifiedTime: new Date().toISOString(),
    };
    this.files.set(file.id, file);
    return file;
  }

  events(account: string): FakeEvent[] {
    return [...this.calendar(account).values()];
  }

  async handle(req: Request, url: URL): Promise<Response | undefined> {
    const host = url.hostname;
    const method = req.method;
    if (host === 'oauth2.googleapis.com' && url.pathname === '/token') return this.core.token('google', await formOf(req));
    if (host === 'oauth2.googleapis.com' && url.pathname === '/revoke') return this.core.revoke((await formOf(req)).get('token') ?? '');
    if (host === 'gmail.googleapis.com') return this.gmail(req, url, method);
    if (host === 'www.googleapis.com' && url.pathname.startsWith('/calendar/')) return this.calendarApi(req, url, method);
    if (host === 'www.googleapis.com' && (url.pathname.startsWith('/drive/') || url.pathname.startsWith('/upload/drive/'))) {
      return this.drive(req, url, method);
    }
    return undefined;
  }

  // ------------------------------------------------------------------ gmail
  private async gmail(req: Request, url: URL, method: string): Promise<Response> {
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    const needs = (scopes: string[]) => this.core.authenticate(req, 'google', scopes);
    const readers = [G.gmailRead, G.gmailModify];

    if (path === '/profile' && method === 'GET') {
      const g = needs([G.gmailRead, G.gmailCompose, G.gmailSend, G.gmailModify]);
      if (g instanceof Response) return g;
      return json(200, { emailAddress: g.account, messagesTotal: this.mailbox(g.account).messages.size });
    }
    if (path === '/messages' && method === 'GET') {
      const g = needs(readers);
      if (g instanceof Response) return g;
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      const matches = [...this.mailbox(g.account).messages.values()]
        .filter((m) => this.matches(m, q))
        .sort((a, b) => b.internalDate - a.internalDate)
        .slice(0, max);
      return json(200, { messages: matches.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: matches.length });
    }
    const msgGet = path.match(/^\/messages\/([^/]+)$/);
    if (msgGet && method === 'GET') {
      const g = needs(readers);
      if (g instanceof Response) return g;
      const m = this.mailbox(g.account).messages.get(decodeURIComponent(msgGet[1]!));
      if (!m) return json(404, { error: { code: 404, message: 'Requested entity was not found.' } });
      return json(200, this.render(m, url.searchParams.get('format') ?? 'full', url.searchParams.getAll('metadataHeaders')));
    }
    const modify = path.match(/^\/messages\/([^/]+)\/modify$/);
    if (modify && method === 'POST') {
      const g = needs([G.gmailModify]);
      if (g instanceof Response) return g;
      const m = this.mailbox(g.account).messages.get(decodeURIComponent(modify[1]!));
      if (!m) return json(404, { error: { code: 404, message: 'not found' } });
      const body = (await req.json()) as { addLabelIds?: string[]; removeLabelIds?: string[] };
      m.labelIds = [...new Set([...m.labelIds, ...(body.addLabelIds ?? [])])].filter((l) => !(body.removeLabelIds ?? []).includes(l));
      return json(200, { id: m.id, threadId: m.threadId, labelIds: m.labelIds });
    }
    if (path === '/messages/send' && method === 'POST') {
      const g = needs([G.gmailSend, G.gmailCompose, G.gmailModify]);
      if (g instanceof Response) return g;
      const body = (await req.json()) as { raw: string; threadId?: string };
      const parsed = parseRaw(body.raw);
      const msg: FakeMessage = {
        id: this.core.id('s'),
        threadId: body.threadId ?? this.core.id('t'),
        labelIds: ['SENT'],
        headers: { ...parsed.headers, From: g.account, Date: new Date().toUTCString() },
        body: parsed.body,
        internalDate: Date.now(),
      };
      this.mailbox(g.account).messages.set(msg.id, msg);
      this.sent.push(msg);
      return json(200, { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds });
    }
    if (path === '/drafts' && method === 'POST') {
      const g = needs([G.gmailCompose, G.gmailModify]);
      if (g instanceof Response) return g;
      const body = (await req.json()) as { message: { raw: string; threadId?: string } };
      const parsed = parseRaw(body.message.raw);
      const msg: FakeMessage = {
        id: this.core.id('d'),
        threadId: body.message.threadId ?? this.core.id('t'),
        labelIds: ['DRAFT'],
        headers: { ...parsed.headers, From: g.account },
        body: parsed.body,
        internalDate: Date.now(),
      };
      const draftId = this.core.id('r');
      this.mailbox(g.account).messages.set(msg.id, msg);
      this.mailbox(g.account).drafts.set(draftId, { id: draftId, messageId: msg.id });
      return json(200, { id: draftId, message: { id: msg.id, threadId: msg.threadId, labelIds: ['DRAFT'] } });
    }
    const draft = path.match(/^\/drafts\/([^/]+)$/);
    if (draft && (method === 'GET' || method === 'DELETE')) {
      const g = needs([G.gmailCompose, G.gmailModify]);
      if (g instanceof Response) return g;
      const box = this.mailbox(g.account);
      const d = box.drafts.get(decodeURIComponent(draft[1]!));
      if (!d) return json(404, { error: { code: 404, message: 'not found' } });
      if (method === 'DELETE') {
        box.drafts.delete(d.id);
        box.messages.delete(d.messageId);
        return new Response(null, { status: 204 });
      }
      return json(200, { id: d.id, message: this.render(box.messages.get(d.messageId)!, 'full', []) });
    }
    return json(404, { error: { code: 404, message: `no route ${method} ${path}` } });
  }

  private matches(m: FakeMessage, q: string): boolean {
    if (!q) return true;
    return q.split(/\s+/).every((term) => {
      const [op, ...rest] = term.split(':');
      const value = rest.join(':');
      if (value && op === 'from') return (m.headers['From'] ?? '').toLowerCase().includes(value);
      if (value && op === 'subject') return (m.headers['Subject'] ?? '').toLowerCase().includes(value);
      if (value && op === 'rfc822msgid') return (m.headers['Message-ID'] ?? '').toLowerCase().includes(value);
      if (value && op === 'label') return m.labelIds.map((l) => l.toLowerCase()).includes(value);
      const hay = `${m.headers['Subject'] ?? ''} ${m.headers['From'] ?? ''} ${m.body}`.toLowerCase();
      return hay.includes(term);
    });
  }

  private render(m: FakeMessage, format: string, metadataHeaders: string[]) {
    const all = Object.entries(m.headers).map(([name, value]) => ({ name, value }));
    const base = { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.body.slice(0, 100), internalDate: String(m.internalDate) };
    if (format === 'minimal') return base;
    if (format === 'metadata') {
      const wanted = new Set(metadataHeaders.flatMap((h) => h.split(',')).map((h) => h.toLowerCase()));
      return { ...base, payload: { mimeType: 'text/plain', headers: all.filter((h) => wanted.size === 0 || wanted.has(h.name.toLowerCase())) } };
    }
    return {
      ...base,
      payload: {
        mimeType: 'multipart/alternative',
        headers: all,
        parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(m.body, 'utf8').toString('base64url'), size: m.body.length } }],
      },
    };
  }

  // ------------------------------------------------------------------ calendar
  private async calendarApi(req: Request, url: URL, method: string): Promise<Response> {
    const path = url.pathname.replace('/calendar/v3', '');
    if (path === '/freeBusy' && method === 'POST') {
      const g = this.core.authenticate(req, 'google', [G.freebusy, G.calRead, G.calWrite]);
      if (g instanceof Response) return g;
      const body = (await req.json()) as { timeMin: string; timeMax: string };
      const busy = this.events(g.account)
        .filter((e) => e.status !== 'cancelled' && Date.parse(e.start.dateTime) < Date.parse(body.timeMax) && Date.parse(e.end.dateTime) > Date.parse(body.timeMin))
        .map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }));
      return json(200, { calendars: { primary: { busy } } });
    }
    const base = '/calendars/primary/events';
    if (path === base && method === 'GET') {
      const g = this.core.authenticate(req, 'google', [G.calRead, G.calWrite]);
      if (g instanceof Response) return g;
      const min = url.searchParams.get('timeMin');
      const max = url.searchParams.get('timeMax');
      const items = this.events(g.account)
        .filter((e) => e.status !== 'cancelled')
        .filter((e) => (!min || Date.parse(e.end.dateTime) > Date.parse(min)) && (!max || Date.parse(e.start.dateTime) < Date.parse(max)))
        .sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))
        .slice(0, Number(url.searchParams.get('maxResults') ?? 250));
      return json(200, { summary: g.account, items });
    }
    if (path === base && method === 'POST') {
      const g = this.core.authenticate(req, 'google', [G.calWrite]);
      if (g instanceof Response) return g;
      const body = (await req.json()) as Omit<FakeEvent, 'status'> & { id?: string };
      const cal = this.calendar(g.account);
      if (body.id && cal.has(body.id)) return json(409, { error: { code: 409, message: 'The requested identifier already exists.' } });
      const ev: FakeEvent = { ...body, id: body.id ?? this.core.id('e'), organizer: { email: g.account }, status: 'confirmed' };
      cal.set(ev.id, ev);
      return json(200, ev);
    }
    const one = path.match(/^\/calendars\/primary\/events\/([^/]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]!);
      const scope = method === 'GET' ? [G.calRead, G.calWrite] : [G.calWrite];
      const g = this.core.authenticate(req, 'google', scope);
      if (g instanceof Response) return g;
      const cal = this.calendar(g.account);
      const ev = cal.get(id);
      if (!ev || ev.status === 'cancelled') return json(404, { error: { code: 404, message: 'Not Found' } });
      if (method === 'GET') return json(200, ev);
      if (method === 'PATCH') {
        const patch = (await req.json()) as Partial<FakeEvent>;
        Object.assign(ev, patch);
        return json(200, ev);
      }
      if (method === 'DELETE') {
        ev.status = 'cancelled';
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { error: { code: 404, message: `no route ${method} ${path}` } });
  }

  // ------------------------------------------------------------------ drive
  private async drive(req: Request, url: URL, method: string): Promise<Response> {
    const upload = url.pathname.startsWith('/upload');
    const path = url.pathname.replace('/upload', '').replace('/drive/v3', '');
    const read = [G.driveRead, G.drive];
    if (path === '/about' && method === 'GET') {
      const g = this.core.authenticate(req, 'google', read);
      if (g instanceof Response) return g;
      return json(200, { user: { emailAddress: g.account } });
    }
    const perms = path.match(/^\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/);
    if (perms) {
      const g = this.core.authenticate(req, 'google', method === 'GET' ? read : [G.drive]);
      if (g instanceof Response) return g;
      const f = this.files.get(decodeURIComponent(perms[1]!));
      if (!f) return json(404, { error: { code: 404, message: 'File not found' } });
      if (method === 'GET') return json(200, { permissions: f.permissions });
      if (method === 'POST') {
        const body = (await req.json()) as { type: string; role: string; emailAddress?: string };
        const existing = f.permissions.find((p) => p.emailAddress?.toLowerCase() === body.emailAddress?.toLowerCase());
        if (existing) {
          existing.role = body.role;
          return json(200, existing);
        }
        const p = { id: this.core.id('p'), ...body };
        f.permissions.push(p);
        return json(200, p);
      }
      if (method === 'DELETE' && perms[2]) {
        f.permissions = f.permissions.filter((p) => p.id !== decodeURIComponent(perms[2]!));
        return new Response(null, { status: 204 });
      }
    }
    const exp = path.match(/^\/files\/([^/]+)\/export$/);
    if (exp && method === 'GET') {
      const g = this.core.authenticate(req, 'google', read);
      if (g instanceof Response) return g;
      const f = this.files.get(decodeURIComponent(exp[1]!));
      if (!f) return json(404, { error: { code: 404, message: 'File not found' } });
      return new Response(f.revisions.at(-1)!.content, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const file = path.match(/^\/files\/([^/]+)$/);
    if (file) {
      const g = this.core.authenticate(req, 'google', method === 'GET' ? read : [G.drive]);
      if (g instanceof Response) return g;
      const f = this.files.get(decodeURIComponent(file[1]!));
      if (!f) return json(404, { error: { code: 404, message: 'File not found' } });
      if (method === 'GET' && url.searchParams.get('alt') === 'media') {
        return new Response(f.revisions.at(-1)!.content, { status: 200, headers: { 'content-type': f.mimeType } });
      }
      if (method === 'GET') return json(200, this.fileMeta(f));
      if (method === 'PATCH' && upload) {
        f.revisions.push({ id: this.core.id('r'), content: await req.text() });
        f.modifiedTime = new Date().toISOString();
        return json(200, this.fileMeta(f));
      }
    }
    return json(404, { error: { code: 404, message: `no route ${method} ${path}` } });
  }

  private fileMeta(f: FakeFile) {
    const head = f.revisions.at(-1)!;
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      size: String(Buffer.byteLength(head.content)),
      headRevisionId: head.id,
    };
  }
}

export type { Grant };
