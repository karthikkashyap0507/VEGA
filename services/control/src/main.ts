import { existsSync } from 'node:fs';
import { createLogger, internalServerTls, loadTls, mtlsFetch, startHealthServer } from '@vega/shared';
import { PgTokenVault, sandboxFetch } from '@vega/connector-sdk';
import { safePost } from '@vega/connector-web';
import { AnthropicClient } from '@vega/llm';
import { DevPlannerModel } from '@vega/planner';
import { s3FromEnv } from '@vega/objectstore';
import { DEFAULT_CATALOG } from '@vega/policy-engine';
import { RunStore } from '@vega/runs';
import { RunCoordinator, type WebhookDeliverer } from './agent/coordinator.js';
import { heuristicMentions, llmMentions } from './agent/intent.js';
import { loadRunTokenIssuer } from './agent/tokens.js';
import { plannerRoute } from './agent/routing.js';
import { loadBundleKey, PolicyPublisher } from './policy/publisher.js';
import { ReversibilityStore } from '@vega/compensators';
import { PgMcpToolStore } from '@vega/connector-mcp';
import { launchRegistry, oauthClientsFromEnv } from '@vega/connectors';
import { HttpExecutionClient } from './connectors/deps.js';
import { assertNotSuperuser, migrate } from '@vega/db';
import { FgaClient, fgaAdmin, modelToJson } from '@vega/authz';
import { InMemoryIdentityAdmin, loadKeyFile, PrincipalAssertionVerifier, ZitadelAdmin, type IdentityAdmin } from '@vega/idp';
import { initTelemetry } from '@vega/telemetry';
import { buildControlApp } from './app.js';

/**
 * Control-plane process. Loud about every development shortcut it takes: module1 plan,
 * "Leave the loud warnings in … silence here is how an ungoverned deployment reaches a
 * customer."
 */
const logger = createLogger('control');
const env = process.env;
const production = env['NODE_ENV'] === 'production';
initTelemetry({ serviceName: 'control' });

if (env['DATABASE_URL'] && !production) await migrate(env['DATABASE_URL']);
await assertNotSuperuser();

// ---------------------------------------------------------------- identity admin
let identity: IdentityAdmin;
const saPath = env['ZITADEL_SERVICE_ACCOUNT_KEY_PATH'] ?? './infra/docker/secrets/zitadel-sa.json';
if (existsSync(saPath)) {
  identity = new ZitadelAdmin({
    issuer: env['ZITADEL_ISSUER'] ?? 'http://localhost:8080',
    auth: { kind: 'serviceAccount', key: await loadKeyFile(saPath) },
  });
} else if (production) {
  throw new Error(`Zitadel service account key not found at ${saPath}`);
} else {
  logger.warn(`UNGOVERNED DEV MODE: no Zitadel service account at ${saPath}; using an in-memory IdP admin. Run pnpm idp:bootstrap.`);
  identity = new InMemoryIdentityAdmin();
}

// ---------------------------------------------------------------- authorization
const fgaUrl = env['OPENFGA_API_URL'] ?? 'http://localhost:8081';
let storeId = env['OPENFGA_STORE_ID'];
let modelId = env['OPENFGA_MODEL_ID'];
if (!storeId || !modelId) {
  if (production) throw new Error('OPENFGA_STORE_ID and OPENFGA_MODEL_ID are required in production');
  storeId = await fgaAdmin.createStore({ apiUrl: fgaUrl }, 'dev');
  modelId = await fgaAdmin.writeModel({ apiUrl: fgaUrl }, storeId, modelToJson());
  logger.warn({ storeId, modelId }, 'DEV: created an OpenFGA store; set OPENFGA_STORE_ID/OPENFGA_MODEL_ID in .env to keep it across restarts');
}
const fga = new FgaClient({ apiUrl: fgaUrl, storeId, modelId, ...(env['OPENFGA_API_TOKEN'] ? { apiToken: env['OPENFGA_API_TOKEN'] } : {}) });

