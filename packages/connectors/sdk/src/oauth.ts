import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AnyTool } from './connector.js';
import { redact } from './http.js';

/**
 * OAuth broker primitives (module2.md §5.5): Authorization Code + PKCE, scope minimization,
 * refresh and revocation, for each provider a connector can authenticate against.
 *
 * SCOPE MINIMIZATION: the requested scope set is the union of the scopes declared by the
 * tools actually ENABLED on a connector — never a provider's convenient superset. The full
 * Gmail scope (https://mail.google.com/) is refused outright.
 */

export interface OAuthProviderProfile {
  id: 'google' | 'microsoft' | 'slack';
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  /** Scopes added to every request that are not capabilities (e.g. offline access). */
  baseScopes: string[];
  /** Extra authorize params the provider needs for refresh tokens / re-consent. */
  authorizeParams: Record<string, string>;
  scopeSeparator: string;
}

export const PROVIDERS: Record<OAuthProviderProfile['id'], OAuthProviderProfile> = {
  google: {
    id: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    baseScopes: ['openid', 'email'],
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    scopeSeparator: ' ',
  },
  microsoft: {
    id: 'microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    baseScopes: ['openid', 'email', 'offline_access'],
    authorizeParams: { prompt: 'consent' },
    scopeSeparator: ' ',
  },
  slack: {
    id: 'slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revokeUrl: 'https://slack.com/api/auth.revoke',
    baseScopes: [],
    authorizeParams: {},
    scopeSeparator: ',',
  },
};

/**
 * Scopes that are never requested, whatever a tool declares (module2.md §10.2). The full
 * mailbox scope grants permanent deletion and settings changes no tool here needs.
 */
export const FORBIDDEN_SCOPES = new Set(['https://mail.google.com/']);

export function minimalScopes(tools: AnyTool[], enabledToolIds: string[]): string[] {
  const enabled = new Set(enabledToolIds);
  const scopes = new Set<string>();
  for (const t of tools) {
    if (!enabled.has(t.toolId)) continue;
    for (const s of t.scopes) {
      if (FORBIDDEN_SCOPES.has(s)) throw new Error(`tool ${t.toolId} requests forbidden scope ${s}`);
      scopes.add(s);
    }
  }
  return [...scopes].sort();
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') };
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Override endpoints (sandbox providers, tests). */
  endpoints?: Partial<Pick<OAuthProviderProfile, 'authorizeUrl' | 'tokenUrl' | 'revokeUrl'>>;
  fetchImpl?: typeof fetch;
}

export function authorizeUrl(
  provider: OAuthProviderProfile,
  client: OAuthClientConfig,
  input: { scopes: string[]; state: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(client.endpoints?.authorizeUrl ?? provider.authorizeUrl);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', [...new Set([...provider.baseScopes, ...input.scopes])].join(provider.scopeSeparator));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(provider.authorizeParams)) url.searchParams.set(k, v);
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
}

export const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.coerce.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export interface ConnectorTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  scopesGranted: string[];
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

async function tokenRequest(
  provider: OAuthProviderProfile,
  client: OAuthClientConfig,
  params: Record<string, string>,
  requested: string[],
): Promise<ConnectorTokens> {
  const fetchImpl = client.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(client.endpoints?.tokenUrl ?? provider.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...params, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Slack answers 200 with { ok: false } on failure.
  if (!res.ok || body['ok'] === false || typeof body['access_token'] !== 'string') {
    const code = String(body['error'] ?? res.status);
    throw new OAuthError(`token endpoint refused: ${redact(code)}`, code);
  }
  const t = TokenResponse.parse(body);
  return {
    accessToken: t.access_token,
    ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
    ...(t.expires_in ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}),
    scopesGranted: t.scope ? t.scope.split(/[ ,]+/).filter(Boolean) : requested,
  };
}

export function exchangeCode(
  provider: OAuthProviderProfile,
  client: OAuthClientConfig,
  input: { code: string; codeVerifier: string; requestedScopes: string[] },
): Promise<ConnectorTokens> {
  return tokenRequest(
    provider,
    client,
    { grant_type: 'authorization_code', code: input.code, redirect_uri: client.redirectUri, code_verifier: input.codeVerifier },
    input.requestedScopes,
  );
}

export async function refreshTokens(
  provider: OAuthProviderProfile,
  client: OAuthClientConfig,
  current: ConnectorTokens,
): Promise<ConnectorTokens> {
  if (!current.refreshToken) throw new OAuthError('no refresh token', 'invalid_grant');
  const next = await tokenRequest(
    provider,
    client,
    { grant_type: 'refresh_token', refresh_token: current.refreshToken },
    current.scopesGranted,
  );
  // Providers may omit the refresh token on refresh; keep the one we have.
  return { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
}

/** Provider-side revocation. The caller deletes the vaulted secret AFTER this (§5.5). */
export async function revokeTokens(
  provider: OAuthProviderProfile,
  client: OAuthClientConfig,
  tokens: ConnectorTokens,
): Promise<void> {
  const url = client.endpoints?.revokeUrl ?? provider.revokeUrl;
  if (!url) return;
  const fetchImpl = client.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }).toString(),
  });
  // 400 "invalid_token" means it is already revoked: the goal state holds.
  if (!res.ok && res.status !== 400) throw new OAuthError(`revocation failed: ${res.status}`, 'revoke_failed');
}
