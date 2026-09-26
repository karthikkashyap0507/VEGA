import type { OAuthClientConfig } from '@vega/connector-sdk';

/**
 * OAuth clients from the environment (.env.example, "MODULE 2 — CONNECTORS"). A provider
 * with no client id is simply unavailable: its connectors show as such in the gallery and
 * creating one answers 412, instead of failing at the provider's consent screen.
 *
 * The redirect URI is per PROVIDER (/v1/oauth/<provider>/callback): one registration per
 * OAuth app, whichever connector kinds share it.
 */
export function oauthClientsFromEnv(
  env: NodeJS.ProcessEnv,
  publicUrl: string,
  /** Development sandbox provider (CONNECTOR_SANDBOX_URL): token exchange goes there too. */
  fetchImpl?: typeof fetch,
): Partial<Record<'google' | 'microsoft' | 'slack', OAuthClientConfig>> {
  const base = publicUrl.replace(/\/$/, '');
  const clients: Partial<Record<'google' | 'microsoft' | 'slack', OAuthClientConfig>> = {};
  const redirect = (p: string) => `${base}/v1/oauth/${p}/callback`;
  if (env['GOOGLE_CLIENT_ID'] && env['GOOGLE_CLIENT_SECRET']) {
    clients.google = { clientId: env['GOOGLE_CLIENT_ID'], clientSecret: env['GOOGLE_CLIENT_SECRET'], redirectUri: redirect('google') };
  }
  if (env['MICROSOFT_CLIENT_ID'] && env['MICROSOFT_CLIENT_SECRET']) {
    const tenant = env['MICROSOFT_TENANT_ID'] || 'common';
    clients.microsoft = {
      clientId: env['MICROSOFT_CLIENT_ID'],
      clientSecret: env['MICROSOFT_CLIENT_SECRET'],
      redirectUri: redirect('microsoft'),
      endpoints: {
        authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      },
    };
  }
  if (env['SLACK_CLIENT_ID'] && env['SLACK_CLIENT_SECRET']) {
    clients.slack = { clientId: env['SLACK_CLIENT_ID'], clientSecret: env['SLACK_CLIENT_SECRET'], redirectUri: redirect('slack') };
  }
  if (fetchImpl) for (const c of Object.values(clients)) c.fetchImpl = fetchImpl;
  return clients;
}