// ---------------------------------------------------------------- principal verification
const jwksUrl = new URL(env['GATEWAY_JWKS_URL'] ?? 'http://localhost:3001/.well-known/jwks.json');
const verifier = new PrincipalAssertionVerifier(jwksUrl, 'gateway', 'control');

const tls = loadTls();
if (!tls) {
  if (production) throw new Error('TLS_* is required in production: the control plane only serves mTLS');
  logger.warn('DEV: serving plain HTTP; in a cluster the control plane requires mTLS client certificates');
}

// ---------------------------------------------------------------- connectors (Module 2)
const executionToken = env['EXECUTION_INTERNAL_TOKEN'];
const stateSecret = env['CONNECTOR_STATE_SECRET'] ?? env['SESSION_SECRET'];
const sandboxUrl = env['CONNECTOR_SANDBOX_URL'];
if (sandboxUrl && production) throw new Error('CONNECTOR_SANDBOX_URL is refused in production');
if (sandboxUrl) logger.warn({ sandboxUrl }, 'DEV: OAuth token exchange goes to a SANDBOX provider');
let connectors;
if (executionToken && stateSecret) {
  const oauthClients = oauthClientsFromEnv(env, env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001', sandboxUrl ? sandboxFetch(sandboxUrl) : undefined);
  connectors = {
    registry: launchRegistry(),
    oauthClients,
    vault: new PgTokenVault(),
    execution: new HttpExecutionClient(env['EXECUTION_URL'] ?? 'http://localhost:3003', executionToken, tls ? mtlsFetch(tls) : undefined),
    mcpStore: new PgMcpToolStore(),
    stateSecret,
  };
  const missing = (['google', 'microsoft', 'slack'] as const).filter((p) => !oauthClients[p]);
  if (missing.length) logger.warn({ providers: missing }, 'no OAuth client configured: these providers are unavailable');
} else {
  if (production) throw new Error('EXECUTION_INTERNAL_TOKEN and CONNECTOR_STATE_SECRET are required in production');
  logger.warn('DEV: EXECUTION_INTERNAL_TOKEN or CONNECTOR_STATE_SECRET unset: connector procedures answer 503');
}

// ---------------------------------------------------------------- agent core (Module 4)
// Model calls go through LiteLLM (D-12) when configured, else straight to the vendor API; with
// neither, the development planner and mention heuristics stand in — loudly.
const modelKey = env['LITELLM_MASTER_KEY'] || env['ANTHROPIC_API_KEY'];
const modelBase = env['LITELLM_MASTER_KEY'] ? env['LITELLM_BASE_URL'] : undefined;
const llm = modelKey ? new AnthropicClient({ apiKey: modelKey, ...(modelBase ? { baseUrl: modelBase } : {}) }) : undefined;
if (!llm) {
  if (production) throw new Error('a planner model is required in production (LITELLM_MASTER_KEY or ANTHROPIC_API_KEY)');
  logger.warn('DEV: no model key: planning uses the DEVELOPMENT PLANNER (a fixed set of objective shapes) and heuristic entity mentions');
}
let agent;
if (connectors) {
  const issuer = await loadRunTokenIssuer(env, logger, production);
  const webFetchUrl = env['WEB_FETCH_URL'];
  const webhooks: WebhookDeliverer = webFetchUrl
    ? {
        async deliver(url, body, headers) {
          const f = tls ? mtlsFetch(tls) : fetch;
          const res = await f(`${webFetchUrl.replace(/\/$/, '')}/deliver`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, body, headers }) });
          const j = (await res.json().catch(() => ({}))) as { status?: number; error?: { message: string } };
          if (!res.ok) throw new Error(j.error?.message ?? `web-fetch ${res.status}`);
          return { status: j.status ?? 0 };
        },
      }
    : { deliver: (url, body, headers) => safePost(url, body, headers) };
  if (!webFetchUrl && production) throw new Error('WEB_FETCH_URL is required in production: webhooks are delivered by the isolated fetcher');
  const core = {
    store: new RunStore(),
    execution: connectors.execution,
    registry: connectors.registry,
    log: logger,
    issuer,
    webhooks,
    mentions: llm ? llmMentions(llm, env['MODEL_ROUTINE'] ?? 'claude-sonnet-5') : heuristicMentions,
    planning: llm
      ? {
          execution: connectors.execution,
          llm,
          model: env['MODEL_PLANNER'] ?? DEFAULT_CATALOG.best.planner,
          source: 'planner' as const,
          // C4 (Module 5): the tenant's plan, residency and budget choose the planner model.
          route: plannerRoute({
            ...DEFAULT_CATALOG,
            best: { ...DEFAULT_CATALOG.best, planner: env['MODEL_PLANNER'] ?? DEFAULT_CATALOG.best.planner },
            economy: { ...DEFAULT_CATALOG.economy, planner: env['MODEL_PLANNER_ECONOMY'] ?? DEFAULT_CATALOG.economy.planner },
          }),
        }
      : { execution: connectors.execution, llm: new DevPlannerModel(), model: 'dev-planner', source: 'dev_planner' as const },
  };
  const coordinator = new RunCoordinator(core);
  coordinator.start();
  agent = { core, coordinator };
}

