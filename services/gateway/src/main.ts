import { existsSync, readFileSync } from 'node:fs';
import Valkey from 'iovalkey';
import { createLogger, loadLocalKek, loadTls, mtlsFetch } from '@vega/shared';
import { assertNotSuperuser } from '@vega/db';
import { loadKeyFile, OidcClient, PrincipalAssertionIssuer } from '@vega/idp';
import { initTelemetry } from '@vega/telemetry';
import { buildGateway } from './app.js';
import { loadConfig } from './config.js';
import { controlClientFactory } from './control-client.js';
import { MemoryRateStore, ValkeyRateStore, type RateStore } from './rate-limit.js';
import { SessionService } from './sessions.js';

const logger = createLogger('gateway');
const config = loadConfig();
initTelemetry({ serviceName: 'gateway' });
await assertNotSuperuser();

// ---------------------------------------------------------------- OIDC
let oidc: OidcClient | undefined;
if (existsSync(config.ZITADEL_APP_KEY_PATH)) {
  oidc = new OidcClient(
    { issuer: config.ZITADEL_ISSUER, redirectUri: config.ZITADEL_REDIRECT_URI },
    await loadKeyFile(config.ZITADEL_APP_KEY_PATH),
  );
} else {
  logger.warn(`sign-in DISABLED: no Zitadel app key at ${config.ZITADEL_APP_KEY_PATH}. Run pnpm idp:bootstrap.`);
}

// ---------------------------------------------------------------- signing keys
const issuer = config.PRINCIPAL_SIGNING_KEY_PATH
  ? await PrincipalAssertionIssuer.fromPem(
      readFileSync(config.PRINCIPAL_SIGNING_KEY_PATH, 'utf8'),
      'principal-1',
      'gateway',
      'control',
    )
  : await PrincipalAssertionIssuer.ephemeral('gateway', 'control');
if (!config.PRINCIPAL_SIGNING_KEY_PATH) {
  if (config.NODE_ENV === 'production') throw new Error('PRINCIPAL_SIGNING_KEY_PATH is required in production');
  logger.warn('DEV: ephemeral principal-assertion key; the control plane fetches it from /.well-known/jwks.json');
}

// ---------------------------------------------------------------- rate limits
let rateStore: RateStore;
try {
  const valkey = new Valkey(config.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await valkey.connect();
  rateStore = new ValkeyRateStore(valkey);
} catch (error) {
  if (config.NODE_ENV === 'production') throw error;
  logger.warn({ err: error }, 'DEV: Valkey unreachable; rate limits are per-process only');
  rateStore = new MemoryRateStore();
}

const sessions = new SessionService({
  ttlSeconds: config.SESSION_TTL_SECONDS,
  absoluteTtlSeconds: config.REFRESH_TTL_SECONDS,
  kek: loadLocalKek(),
  ...(oidc ? { oidc } : {}),
  logger,
});

const app = await buildGateway({
  logger,
  sessions,
  // The gateway presents its workload certificate to the control plane (mTLS, §3.1).
  controlFor: controlClientFactory(config.CONTROL_URL, issuer, (() => {
    const tls = loadTls();
    return tls ? mtlsFetch(tls) : undefined;
  })()),
  rateStore,
  ...(oidc ? { oidc } : {}),
  jwks: issuer.jwks,
  config: {
    publicUrl: config.GATEWAY_PUBLIC_URL,
    webUrl: config.WEB_PUBLIC_URL,
    sessionSecret: config.SESSION_SECRET,
    cookieSecure: config.cookieSecure,
    ttlSeconds: config.SESSION_TTL_SECONDS,
    rateLimits: {
      tenant: config.RATE_LIMIT_TENANT_PER_MINUTE,
      token: config.RATE_LIMIT_TOKEN_PER_MINUTE,
      anon: config.RATE_LIMIT_ANON_PER_MINUTE,
    },
    signupAllowPassword: config.SIGNUP_ALLOW_PASSWORD,
  },
});
await app.listen({ port: config.GATEWAY_PORT, host: process.env['HOST'] ?? '127.0.0.1' });
logger.info({ port: config.GATEWAY_PORT }, 'gateway listening');
