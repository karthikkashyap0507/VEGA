import { fromHttpStatus, ToolError } from './errors.js';

/**
 * Authenticated provider HTTP. The ONLY place a connector token is attached to a request, and
 * never where it is logged: errors carry a status and a short summary, not headers or bodies.
 *
 * Tools call relative paths (`/gmail/v1/users/me/messages`) against `baseUrl`, which a sandbox
 * or test overrides. `getToken` is supplied by the runtime (vault + single-flight refresh);
 * tools cannot reach the token itself.
 */
export interface ProviderHttpOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;
  /** Called once on a 401 to force a refresh; the request is then retried a single time. */
  onUnauthorized?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Extra headers every request carries (e.g. a provider API version). */
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: string | Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
  /** Absolute URL, bypassing baseUrl (e.g. an upload endpoint on another host). */
  absolute?: boolean;
  signal?: AbortSignal;
}

export class ProviderHttp {
  constructor(private readonly options: ProviderHttpOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  private url(path: string, query: RequestOptions['query'], absolute?: boolean): string {
    const u = absolute ? new URL(path) : new URL(path.replace(/^\//, ''), this.options.baseUrl.replace(/\/?$/, '/'));
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const send = async (token: string | undefined) => {
      const headers: Record<string, string> = { accept: 'application/json', ...this.options.defaultHeaders, ...opts.headers };
      if (token) headers['authorization'] = `Bearer ${token}`;
      let body: string | Uint8Array | undefined = opts.body;
      if (opts.json !== undefined) {
        body = JSON.stringify(opts.json);
        headers['content-type'] = 'application/json';
      } else if (opts.contentType) {
        headers['content-type'] = opts.contentType;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await fetchImpl(this.url(path, opts.query, opts.absolute), {
          method: opts.method ?? 'GET',
          headers,
          ...(body !== undefined ? { body: body as never } : {}),
          signal: controller.signal,
        });
      } catch (cause) {
        // Network failure: nothing reached the provider only if the connection never opened,
        // which fetch does not tell us. Conservatively: maybe committed.
        throw new ToolError('TRANSIENT', 'provider unreachable', { committed: 'maybe', cause });
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
    };

    let res = await send(this.options.getToken ? await this.options.getToken() : undefined);
    if (res.status === 401 && this.options.onUnauthorized) {
      const fresh = await this.options.onUnauthorized();
      if (fresh) res = await send(fresh);
    }
    return res;
  }

  /** JSON request; non-2xx becomes a normalized ToolError. 204 returns undefined. */
  async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(path, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw fromHttpStatus(res.status, res.headers, summarize(text));
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async text(path: string, opts: RequestOptions = {}): Promise<string> {
    const res = await this.raw(path, opts);
    if (!res.ok) throw fromHttpStatus(res.status, res.headers, summarize(await res.text().catch(() => '')));
    return res.text();
  }
}

/** First line of a provider error, with anything token-shaped removed. */
function summarize(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string; message?: string };
    const msg =
      (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) ?? parsed.error_description ?? parsed.message ?? '';
    return redact(String(msg));
  } catch {
    return redact(text.split('\n')[0] ?? '');
  }
}

export function redact(s: string): string {
  return s
    .replace(/(bearer\s+)[a-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/(access_token|refresh_token|id_token|client_secret)=[^&\s"]+/gi, '$1=[redacted]')
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/g, '[redacted-jwt]')
    .slice(0, 200);
}
