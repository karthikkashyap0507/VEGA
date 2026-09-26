import { existsSync } from 'node:fs';
import { createLogger, internalServerTls, loadTls, mtlsFetch, startHealthServer } from '@vega/shared';
import { PgTokenVault } from '@vega/connector-sdk';
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
let connectors;
if (executionToken && stateSecret) {
  const oauthClients = oauthClientsFromEnv(env, env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001');
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

const app = await buildControlApp({
  deps: { identity, fga, logger, returnInviteCodes: !production, ...(connectors ? { connectors } : {}) },
  verifier,
  ...(tls ? { https: internalServerTls(tls) } : {}),
});
const port = Number(env['CONTROL_PORT'] ?? 3002);
await app.listen({ port, host: env['HOST'] ?? '127.0.0.1' });
logger.info({ port }, 'control plane listening');
// Probes cannot present client certificates; with mTLS on, health lives on its own port.
if (tls) startHealthServer(Number(process.env['HEALTH_PORT'] ?? 9000), async () => true);
