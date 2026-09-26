import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createLogger } from '@vega/shared';
import { migrate } from '@vega/db';
import { FgaClient, fgaAdmin, modelToJson } from '@vega/authz';
import { InMemoryIdentityAdmin, PrincipalAssertionIssuer, PrincipalAssertionVerifier } from '@vega/idp';
import { buildControlApp, injectFetch, provisionTenant, activateOnFirstSignIn } from '@vega/service-control';
import type { Plan } from '@vega/contracts';
import { buildGateway, sessionCookieName } from '../src/app.js';
import { controlClientFactory } from '../src/control-client.js';
import { MemoryRateStore } from '../src/rate-limit.js';
import { SessionService } from '../src/sessions.js';
import { FakeIdp } from './fake-idp.js';

process.env['DATABASE_URL'] ??= 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
process.env['DATABASE_APP_URL'] ??= 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';
const FGA_URL = process.env['OPENFGA_API_URL'] ?? 'http://localhost:8081';

export const COOKIE = sessionCookieName(false);

export interface GatewayHarness {
  gateway: FastifyInstance;
  control: FastifyInstance;
  idp: FakeIdp;
  identity: InMemoryIdentityAdmin;
  fga: FgaClient;
  sessions: SessionService;
  tenant: (plan?: Plan) => Promise<{ tenantId: string; userId: string; workspaceId: string; subject: string }>;
  signIn: (subject: string, returnTo?: string) => Promise<{ cookie: string; response: LightMyRequestResponse }>;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  rotateAfterSeconds?: number;
  tokenLimit?: number;
  signupAllowPassword?: boolean;
}

export function cookieFrom(res: LightMyRequestResponse, name: string): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const [k, v] = (pair ?? '').split('=');
    if (k === name) return v;
  }
  return undefined;
}

export async function createGatewayHarness(options: HarnessOptions = {}): Promise<GatewayHarness> {
  await migrate(process.env['DATABASE_URL']);
  const logger = createLogger(
    'gateway-test',
    { level: process.env['TEST_LOG_LEVEL'] ?? 'silent' },
    new Writable({ write: (_c, _e, cb) => cb() }),
  );

  const storeId = await fgaAdmin.createStore({ apiUrl: FGA_URL }, `gateway-test-${Date.now()}`);
  const modelId = await fgaAdmin.writeModel({ apiUrl: FGA_URL }, storeId, modelToJson());
  const fga = new FgaClient({ apiUrl: FGA_URL, storeId, modelId });
  const identity = new InMemoryIdentityAdmin();

  const issuer = await PrincipalAssertionIssuer.ephemeral('gateway', 'control');
  const control = await buildControlApp({
    deps: { identity, fga, logger, returnInviteCodes: true },
    verifier: new PrincipalAssertionVerifier(issuer.jwks, 'gateway', 'control'),
  });

  const idp = await FakeIdp.create();
  const sessions = new SessionService({
    ttlSeconds: 3600,
    absoluteTtlSeconds: 12 * 3600,
    ...(options.rotateAfterSeconds !== undefined ? { rotateAfterSeconds: options.rotateAfterSeconds } : {}),
    kek: randomBytes(32),
    oidc: idp.client,
    logger,
  });

  const gateway = await buildGateway({
    logger,
    sessions,
    controlFor: controlClientFactory('http://control.internal', issuer, injectFetch(control)),
    rateStore: new MemoryRateStore(),
    oidc: idp.client,
    jwks: issuer.jwks,
    config: {
      publicUrl: 'http://gateway.test',
      webUrl: 'http://web.test',
      sessionSecret: randomBytes(32).toString('base64'),
      cookieSecure: false,
      ttlSeconds: 3600,
      rateLimits: { tenant: 10_000, token: options.tokenLimit ?? 10_000, anon: 10_000 },
      signupAllowPassword: options.signupAllowPassword ?? false,
    },
  });

  const signIn = async (subject: string, returnTo = '/action-center') => {
    const start = await gateway.inject({ method: 'GET', url: `/v1/oauth/login?returnTo=${encodeURIComponent(returnTo)}` });
    const loginCookie = cookieFrom(start, `${COOKIE}_login`);
    const { code, state } = idp.authorize(String(start.headers.location), subject);
    const response = await gateway.inject({
      method: 'GET',
      url: `/v1/oauth/callback?code=${code}&state=${state}`,
      cookies: loginCookie ? { [`${COOKIE}_login`]: loginCookie } : {},
    });
    return { cookie: cookieFrom(response, COOKIE) ?? '', response };
  };

  return {
    gateway,
    control,
    idp,
    identity,
    fga,
    sessions,
    signIn,
    tenant: async (plan = 'business') => {
      const suffix = randomBytes(4).toString('hex');
      const t = await provisionTenant(
        { identity, fga, logger },
        { tenantName: `GW ${suffix}`, plan, owner: { email: `owner-${suffix}@example.com` } },
      );
      return { tenantId: t.tenantId, userId: t.userId, workspaceId: t.workspaceId, subject: t.ownerIdpSubject };
    },
    close: async () => {
      await gateway.close();
      await control.close();
    },
  };
}

export { activateOnFirstSignIn };
