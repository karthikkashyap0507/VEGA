import { z } from 'zod';
import { SourcedSchema } from '@vega/contracts';
import { defineTool, sourced, ToolError, type ConnectorDefinition, type ToolContext } from '@vega/connector-sdk';
import { safeFetch, type FetchedPage } from './safe-fetch.js';

export { safeFetch, safePost, isPublicAddress, ALLOWED_TYPES, type FetchedPage, type SafeFetchOptions, type SafePostOptions } from './safe-fetch.js';

/**
 * Web fetch & search — docs/module2.md §5.2, §10.3.
 *
 * | Tool       | Egress | Rev | Max taint | Idempotency | Notes                          |
 * | web.fetch  | PUBLIC | R0  | ORG       | NONE        | isolated pod, no credentials   |
 * | web.search | PUBLIC | R0  | ORG       | NONE        | SearXNG as a network service   |
 *
 * Output is UNTRUSTED unconditionally and cannot be overridden: there is no argument, config or
 * connector setting that changes the label.
 *
 * Max taint is ORG, not UNTRUSTED (docs/module3.md §5.3): the URL and the query leave the
 * organization, so a URL or query derived from untrusted content — "fetch the link in this
 * email", a link found on a poisoned page — is an exfiltration channel (data in the query
 * string, a read receipt) and waits for a human. Found by the Module 3 red-team corpus.
 *
 * Backend: in a cluster the execution plane never fetches the web itself — it calls the
 * isolated web-fetch service (WEB_FETCH_URL), the only pod with public egress. Locally, and in
 * the web-fetch service itself, `safeFetch` runs in-process.
 */

export interface WebBackend {
  fetch(url: string, maxBytes: number): Promise<FetchedPage>;
  search(query: string, max: number): Promise<Array<{ url: string; title: string; snippet: string }>>;
}

export function inProcessBackend(env: NodeJS.ProcessEnv = process.env): WebBackend {
  return {
    fetch: (url, maxBytes) => safeFetch(url, { maxBytes }),
    async search(query, max) {
      const base = env['SEARXNG_URL'];
      if (!base) throw new ToolError('CONNECTOR_UNAVAILABLE', 'no search backend configured (SEARXNG_URL)', { committed: 'no' });
      const page = await safeFetch(`${base.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(query)}`, {
        maxBytes: 1_000_000,
        // The search engine is an operator-configured service, typically in-cluster.
        addressPolicy: () => true,
        allowedPorts: [80, 443, 8080, 8888],
      });
      const parsed = JSON.parse(page.text) as { results?: Array<{ url: string; title?: string; content?: string }> };
      return (parsed.results ?? []).slice(0, max).map((r) => ({ url: r.url, title: r.title ?? '', snippet: r.content ?? '' }));
    },
  };
}

/** Calls the isolated web-fetch service. */
export function remoteBackend(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch): WebBackend {
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as T & { error?: { code: string; message: string } };
    if (!res.ok || data.error) {
      throw new ToolError((data.error?.code as never) ?? 'PROVIDER_ERROR', data.error?.message ?? `web-fetch ${res.status}`, { committed: 'no' });
    }
    return data;
  };
  return {
    fetch: (url, maxBytes) => call<FetchedPage>('/fetch', { url, maxBytes }),
    search: async (query, max) => (await call<{ results: Array<{ url: string; title: string; snippet: string }> }>('/search', { query, max })).results,
  };
}

let backendOverride: WebBackend | undefined;
/** Wiring point for the execution plane and tests. */
export function setWebBackend(backend: WebBackend | undefined): void {
  backendOverride = backend;
}
function backend(): WebBackend {
  if (backendOverride) return backendOverride;
  const remote = process.env['WEB_FETCH_URL'];
  return remote ? remoteBackend(remote) : inProcessBackend();
}

const Page = z.object({ url: z.string(), title: z.string(), text: z.string(), contentType: z.string(), truncated: z.boolean() });

export const fetchTool = defineTool({
  toolId: 'web.fetch',
  connectorKind: 'web',
  version: 1,
  title: 'Fetch a web page',
  description: 'Fetch a public page as text. Active content is stripped; the result is always UNTRUSTED.',
  scopes: [],
  egressClass: 'PUBLIC',
  reversibility: 'R0',
  maxTaint: 'ORG',
  idempotency: 'NONE',
  sensitivityHint: 20,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'UNTRUSTED',
  recipientArgs: [],
  argsSchema: z.object({ url: z.string().url().max(2048), maxBytes: z.number().int().min(1).max(5_000_000).default(1_000_000) }),
  effectSchema: z.object({ page: SourcedSchema(Page).nullable() }),
  async simulate(args) {
    return {
      summary: `Fetches ${new URL(args.url).hostname}. Changes nothing, but the site sees a request from us.`,
      fidelity: 'DERIVED',
      externalRecipients: [],
      recordsAffected: [],
      detail: { page: null },
    };
  },
  async execute(args, _ctx: ToolContext) {
    const page = await backend().fetch(args.url, args.maxBytes);
    const value = { url: page.url, title: page.title, text: page.text, contentType: page.contentType, truncated: page.truncated };
    return {
      effect: {
        summary: `Fetched ${new URL(page.url).hostname}${page.truncated ? ' (truncated)' : ''}.`,
        fidelity: 'PROVIDER',
        externalRecipients: [],
        recordsAffected: [],
        detail: { page: sourced(value, { system: 'web:page', id: page.url, taint: 'UNTRUSTED' }) },
      },
    };
  },
});

const Result = z.object({ url: z.string(), title: z.string(), snippet: z.string() });

export const searchTool = defineTool({
  toolId: 'web.search',
  connectorKind: 'web',
  version: 1,
  title: 'Search the web',
  description: 'Search the public web. Results are always UNTRUSTED.',
  scopes: [],
  egressClass: 'PUBLIC',
  reversibility: 'R0',
  maxTaint: 'ORG',
  idempotency: 'NONE',
  sensitivityHint: 10,
  holdSupported: false,
  simulateFidelity: 'DERIVED',
  outputTaint: 'UNTRUSTED',
  recipientArgs: [],
  argsSchema: z.object({ query: z.string().min(1).max(400), max: z.number().int().min(1).max(20).default(8) }),
  effectSchema: z.object({ results: z.array(SourcedSchema(Result)) }),
  async simulate(args) {
    return { summary: `Searches the web for "${args.query}". Changes nothing.`, fidelity: 'DERIVED', externalRecipients: [], recordsAffected: [], detail: { results: [] } };
  },
  async execute(args) {
    const results = (await backend().search(args.query, args.max)).map((r) => sourced(r, { system: 'web:result', id: r.url, taint: 'UNTRUSTED' }));
    return { effect: { summary: `Found ${results.length} result(s).`, fidelity: 'PROVIDER', externalRecipients: [], recordsAffected: [], detail: { results } } };
  },
});

export const web: ConnectorDefinition = {
  kind: 'web',
  displayName: 'Web',
  provider: 'none',
  apiBase: 'https://invalid.example',
  tools: [fetchTool, searchTool],
  neverDoes: ['Submit forms or log in to websites', 'Reach private networks or cloud metadata', 'Run page scripts'],
  async health() {
    return { ok: true, latencyMs: 0, detail: 'no credential to check' };
  },
};

export default web;
