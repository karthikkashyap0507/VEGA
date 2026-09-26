import { Writable } from 'node:stream';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@vega/shared';
import { migrate, withTenant, schema } from '@vega/db';
import { FgaClient, fgaAdmin, modelToJson } from '@vega/authz';
import {
  InMemoryIdentityAdmin,
  PrincipalAssertionIssuer,
  PrincipalAssertionVerifier,
} from '@vega/idp';
import type { Plan } from '@vega/contracts';
import { eq } from 'drizzle-orm';
import { buildControlApp, PRINCIPAL_HEADER } from '../src/app.js';
import { injectFetch } from '../src/inject-fetch.js';
import { activateOnFirstSignIn, provisionTenant } from '../src/provisioning.js';
import type { AppRouter } from '../src/routers/index.js';
import type { ControlDeps } from '../src/trpc.js';

/**
 * Control-plane test harness: REAL Postgres (app role, RLS enforced), a fresh OpenFGA store
 * with the checked-in model, and REAL signed principal assertions. Requests go through the
 * actual HTTP surface via Fastify's inject — the same path the gateway uses — so the
 * assertion verification is exercised on every call, not bypassed by a direct caller.
 */

process.env['DATABASE_URL'] ??= 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
process.env['DATABASE_APP_URL'] ??= 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';
const FGA_URL = process.env['OPENFGA_API_URL'] ?? 'http://localhost:8081';

export interface Harness {
  app: FastifyInstance;
  identity: InMemoryIdentityAdmin;
  fga: FgaClient;
  deps: ControlDeps;
  issuer: PrincipalAssertionIssuer;
  as: (tenantId: string, userId: string) => ReturnType<typeof clientFor>;
  raw: (headers: Record<string, string>) => ReturnType<typeof clientFor>;
  tenant: (plan?: Plan) => Promise<{ tenantId: string; userId: string; workspaceId: string; orgId: string }>;
  close: () => Promise<void>;
}

const silent = () =>
  createLogger(
    'test',
    { level: process.env['TEST_LOG_LEVEL'] ?? 'silent' },
    new Writable({ write: (_c, _e, cb) => cb() }),
  );

function clientFor(app: FastifyInstance, headers: () => Promise<Record<string, string>>) {
  return createTRPCClient<AppRouter>({
    links: [httpLink({ url: 'http://control.internal/trpc', fetch: injectFetch(app) as never, headers })],
  });
}

export async function createHarness(extra: Partial<ControlDeps> = {}): Promise<Harness> {
  await migrate(process.env['DATABASE_URL']);
  const storeId = await fgaAdmin.createStore({ apiUrl: FGA_URL }, `control-test-${Date.now()}`);
  const modelId = await fgaAdmin.writeModel({ apiUrl: FGA_URL }, storeId, modelToJson());
  const fga = new FgaClient({ apiUrl: FGA_URL, storeId, modelId });
  const identity = new InMemoryIdentityAdmin();
  const logger = silent();
  const deps: ControlDeps = { identity, fga, logger, returnInviteCodes: true, ...extra };

  const issuer = await PrincipalAssertionIssuer.ephemeral('gateway', 'control');
  const verifier = new PrincipalAssertionVerifier(issuer.jwks, 'gateway', 'control');
  const app = await buildControlApp({ deps, verifier });

  return {
    app,
    identity,
    fga,
    deps,
    issuer,
    as: (tenantId, userId) =>
      clientFor(app, async () => ({ [PRINCIPAL_HEADER]: await issuer.mint({ tenantId, userId }) })),
    raw: (headers) => clientFor(app, async () => headers),
    tenant: async (plan = 'business') => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const t = await provisionTenant(
        { identity, fga, logger },
        { tenantName: `Test ${suffix}`, plan, owner: { email: `owner-${suffix}@example.com` } },
      );
      await activateOnFirstSignIn(t.tenantId, t.userId);
      return { tenantId: t.tenantId, userId: t.userId, workspaceId: t.workspaceId, orgId: t.orgId };
    },
    close: async () => {
      await app.close();
    },
  };
}

/** Activates a user as if they had signed in (the gateway does this on first sign-in). */
export async function activate(tenantId: string, userId: string): Promise<void> {
  await withTenant(tenantId, (db) =>
    db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, userId)),
  );
}

/** The RFC 9457 problem the control plane attached to a failed call. */
export async function problemOf(promise: Promise<unknown>): Promise<{ type: string; status: number; detail?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TRPCClientError) {
      const problem = (error.data as { problem?: { type: string; status: number; detail?: string } } | undefined)
        ?.problem;
      if (problem) return problem;
      return { type: `trpc:${(error.data as { code?: string } | undefined)?.code ?? 'unknown'}`, status: 0 };
    }
    throw error;
  }
  throw new Error('expected the call to fail, but it succeeded');
}
