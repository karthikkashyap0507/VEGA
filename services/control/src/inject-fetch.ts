import type { FastifyInstance } from 'fastify';

/**
 * A `fetch` that dispatches into a Fastify instance in-process.
 *
 * Used where one service calls another and the test (or single-process dev mode) should
 * exercise the real HTTP surface — headers, status codes, serialization, assertion
 * verification — without a socket. It is not a mock: the request runs through every hook
 * the deployed service runs.
 */
export function injectFetch(app: FastifyInstance): typeof fetch {
  const impl = async (input: string | URL | Request, init?: { method?: string; headers?: unknown; body?: unknown }) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => {
      headers[k] = v;
    });
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers,
      ...(init?.body !== undefined && init.body !== null ? { payload: String(init.body) } : {}),
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) out.append(k, String(item));
      else out.set(k, String(v));
    }
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: out });
  };
  return impl as unknown as typeof fetch;
}
