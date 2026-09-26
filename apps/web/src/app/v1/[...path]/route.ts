/**
 * Same-origin proxy: /v1/* → the gateway. A route handler rather than a next.config rewrite
 * because rewrites are frozen into the build manifest, and the gateway address differs per
 * environment; this reads GATEWAY_URL at runtime, so one web image runs everywhere.
 *
 * It forwards method, body, cookies and the client address, returns the gateway's status,
 * headers (including every Set-Cookie) and body verbatim, and never follows redirects — the
 * OIDC flow's 302s must reach the browser unchanged.
 */

export const dynamic = 'force-dynamic';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function gateway(): string {
  return (process.env['GATEWAY_URL'] ?? 'http://localhost:3001').replace(/\/$/, '');
}

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const incoming = new URL(req.url);
  const target = `${gateway()}/v1/${path.map(encodeURIComponent).join('/')}${incoming.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    redirect: 'manual',
    ...(hasBody ? { body: await req.arrayBuffer() } : {}),
  });

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie') out.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);

  return new Response(upstream.status === 204 || upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
