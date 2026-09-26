/**
 * DEVELOPMENT AND TESTS ONLY: route every provider request to a sandbox provider server
 * (`serveProviders` in @vega/connector-testing), carrying the URL it was meant for. The
 * services refuse CONNECTOR_SANDBOX_URL in production.
 */
export const SANDBOX_TARGET_HEADER = 'x-sandbox-target';

export function sandboxFetch(sandboxUrl: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set(SANDBOX_TARGET_HEADER, req.url);
    const payload = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    return fetch(`${sandboxUrl.replace(/\/$/, '')}/forward`, { method: req.method, headers, ...(payload ? { body: payload } : {}), redirect: 'manual' });
  }) as typeof fetch;
}
