import { existsSync, readFileSync } from 'node:fs';
import Valkey from 'iovalkey';
import { createLogger, internalServerTls, loadTls, startHealthServer, mtlsFetch } from '@vega/shared';
import {
  ConnectorRuntime,
  MemoryTokenBucket,
  PgConnectorStore,
  PgInvocationStore,
  PgTokenVault,
  sandboxFetch,
  ValkeyTokenBucket,
  type TokenBucket,
} from '@vega/connector-sdk';
import { McpToolSource, PgMcpToolStore } from '@vega/connector-mcp';
import { remoteBackend, setWebBackend } from '@vega/connector-web';
import { launchRegistry, oauthClientsFromEnv } from '@vega/connectors';
import { RunTokenVerifier, type VerifiedRunToken } from '@vega/idp';
import { HttpExtractor, NtfyPager, PgEntities, PgRecorder, SchemaRegistry, type ExtractorPort } from '@vega/interpreter';
import { DbosOrchestrator } from '@vega/orchestration';
import { RunStore } from '@vega/runs';
import { buildExecutionApp } from './app.js';
import { EvidenceAppendClient } from './evidence-append.js';
import { executionHooks, RUN_WORKFLOW, runWorkflow, type RunTokenCheck } from './executor/index.js';
import { RuntimeDeclarations } from './programs.js';

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
// Development only: every provider request goes to a sandbox provider (the E2E suite's fakes).
const sandboxUrl = env['CONNECTOR_SANDBOX_URL'];
if (sandboxUrl && production) throw new Error('CONNECTOR_SANDBOX_URL is refused in production');
if (sandboxUrl) logger.warn({ sandboxUrl }, 'DEV: connectors talk to a SANDBOX provider, not the real APIs');
const providerFetch = sandboxUrl ? sandboxFetch(sandboxUrl) : undefined;
const mcpStore = new PgMcpToolStore();
const registry = launchRegistry();
const runtime = new ConnectorRuntime({
  ...(providerFetch ? { fetchImpl: providerFetch } : {}),
  registry,
  dynamicTools: new McpToolSource(mcpStore),
  connectors: new PgConnectorStore(),
  vault: new PgTokenVault(),
  invocations: new PgInvocationStore(),
  buckets,
  oauthClients: oauthClientsFromEnv(env, env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001', providerFetch),
});
const internalToken = env['EXECUTION_INTERNAL_TOKEN'];
if (!internalToken) {
  if (production) throw new Error('EXECUTION_INTERNAL_TOKEN is required in production');
  logger.warn('DEV: EXECUTION_INTERNAL_TOKEN unset: the connector API is not mounted');
}

// ---------------------------------------------------------------- interpreter (Module 3)
// Untrusted content is shown to a model ONLY in the quarantined extractor pod.
let extractor: ExtractorPort;
if (env['EXTRACTOR_URL'] && env['EXTRACTOR_TOKEN']) {
  extractor = new HttpExtractor(env['EXTRACTOR_URL'], env['EXTRACTOR_TOKEN'], tls ? mtlsFetch(tls) : undefined);
} else {
  if (production) throw new Error('EXTRACTOR_URL and EXTRACTOR_TOKEN are required in production');
  logger.warn('DEV: no EXTRACTOR_URL — extraction steps fail closed until services/extractor is running');
  extractor = { extract: async () => { throw new Error('extractor not configured'); } };
}
const pager = env['NTFY_URL'] ? new NtfyPager(env['NTFY_URL']) : { page: async (v: { severity: string; toolId: string; runId: string }) => logger.error({ alert: true, ...v }, 'TAINT VIOLATION') };

// ---------------------------------------------------------------- durable executor (Module 4)
// One DBOS workflow per run (decision D-13). Its system tables live in their own database.
const evidence = token ? new EvidenceAppendClient(evidenceUrl, token, tls ? mtlsFetch(tls) : undefined) : undefined;
let dbosUrl = env['DBOS_SYSTEM_DATABASE_URL'];
if (!dbosUrl && !production && env['DATABASE_URL']) {
  const u = new URL(env['DATABASE_URL']);
  u.pathname = '/vega_dbos';
  dbosUrl = u.toString();
  logger.warn('DEV: DBOS_SYSTEM_DATABASE_URL unset; using database vega_dbos on the development server');
}
if (!dbosUrl && production) throw new Error('DBOS_SYSTEM_DATABASE_URL is required in production');

// Run tokens are verified against the control plane's public keys (control mints, execution checks).
const jwksPath = env['RUN_TOKEN_JWKS_PATH'] ?? './infra/docker/secrets/run-token-jwks.json';
let verifier: RunTokenVerifier | undefined;
const runTokens: RunTokenCheck = {
  async verify(tokenValue: string): Promise<VerifiedRunToken> {
    // Loaded lazily: in development the control plane writes the file on its first start.
    verifier ??= new RunTokenVerifier({ issuer: env['RUN_TOKEN_ISSUER'] ?? 'vega-control', audience: 'vega-execution', jwks: JSON.parse(env['RUN_TOKEN_JWKS'] ?? readFileSync(jwksPath, 'utf8')) });
    return verifier.verify(tokenValue);
  },
};
const haveJwks = Boolean(env['RUN_TOKEN_JWKS']) || existsSync(jwksPath);
if (!haveJwks && production) throw new Error(`run token JWKS not found at ${jwksPath}`);
if (!haveJwks) logger.warn({ jwksPath }, 'DEV: no run-token JWKS yet; it is read when the first run starts (control writes it)');
if (!evidence && !production) logger.warn('UNGOVERNED DEV MODE: no evidence plane; action receipts go to platform_events only');

const store = new RunStore();
const declarations = new RuntimeDeclarations(registry, runtime);
const orchestrator = dbosUrl ? new DbosOrchestrator({ appName: 'vega-execution', systemDatabaseUrl: dbosUrl, logLevel: env['DBOS_LOG_LEVEL'] ?? 'warn' }) : undefined;
if (orchestrator && internalToken) {
  const invoker = { execute: (i: Parameters<ConnectorRuntime['execute']>[0]) => runtime.execute(i), simulate: (i: Parameters<ConnectorRuntime['simulate']>[0]) => runtime.simulate(i) };
  orchestrator.register(
    RUN_WORKFLOW,
    runWorkflow({
      store,
      invoker,
      declarations,
      extractor,
      entities: new PgEntities(),
      hooks: executionHooks({ log: logger, invoker, evidence, requireEvidence: production }),
      schemas: new SchemaRegistry(),
      recorder: () => new PgRecorder(),
      log: logger,
      pager,
      requireGrant: true,
    }),
  );
  await orchestrator.launch(); // recovers every run that was in flight when the last process died
  logger.info('durable executor launched');
}

const app = await buildExecutionApp({
  ...(evidence ? { evidence } : {}),
  ...(internalToken ? { connectors: { runtime, mcpStore, token: internalToken }, programs: { runtime, registry, extractor, entities: new PgEntities(), pager } } : {}),
  ...(internalToken && orchestrator ? { runs: { orchestrator, store, token: internalToken, runTokens, log: logger } } : {}),
  ...(tls ? { https: internalServerTls(tls) } : {}),
});
const port = Number(env['EXECUTION_PORT'] ?? 3003);
await app.listen({ port, host: env['HOST'] ?? '127.0.0.1' });
logger.info({ port }, 'execution plane listening');
// Probes cannot present client certificates; with mTLS on, health lives on its own port.
if (tls) startHealthServer(Number(env['HEALTH_PORT'] ?? 9000), async () => Boolean(token));
