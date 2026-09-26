import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The provider fakes over real HTTP — a SANDBOX PROVIDER for things that cannot share memory
 * with the test: a worker process the durability suite kills mid-call, or the local stack the
 * E2E suite drives. Effects land in the one FakeProviders instance behind the server, so "no
 * duplicate side effects in the sandbox account" (docs/module4.md §11.1) is checked in one place
 * however many processes came and went.
 *
 * The runtime keeps calling the real provider URLs; `forwardingFetch` sends each request to the
 * sandbox with the original URL in a header. Development and tests only — the services refuse
 * a sandbox URL in production.
 */

export const TARGET_HEADER = 'x-sandbox-target'; // = SANDBOX_TARGET_HEADER in @vega/connector-sdk

export interface SandboxServer {
  url: string;
  close(): Promise<void>;
}

export interface SandboxOptions {
  port?: number;
  host?: string;
  /** Called for every request before it is handled (e.g. to delay or observe one). */
  before?: (target: URL, method: string) => Promise<void> | void;
  /** Called after the fake produced a response, before it is sent back. */
  after?: (target: URL, method: string, status: number) => Promise<void> | void;
  /** Test-control endpoints under `/__…` (seed a mailbox, play the user at a consent screen). */
  admin?: (path: string, body: unknown) => Promise<unknown> | unknown;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function serveProviders(handler: typeof fetch, options: SandboxOptions = {}): Promise<SandboxServer> {
  const server = createServer(async (req, res) => {
    try {
      const target = req.headers[TARGET_HEADER];
      if (typeof target !== 'string' && options.admin && req.url?.startsWith('/__')) {
        const raw = await body(req);
        const out = await options.admin(req.url.split('?')[0]!, raw.length ? JSON.parse(raw.toString('utf8')) : undefined);
        res.writeHead(out === undefined ? 404 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? { error: 'unknown admin path' }));
        return;
      }
      if (typeof target !== 'string') {
        res.writeHead(400).end('missing target');
        return;
      }
      const url = new URL(target);
      // The body is read first: a caller that dies while `before` delays (the durability suite
      // kills it on purpose) must still have its request applied, as a real provider would.
      const payload = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req);
      await options.before?.(url, req.method ?? 'GET');
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host' || k === TARGET_HEADER || k === 'content-length' || k === 'connection' || v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const out = await handler(new Request(url, { method: req.method ?? 'GET', headers, ...(payload ? { body: payload } : {}) }));
      const buf = Buffer.from(await out.arrayBuffer());
      await options.after?.(url, req.method ?? 'GET', out.status);
      const h: Record<string, string> = {};
      out.headers.forEach((v, k) => {
        if (k !== 'content-length' && k !== 'transfer-encoding') h[k] = v;
      });
      res.writeHead(out.status, h).end(buf);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' }).end(e instanceof Error ? e.message : 'sandbox failure');
    }
  });
  await new Promise<void>((r) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** A `fetch` that sends every request to the sandbox, carrying the URL it was meant for. */
export { sandboxFetch as forwardingFetch } from '@vega/connector-sdk';
