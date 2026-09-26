import { z } from 'zod';
import { defineTool, isPublicAddressLike, ToolError, type ConnectorDefinition, type ToolContext } from './deps.js';

/**
 * Generic HTTP — docs/module2.md §5.2, §10.4.
 *
 * | Tool         | Egress | Rev | Max taint | Idempotency | Hold |
 * | http.request | PUBLIC | R3  | TRUSTED   | NONE        | ✅   |
 *
 * Declared R3 / PUBLIC on purpose: policy treats it as maximally risky until an admin narrows
 * it. It exists for internal enterprise APIs, not as a universal escape hatch — every call must
 * target an origin on this connector's allowlist, matched EXACTLY (no wildcards, no prefixes).
 */

export function allowlist(ctx: ToolContext): string[] {
  const raw = ctx.config['allowlist'];
  return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : [];
}

function checkDestination(ctx: ToolContext, rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError('VALIDATION', 'not a URL', { committed: 'no' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ToolError('EGRESS_DENIED', 'scheme not allowed', { committed: 'no' });
  if (url.username || url.password) throw new ToolError('EGRESS_DENIED', 'credentials in URL are not allowed', { committed: 'no' });
  if (!allowlist(ctx).includes(url.origin)) {
    throw new ToolError('EGRESS_DENIED', `${url.origin} is not on this connector's allowlist`, { committed: 'no' });
  }
  // Even an allowlisted name must not be cloud metadata or loopback.
  if (!isPublicAddressLike(url.hostname)) throw new ToolError('EGRESS_DENIED', `${url.hostname} is a reserved address`, { committed: 'no' });
  return url;
}

const Method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'connection', 'transfer-encoding', 'proxy-authorization']);

export const request = defineTool({
  toolId: 'http.request',
  connectorKind: 'http',
  version: 1,
  title: 'HTTP request',
  description: 'Call an allowlisted internal API. Treated as irreversible and held for approval by default.',
  scopes: [],
  egressClass: 'PUBLIC',
  reversibility: 'R3',
  maxTaint: 'TRUSTED',
  idempotency: 'NONE',
  sensitivityHint: 60,
  holdSupported: true,
  simulateFidelity: 'DECLARED',
  outputTaint: 'UNTRUSTED',
  recipientArgs: ['url'],
  argsSchema: z.object({
    method: Method,
    url: z.string().url().max(2048),
    headers: z.record(z.string(), z.string().max(4096)).default({}),
    body: z.string().max(1_000_000).optional(),
  }),
  effectSchema: z.object({ status: z.number().int().nullable(), responseBytes: z.number().int(), origin: z.string() }),
  async simulate(args, ctx) {
    const url = checkDestination(ctx, args.url);
    return {
      summary: `${args.method} ${url.origin}${url.pathname}. The effect of this call cannot be predicted or undone.`,
      fidelity: 'DECLARED',
      externalRecipients: [url.origin],
      recordsAffected: [{ system: 'http', id: `${url.origin}${url.pathname}` }],
      reversibilityNote: 'Irreversible by declaration: nothing is known about what the remote system does.',
      detail: { status: null, responseBytes: 0, origin: url.origin },
    };
  },
  async execute(args, ctx) {
    const url = checkDestination(ctx, args.url);
    const headers = Object.fromEntries(Object.entries(args.headers).filter(([k]) => !FORBIDDEN_HEADERS.has(k.toLowerCase())));
    const res = await ctx.http.raw(url.toString(), {
      absolute: true,
      method: args.method,
      headers,
      ...(args.body !== undefined ? { body: args.body } : {}),
    });
    const text = await res.text();
    return {
      effect: {
        summary: `${args.method} ${url.origin}${url.pathname} → ${res.status}.`,
        fidelity: 'PROVIDER',
        externalRecipients: [url.origin],
        recordsAffected: [{ system: 'http', id: `${url.origin}${url.pathname}`, after: { status: res.status } }],
        reversibilityNote: 'Irreversible by declaration.',
        detail: { status: res.status, responseBytes: Buffer.byteLength(text), origin: url.origin },
      },
    };
  },
});

export const http: ConnectorDefinition = {
  kind: 'http',
  displayName: 'HTTP (allowlisted APIs)',
  provider: 'none',
  apiBase: 'https://invalid.example',
  tools: [request],
  neverDoes: ['Call any destination not on the allowlist', 'Reach cloud metadata or loopback addresses', 'Send your sign-in credentials'],
  async health(ctx) {
    return { ok: allowlist(ctx).length > 0, latencyMs: 0, detail: `${allowlist(ctx).length} allowlisted origin(s)` };
  },
};

export default http;
