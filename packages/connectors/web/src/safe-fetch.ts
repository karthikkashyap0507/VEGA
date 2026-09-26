import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { htmlToText, ToolError } from '@vega/connector-sdk';

/**
 * SSRF-hardened fetch — docs/module2.md §10.3. The web fetcher ingests arbitrary
 * attacker-controlled content, so it is the connector most likely to be turned against the
 * infrastructure it runs on.
 *
 * Defences, each independent:
 *   1. scheme allowlist (http/https), no credentials in the URL, port allowlist
 *   2. hostname denylist (cloud metadata names, localhost, *.internal, *.local)
 *   3. the RESOLVED address is checked at CONNECT time, inside the socket's own DNS lookup —
 *      so DNS rebinding (public on check, private on connect) cannot slip through
 *   4. redirects are followed manually and every hop re-runs 1–3
 *   5. response size and time caps; content-type allowlist
 *   6. active content stripped before anything returns (scripts, iframes, images: remote
 *      image loading is an exfiltration channel)
 * In a cluster it also runs in its own pod with no credentials and an egress policy that
 * excludes private ranges (infra/helm) — the network layer does not trust this code either.
 */

const DENIED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  DENIED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
] as const) {
  DENIED.addSubnet(net, prefix, 'ipv6');
}

const DENIED_HOSTS = [/^localhost$/i, /^metadata(\.google\.internal)?$/i, /\.internal$/i, /\.local$/i, /^metadata\.azure\.com$/i];

/** Expands an IPv6 address to eight 16-bit groups (dotted IPv4 tails included). */
function ipv6Groups(ip: string): number[] {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const tail = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = text.slice(0, tail.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g || '0', 16));
}

/**
 * True if `ip` is a publicly routable unicast address. IPv6 forms that embed an IPv4 address —
 * IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96) — are unwrapped and
 * judged as the IPv4 address they reach, in dotted or hex notation alike.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip.replace(/%.*$/, ''));
  if (family === 4) return !DENIED.check(ip, 'ipv4');
  if (family === 6) {
    const g = ipv6Groups(ip);
    const embedsV4 =
      (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) ||
      (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
    if (embedsV4 && !(g[5] === 0 && g[6] === 0 && (g[7] ?? 0) <= 1)) {
      const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
      return !DENIED.check(v4, 'ipv4');
    }
    return !DENIED.check(ip, 'ipv6');
  }
  return false;
}

export const ALLOWED_TYPES = ['text/html', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'text/xml', 'application/xhtml+xml'];

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowedPorts?: number[];
  /** Tests only: widen which resolved addresses are acceptable (e.g. a loopback fixture). */
  addressPolicy?: (ip: string) => boolean;
  /** Tests only: substitute DNS. */
  lookup?: typeof dnsLookup;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  truncated: boolean;
}

