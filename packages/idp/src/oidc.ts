import { createHash, randomBytes } from 'node:crypto';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  type JWTPayload,
  type JSONWebKeySet,
} from 'jose';
import type { LoadedKey } from './keyfile.js';

/**
 * OIDC authorization-code client with PKCE and private_key_jwt client authentication.
 *
 * Written against the protocol rather than pulled from a framework helper, because this is the
 * path every identity in the system comes through. Each step below is one a reviewer can check
 * against RFC 7636 (PKCE), RFC 7523 (JWT client auth) and OIDC Core.
 *
 * Two layers of client protection are in play at once:
 *   · PKCE binds the authorization code to this request's code_verifier
 *   · private_key_jwt proves the request comes from a client holding the private key
 * Either alone is defensible; together, a stolen code is useless without both.
 */

export interface OidcConfig {
  issuer: string;
  redirectUri: string;
  scopes?: string[];
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so JWKS verification needs no network. */
  jwks?: JSONWebKeySet;
}

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface TokenSet {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
}

export interface VerifiedIdentity {
  /** OIDC `sub` — stable per user per issuer. The only identifier we key users on. */
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  claims: JWTPayload;
}

export class OidcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OidcError';
  }
}

const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

/** RFC 7636 §4.1 — 43-128 chars from the unreserved set. 32 random bytes base64url is 43. */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** RFC 7636 §4.2 — S256 is the only method we offer; `plain` is not acceptable. */
export function codeChallengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export class OidcClient {
  private discovery?: DiscoveryDocument;
  private jwksResolver?: ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;

  constructor(
    private readonly config: OidcConfig,
    private readonly key: LoadedKey,
  ) {}

  get clientId(): string {
    return this.key.clientId;
  }

  private get fetch(): typeof fetch {
    return this.config.fetchImpl ?? globalThis.fetch;
  }

  async discover(): Promise<DiscoveryDocument> {
    if (this.discovery) return this.discovery;

    const url = new URL('/.well-known/openid-configuration', this.config.issuer).toString();
    const res = await this.fetch(url);
    if (!res.ok) {
      throw new OidcError(`discovery failed: ${res.status} ${url}`, 'discovery_failed');
    }
    const doc = (await res.json()) as DiscoveryDocument;

    // The issuer in the document must match what we asked for, or we are talking to
    // something that merely answers on that address (OIDC Discovery §4.3).
    if (doc.issuer !== this.config.issuer) {
      throw new OidcError(
        `issuer mismatch: configured ${this.config.issuer}, document says ${doc.issuer}`,
        'issuer_mismatch',
      );
    }
    this.discovery = doc;
    return doc;
  }

  /** Step 1: where to send the browser. Caller stores state/verifier/nonce for the callback. */
  async createAuthorizationRequest(options: { prompt?: string; loginHint?: string } = {}): Promise<AuthorizationRequest> {
    const doc = await this.discover();
    const state = generateState();
    const nonce = generateState();
    const codeVerifier = generateCodeVerifier();

    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', (this.config.scopes ?? DEFAULT_SCOPES).join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallengeFor(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (options.prompt) url.searchParams.set('prompt', options.prompt);
    if (options.loginHint) url.searchParams.set('login_hint', options.loginHint);

    return { url: url.toString(), state, codeVerifier, nonce };
  }

  /**
   * RFC 7523 client assertion.
   *
   * `aud` is the issuer, not the token endpoint. Zitadel validates against the issuer, and
   * getting this wrong produces `invalid_client` with no further detail — one of the more
   * expensive half-hours available in OIDC integration.
   *
   * `jti` plus a 60-second lifetime keeps the assertion single-use in practice.
   */
  private async clientAssertion(): Promise<string> {
    const doc = await this.discover();
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: this.key.keyId })
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setAudience(doc.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(base64url(randomBytes(16)))
      .sign(this.key.privateKey);
  }

  private async postToken(params: Record<string, string>): Promise<TokenSet> {
    const doc = await this.discover();
    const body = new URLSearchParams({
      ...params,
      client_id: this.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await this.clientAssertion(),
    });

    const res = await this.fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });

    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = String(payload['error'] ?? res.status);
      const detail = String(payload['error_description'] ?? '');
      throw new OidcError(`token request failed: ${code} ${detail}`.trim(), code);
    }

    return {
      accessToken: String(payload['access_token']),
      idToken: String(payload['id_token']),
      ...(payload['refresh_token'] ? { refreshToken: String(payload['refresh_token']) } : {}),
      expiresIn: Number(payload['expires_in'] ?? 0),
      tokenType: String(payload['token_type'] ?? 'Bearer'),
    };
  }

  /** Step 2: redeem the code. The verifier proves this is the same client that started the flow. */
  async exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
    return this.postToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.postToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async getJwks() {
    if (this.jwksResolver) return this.jwksResolver;
    if (this.config.jwks) {
      this.jwksResolver = createLocalJWKSet(this.config.jwks);
    } else {
      const doc = await this.discover();
      this.jwksResolver = createRemoteJWKSet(new URL(doc.jwks_uri));
    }
    return this.jwksResolver;
  }

  /**
   * Verifies signature, issuer, audience and nonce (OIDC Core §3.1.3.7).
   *
   * The nonce check is what stops a token minted for a different login attempt from being
   * replayed into this session. It is easy to omit and nothing visibly breaks when you do.
   */
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<VerifiedIdentity> {
    const jwks = await this.getJwks();
    const doc = await this.discover();

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, jwks, {
        issuer: doc.issuer,
        audience: this.clientId,
        clockTolerance: 5,
      }));
    } catch (cause) {
      throw new OidcError('id_token verification failed', 'invalid_id_token', { cause });
    }

    if (payload['nonce'] !== expectedNonce) {
      throw new OidcError('id_token nonce does not match this login attempt', 'nonce_mismatch');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new OidcError('id_token has no subject', 'invalid_id_token');
    }

    return {
      subject: payload.sub,
      ...(typeof payload['email'] === 'string' ? { email: payload['email'] } : {}),
      ...(typeof payload['email_verified'] === 'boolean'
        ? { emailVerified: payload['email_verified'] }
        : {}),
      ...(typeof payload['name'] === 'string' ? { name: payload['name'] } : {}),
      claims: payload,
    };
  }

  async endSessionUrl(idTokenHint: string, postLogoutRedirectUri: string): Promise<string | undefined> {
    const doc = await this.discover();
    if (!doc.end_session_endpoint) return undefined;
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set('id_token_hint', idTokenHint);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    return url.toString();
  }
}
