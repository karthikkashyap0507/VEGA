/**
 * Local identity bootstrap: turns a freshly started Zitadel into one this repo can sign in to.
 *
 *   pnpm stack:up && pnpm idp:bootstrap
 *
 * Replaces the console clicking in module1-implementation-plan.md Step 3, because "cold clone
 * to running stack in under 5 minutes" (module1.md §13) does not survive a manual step.
 *
 * What it creates (idempotent by name — re-running reuses what exists):
 *   · a project and a WEB OIDC application using private_key_jwt + PKCE
 *   · an application key        → infra/docker/secrets/zitadel-app-key.json
 *   · a service account with IAM_OWNER, used to provision tenant orgs and agent machine users
 *   · a service-account key     → infra/docker/secrets/zitadel-sa.json
 *
 * Authenticates with the PAT that docker-compose has Zitadel write for its first-instance
 * machine user. That PAT is a bootstrap credential only; nothing at runtime uses it.
 *
 * Deployed environments provision the same objects with OpenTofu (infra/tofu/identity).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../packages/shared/src/brand.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS = join(ROOT, 'infra', 'docker', 'secrets');

const issuer = process.env['ZITADEL_ISSUER'] ?? 'http://localhost:8080';
const patPath = process.env['ZITADEL_BOOTSTRAP_PAT_PATH'] ?? join(SECRETS, 'zitadel-bootstrap.pat');
const gatewayUrl = process.env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001';
const webUrl = process.env['WEB_PUBLIC_URL'] ?? 'http://localhost:3000';

const PROJECT_NAME = BRAND.name;
const APP_NAME = `${BRAND.slug}-web`;
const SA_USERNAME = `${BRAND.slug}-provisioner`;

async function main(): Promise<void> {
  if (!existsSync(patPath)) {
    throw new Error(
      `bootstrap PAT not found at ${patPath}. Is the stack up? docker-compose has Zitadel write ` +
        `it on first start (ZITADEL_FIRSTINSTANCE_PATPATH).`,
    );
  }
  const pat = readFileSync(patPath, 'utf8').trim();

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, issuer), {
      method,
      headers: {
        authorization: `Bearer ${pat}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ------------------------------------------------------------------ project
  const projects = await call<{ result?: Array<{ id: string; name: string }> }>(
    'POST',
    '/management/v1/projects/_search',
    { queries: [{ nameQuery: { name: PROJECT_NAME, method: 'TEXT_QUERY_METHOD_EQUALS' } }] },
  );
  let projectId = projects.result?.[0]?.id;
  if (!projectId) {
    projectId = (await call<{ id: string }>('POST', '/management/v1/projects', { name: PROJECT_NAME })).id;
    console.log(`created project ${PROJECT_NAME} (${projectId})`);
  }

  // ---------------------------------------------------------------- web app
  const apps = await call<{ result?: Array<{ id: string; name: string }> }>(
    'POST',
    `/management/v1/projects/${projectId}/apps/_search`,
    {},
  );
  let appId = apps.result?.find((a) => a.name === APP_NAME)?.id;
  if (!appId) {
    const created = await call<{ appId: string; clientId: string }>(
      'POST',
      `/management/v1/projects/${projectId}/apps/oidc`,
      {
        name: APP_NAME,
        redirectUris: [`${gatewayUrl}/v1/oauth/callback`],
        postLogoutRedirectUris: [`${webUrl}/`],
        responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
        grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
        appType: 'OIDC_APP_TYPE_WEB',
        // No shared secret exists to leak (TECHSTACK 22.2).
        authMethodType: 'OIDC_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT',
        // devMode permits http:// redirect URIs. Local only.
        devMode: issuer.startsWith('http://'),
        accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
        // Put email/name in the id_token so sign-in needs no userinfo round-trip.
        idTokenUserinfoAssertion: true,
      },
    );
    appId = created.appId;
    console.log(`created OIDC app ${APP_NAME} (client ${created.clientId})`);
  }

  mkdirSync(SECRETS, { recursive: true });
  const appKeyPath = join(SECRETS, 'zitadel-app-key.json');
  if (!existsSync(appKeyPath)) {
    const key = await call<{ keyDetails: string }>(
      'POST',
      `/management/v1/projects/${projectId}/apps/${appId}/keys`,
      { type: 'KEY_TYPE_JSON', expirationDate: '2030-01-01T00:00:00Z' },
    );
    writeFileSync(appKeyPath, Buffer.from(key.keyDetails, 'base64'), { mode: 0o600 });
    console.log(`wrote ${appKeyPath}`);
  }

  // --------------------------------------------------------- service account
  const users = await call<{ result?: Array<{ id: string; userName: string }> }>(
    'POST',
    '/management/v1/users/_search',
    { queries: [{ userNameQuery: { userName: SA_USERNAME, method: 'TEXT_QUERY_METHOD_EQUALS' } }] },
  );
  let saId = users.result?.[0]?.id;
  if (!saId) {
    saId = (
      await call<{ userId: string }>('POST', '/management/v1/users/machine', {
        userName: SA_USERNAME,
        name: `${BRAND.name} provisioner`,
        description: 'Creates tenant organizations and agent machine users.',
        accessTokenType: 'ACCESS_TOKEN_TYPE_JWT',
      })
    ).userId;
    // Instance-level owner: a tenant org does not exist until this account creates it.
    await call('POST', '/admin/v1/members', { userId: saId, roles: ['IAM_OWNER'] });
    console.log(`created service account ${SA_USERNAME} (${saId})`);
  }

  const saKeyPath = join(SECRETS, 'zitadel-sa.json');
  if (!existsSync(saKeyPath)) {
    const key = await call<{ keyDetails: string }>('POST', `/management/v1/users/${saId}/keys`, {
      type: 'KEY_TYPE_JSON',
      expirationDate: '2030-01-01T00:00:00Z',
    });
    writeFileSync(saKeyPath, Buffer.from(key.keyDetails, 'base64'), { mode: 0o600 });
    console.log(`wrote ${saKeyPath}`);
  }

  console.log('\nidentity bootstrap complete. The key files are gitignored; never commit them.');
}

main().catch((error: unknown) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