function checkUrl(raw: string, allowedPorts: number[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError('VALIDATION', 'not a URL', { committed: 'no' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('EGRESS_DENIED', `scheme ${url.protocol} is not allowed`, { committed: 'no' });
  }
  if (url.username || url.password) throw new ToolError('EGRESS_DENIED', 'credentials in URL are not allowed', { committed: 'no' });
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!allowedPorts.includes(port)) throw new ToolError('EGRESS_DENIED', `port ${port} is not allowed`, { committed: 'no' });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (DENIED_HOSTS.some((re) => re.test(host))) throw new ToolError('EGRESS_DENIED', `host ${host} is not allowed`, { committed: 'no' });
  if (isIP(host) && !isPublicAddress(host)) throw new ToolError('EGRESS_DENIED', `address ${host} is not public`, { committed: 'no' });
  return url;
}

/** A dispatcher whose sockets refuse to connect to anything the policy rejects. */
function guardedAgent(policy: (ip: string) => boolean, lookup: typeof dnsLookup): Agent {
  return new Agent({
    connect: {
      lookup: ((hostname: string, options: object, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
        lookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err, '', 0);
          const list = (Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }]) as LookupAddress[];
          const bad = list.find((a) => !policy(a.address));
          if (bad || list.length === 0) {
            return callback(Object.assign(new Error(`resolved to a non-public address`), { code: 'EGRESS_DENIED' }), '', 0);
          }
          const all = (options as { all?: boolean }).all;
          if (all) return callback(null, list);
          return callback(null, list[0]!.address, list[0]!.family);
        });
      }) as never,
    },
  });
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const maxBytes = options.maxBytes ?? 2_000_000;
  const allowedPorts = options.allowedPorts ?? [80, 443];
  const policy = options.addressPolicy ?? isPublicAddress;
  const dispatcher = guardedAgent(policy, options.lookup ?? dnsLookup);
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 15_000);

  let url = checkUrl(rawUrl, allowedPorts);
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
    let res;
    try {
      res = await undiciFetch(url, {
        redirect: 'manual',
        dispatcher,
        signal: deadline,
        headers: { 'user-agent': 'agent-web-fetch/1', accept: ALLOWED_TYPES.join(', ') },
      });
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code === 'EGRESS_DENIED') throw new ToolError('EGRESS_DENIED', `${url.hostname} resolves to a non-public address`, { committed: 'no' });
      throw new ToolError('TRANSIENT', `fetch failed for ${url.hostname}`, { committed: 'no', cause: error });
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      url = checkUrl(new URL(res.headers.get('location')!, url).toString(), allowedPorts);
      continue;
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED_TYPES.includes(contentType)) {
      await res.body?.cancel();
      throw new ToolError('VALIDATION', `content type "${contentType || 'unknown'}" is not fetched`, { committed: 'no' });
    }

    // Stream with a hard byte cap: a Content-Length header is a claim, not a limit.
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      for await (const chunk of res.body) {
        const c = chunk as Uint8Array;
        if (size + c.byteLength > maxBytes) {
          chunks.push(c.subarray(0, maxBytes - size));
          size = maxBytes;
          truncated = true;
          break;
        }
        chunks.push(c);
        size += c.byteLength;
      }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const isHtml = contentType.includes('html');
    const title = isHtml ? htmlToText(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 300) : '';
    return { url: url.toString(), status: res.status, contentType, title, text: isHtml ? htmlToText(body) : body, truncated };
  }
  throw new ToolError('EGRESS_DENIED', 'too many redirects', { committed: 'no' });
}

export interface SafePostOptions {
  timeoutMs?: number;
  /** Tests only, as for safeFetch. */
  addressPolicy?: (ip: string) => boolean;
  lookup?: typeof dnsLookup;
  allowedPorts?: number[];
}

/**
 * An outbound webhook delivery (docs/module4.md §7): one POST to a customer-registered HTTPS
 * URL, under the same public-address guard as safeFetch. No redirects are followed (a redirect
 * is an easy way to aim a delivery at an internal address) and nothing of the response is
 * returned but its status.
 */
export async function safePost(rawUrl: string, body: string, headers: Record<string, string>, options: SafePostOptions = {}): Promise<{ status: number }> {
  const url = checkUrl(rawUrl, options.allowedPorts ?? [443]);
  if (url.protocol !== 'https:' && !options.allowedPorts) throw new ToolError('EGRESS_DENIED', 'webhooks are delivered over https only', { committed: 'no' });
  const dispatcher = guardedAgent(options.addressPolicy ?? isPublicAddress, options.lookup ?? dnsLookup);
  try {
    const res = await undiciFetch(url, { method: 'POST', redirect: 'manual', dispatcher, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000), headers: { 'user-agent': 'agent-webhooks/1', ...headers }, body });
    await res.body?.cancel();
    return { status: res.status };
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === 'EGRESS_DENIED') throw new ToolError('EGRESS_DENIED', `${url.hostname} resolves to a non-public address`, { committed: 'no' });
    throw new ToolError('TRANSIENT', `delivery to ${url.hostname} failed`, { committed: 'no', cause: error });
  }
}
