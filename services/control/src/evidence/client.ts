import { problems, type Problem } from '@vega/shared';

/**
 * The CONTROL plane's door into the evidence plane (docs/module7.md §7). Two credentials:
 *
 *   query   /query/<tenant>/… and /public/… — reads, packs, replay, traces, redactions, made on
 *           behalf of a person this plane has ALREADY authorized (role, relationship, plan)
 *   append  POST /append — the control plane's own events (`policy.activated`)
 *
 * The control plane holds no evidence database credential; everything goes through the evidence
 * service, which scopes every query to the tenant in its path.
 */

export class EvidenceUnavailable extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

export interface EvidenceContent {
  /** base64 of the exact bytes. */
  data: string;
  mediaType: string;
  sensitivity?: 'body' | 'metadata';
}

export class EvidenceClient {
  constructor(
    private readonly opts: {
      /** The query door (deployed: evidence:3008). */
      baseUrl: string;
      /** The append door (deployed: evidence:3004). Defaults to `baseUrl` (one listener in tests). */
      appendUrl?: string | undefined;
      queryToken: string;
      appendToken?: string | undefined;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private url(path: string, query?: Record<string, string | number | boolean | string[] | undefined>): string {
    const base = path === '/append' ? (this.opts.appendUrl ?? this.opts.baseUrl) : this.opts.baseUrl;
    const u = new URL(`${base.replace(/\/$/, '')}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === '') continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return u.toString();
  }

  private async send(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string | number | boolean | string[] | undefined>; body?: unknown; token?: string } = {}): Promise<Response> {
    const f = this.opts.fetchImpl ?? globalThis.fetch;
    try {
      return await f(this.url(path, opts.query), {
        method,
        headers: { authorization: `Bearer ${opts.token ?? this.opts.queryToken}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (e) {
      throw new EvidenceUnavailable(unavailable(`the evidence plane is unreachable: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  /** JSON, or the evidence plane's problem mapped onto ours (status preserved). */
  async json<T>(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string | number | boolean | string[] | undefined>; body?: unknown } = {}): Promise<T> {
    const res = await this.send(method, path, opts);
    if (res.ok) return (await res.json()) as T;
    const p = (await res.json().catch(() => ({}))) as { title?: string; detail?: string; errors?: Problem['errors'] };
    throw new EvidenceUnavailable(toProblem(res.status, p));
  }

  async bytes(path: string): Promise<{ bytes: Buffer; contentType: string; filename: string | null }> {
    const res = await this.send('GET', path);
    if (!res.ok) {
      const p = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
      throw new EvidenceUnavailable(toProblem(res.status, p));
    }
    const cd = res.headers.get('content-disposition') ?? '';
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream', filename: /filename="([^"]+)"/.exec(cd)?.[1] ?? null };
  }

  /** The control plane's own entries. Throws if no append credential is configured. */
  async append(input: { tenantId: string; kind: string; payload: Record<string, unknown>; content?: EvidenceContent[] }): Promise<{ id: string; seq: number; entryHash: string }> {
    if (!this.opts.appendToken) throw new EvidenceUnavailable(unavailable('the control plane has no evidence append credential'));
    const res = await this.send('POST', '/append', { token: this.opts.appendToken, body: { ...input, source: 'control' } });
    if (res.status !== 201) throw new EvidenceUnavailable(unavailable(`evidence append failed: HTTP ${res.status}`));
    return (await res.json()) as { id: string; seq: number; entryHash: string };
  }
}

function toProblem(status: number, p: { title?: string; detail?: string; errors?: Problem['errors'] }): Problem {
  const detail = p.detail ?? p.title;
  switch (status) {
    case 400:
      return problems.validation(p.errors ?? [], detail);
    case 403:
      return problems.forbidden(detail);
    case 404:
      return problems.notFound(detail);
    case 409:
      return problems.conflict(detail);
    case 410:
      return { type: 'https://errors.vega.dev/not-found', title: 'Gone', status: 410, ...(detail ? { detail } : {}) };
    default:
      return unavailable(detail ?? `the evidence plane answered HTTP ${status}`);
  }
}

const unavailable = (detail: string): Problem => ({ type: 'https://errors.vega.dev/upstream-unavailable', title: 'The evidence plane is unavailable', status: 503, detail });