// ---------------------------------------------------------------- policy distribution (Module 5)
// Compile → sign (ES256) → object storage; OPA polls it through a signed discovery bundle.
let policy: { publisher: PolicyPublisher } | undefined;
try {
  const key = loadBundleKey({ pem: env['OPA_BUNDLE_SIGNING_KEY'], path: env['OPA_BUNDLE_SIGNING_KEY_PATH'] ?? './infra/docker/secrets/opa-bundle-key.pem', production, log: logger, ...(env['OPA_STORE_URL'] ? { storeUrl: env['OPA_STORE_URL'] } : {}) });
  const publisher = new PolicyPublisher(s3FromEnv(env, env['S3_BUCKET_POLICY'] ?? 'vega-policy'), key, logger, production ? { min: 10, max: 30 } : { min: 2, max: 5 });
  await publisher.publishBaseline();
  policy = { publisher };
} catch (error) {
  if (production) throw error;
  logger.warn({ err: error }, 'DEV: policy distribution unavailable (object storage down?): building and activating bundles answers 503; OPA keeps what it has');
}

// ---------------------------------------------------------------- reversibility (Module 6)
// Revokes read precomputed authorization from Valkey (the execution plane writes it when a hold
// opens); the database is the fallback and always the source of truth.
let revokeCache: { get(key: string): Promise<string | null> } | undefined;
try {
  const Valkey = (await import('iovalkey')).default;
  const client = new Valkey(env['VALKEY_URL'] ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  await client.connect();
  revokeCache = { get: (k) => client.get(k) };
} catch (error) {
  if (production) throw error;
  logger.warn({ err: error }, 'DEV: Valkey unreachable; revokes use the database (slower, still correct)');
}
if (!env['PUSH_TOPIC_SECRET']) logger.warn('PUSH_TOPIC_SECRET unset: the console cannot show anyone their push topic');
const reversibility = { store: new ReversibilityStore(), cache: revokeCache, pushSecret: env['PUSH_TOPIC_SECRET'] };

const app = await buildControlApp({
  deps: { identity, fga, logger, returnInviteCodes: !production, ...(connectors ? { connectors } : {}), ...(agent ? { agent } : {}), ...(policy ? { policy } : {}), reversibility },
  verifier,
  ...(tls ? { https: internalServerTls(tls) } : {}),
});
const port = Number(env['CONTROL_PORT'] ?? 3002);
await app.listen({ port, host: env['HOST'] ?? '127.0.0.1' });
logger.info({ port }, 'control plane listening');
// Probes cannot present client certificates; with mTLS on, health lives on its own port.
if (tls) startHealthServer(Number(process.env['HEALTH_PORT'] ?? 9000), async () => true);
