import { createServer, type Server } from 'node:http';

/**
 * Plain-HTTP health endpoint for mTLS-only services.
 *
 * Kubelet probes cannot present a client certificate, so a service that requires mTLS on its
 * API port serves /healthz and /readyz on a separate port with nothing else behind it. Cilium
 * admits that port only from the node (`fromEntities: host`), never from another plane.
 */
export function startHealthServer(port: number, ready: () => Promise<boolean>): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const send = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (path === '/healthz') return send(200, { status: 'ok' });
    if (path === '/readyz') {
      ready()
        .then((ok) => send(ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready' }))
        .catch(() => send(503, { status: 'not_ready' }));
      return;
    }
    return send(404, { error: 'not found' });
  });
  server.listen(port, '0.0.0.0');
  return server;
}
