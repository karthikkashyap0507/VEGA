import Valkey from 'iovalkey';
import { createLogger, internalServerTls, loadTls, startHealthServer, mtlsFetch } from '@vega/shared';
import {
  ConnectorRuntime,
  MemoryTokenBucket,
  PgConnectorStore,
  PgInvocationStore,
  PgTokenVault,
  ValkeyTokenBucket,
  type TokenBucket,
} from '@vega/connector-sdk';
import { McpToolSource, PgMcpToolStore } from '@vega/connector-mcp';
import { remoteBackend, setWebBackend } from '@vega/connector-web';
import { launchRegistry, oauthClientsFromEnv } from '@vega/connectors';
import { buildExecutionApp } from './app.js';
import { EvidenceAppendClient } from './evidence-append.js';

const logger = createLogger('execution');
const env = process.env;
const production = env['NODE_ENV'] === 'production';
const evidenceUrl = env['EVIDENCE_URL'] ?? 'http://localhost:3004';
const token = env['EVIDENCE_APPEND_TOKEN'];
if (!token) logger.warn('EVIDENCE_APPEND_TOKEN is not set: execution will report NOT READY');

const tls = loadTls();
if (!tls) logger.warn('DEV: plain HTTP; in a cluster execution serves and calls evidence over mTLS only');

// ---------------------------------------------------------------- connector runtime (Module 2)
// The web is fetched by the isolated web-fetch pod (module2.md §10.3), never from this process
// in a cluster. Locally, unset WEB_FETCH_URL runs safeFetch in-process.
const webFetchUrl = env['WEB_FETCH_URL'];
if (webFetchUrl) setWebBackend(remoteBackend(webFetchUrl, tls ? mtlsFetch(tls) : undefined));
else if (production) throw new Error('WEB_FETCH_URL is required in production: execution does not fetch the web itself');
let buckets: TokenBucket = new MemoryTokenBucket();
try {
  const valkey = new Valkey(env['VALKEY_URL'] ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  await valkey.connect();
  buckets = new ValkeyTokenBucket({ script: (src, keys, args) => valkey.call('EVAL', src, keys.length, ...keys, ...args) });
} catch (error) {
  if (production) throw error;
  logger.warn({ err: error }, 'DEV: Valkey unreachable; connector rate limits are per-process only');
}
const mcpStore = new PgMcpToolStore();
const runtime = new ConnectorRuntime({
  registry: launchRegistry(),
  dynamicTools: new McpToolSource(mcpStore),
  connectors: new PgConnectorStore(),
  vault: new PgTokenVault(),
  invocations: new PgInvocationStore(),
  buckets,
  oauthClients: oauthClientsFromEnv(env, env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001'),
});
const internalToken = env['EXECUTION_INTERNAL_TOKEN'];
if (!internalToken) {
  if (production) throw new Error('EXECUTION_INTERNAL_TOKEN is required in production');
  logger.warn('DEV: EXECUTION_INTERNAL_TOKEN unset: the connector API is not mounted');
}

const app = await buildExecutionApp({
  ...(token ? { evidence: new EvidenceAppendClient(evidenceUrl, token, tls ? mtlsFetch(tls) : undefined) } : {}),
  ...(internalToken ? { connectors: { runtime, mcpStore, token: internalToken } } : {}),
  ...(tls ? { https: internalServerTls(tls) } : {}),
});
const port = Number(env['EXECUTION_PORT'] ?? 3003);
await app.listen({ port, host: env['HOST'] ?? '127.0.0.1' });
logger.info({ port }, 'execution plane listening');
// Probes cannot present client certificates; with mTLS on, health lives on its own port.
if (tls) startHealthServer(Number(env['HEALTH_PORT'] ?? 9000), async () => Boolean(token));
