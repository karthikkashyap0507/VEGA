import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JSONWebKeySet } from 'jose';
import { OidcClient, type LoadedKey } from '@vega/idp';

/**
 * A fake OIDC issuer with REAL keys and REAL PKCE verification.
 *
 * Not a mock of our code: the gateway's OidcClient talks to it over its fetch seam exactly as
 * it would talk to Zitadel. The token endpoint refuses a code_verifier that does not hash to
 * the code_challenge, id_tokens are genuinely RS256-signed, and each code is single-use.
 */

export const ISSUER = 'https://idp.test';
export const REDIRECT_URI = 'http://gateway.test/v1/oauth/callback';

interface PendingCode {
  subject: string;
  nonce: string;
  challenge: string;
  email: string;
}

export class FakeIdp {
  private readonly codes = new Map<string, PendingCode>();
  private readonly refreshTokens = new Map<string, string>();
  refreshRefused = new Set<string>();
  private privateKey!: CryptoKey;
  jwks!: JSONWebKeySet;
  client!: OidcClient;

  static async create(): Promise<FakeIdp> {
    const idp = new FakeIdp();
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    idp.privateKey = privateKey;
    idp.jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'idp-1', alg: 'RS256' }] };
    const clientKey = await generateKeyPair('RS256', { extractable: true });
    const key: LoadedKey = { keyId: 'k1', clientId: 'gateway-client', privateKey: clientKey.privateKey, type: 'application' };
    idp.client = new OidcClient({ issuer: ISSUER, redirectUri: REDIRECT_URI, fetchImpl: idp.fetch, jwks: idp.jwks }, key);
    return idp;
  }

  /**
   * Plays the user's part at the IdP: given the authorization URL the gateway redirected to,
   * "authenticates" `subject` and returns the code the IdP would send back.
   */
  authorize(authorizationUrl: string, subject: string, email = `${subject}@example.com`): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const nonce = url.searchParams.get('nonce');
    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');
    if (!nonce || !state || !challenge || url.searchParams.get('code_challenge_method') !== 'S256') {
      throw new Error('authorization request is missing PKCE/nonce/state');
    }
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, { subject, nonce, challenge, email });
    return { code, state };
  }

  private async idToken(subject: string, nonce: string, email: string) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ nonce, email, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'idp-1' })
      .setIssuer(ISSUER)
      .setSubject(subject)
      .setAudience('gateway-client')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(this.privateKey);
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (url.endsWith('/.well-known/openid-configuration')) {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
        token_endpoint: `${ISSUER}/oauth/v2/token`,
        jwks_uri: `${ISSUER}/oauth/v2/keys`,
        end_session_endpoint: `${ISSUER}/oidc/v1/end_session`,
      });
    }
    if (url === `${ISSUER}/oauth/v2/token`) {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
        return json(401, { error: 'invalid_client' });
      }
      if (form.get('grant_type') === 'authorization_code') {
        const pending = this.codes.get(form.get('code') ?? '');
        if (!pending) return json(400, { error: 'invalid_grant' });
        this.codes.delete(form.get('code') ?? ''); // single use
        const verifier = form.get('code_verifier') ?? '';
        const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
        if (computed !== pending.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
        const refresh = randomBytes(12).toString('hex');
        this.refreshTokens.set(refresh, pending.subject);
        return json(200, {
          access_token: 'at-' + randomBytes(6).toString('hex'),
          id_token: await this.idToken(pending.subject, pending.nonce, pending.email),
          refresh_token: refresh,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (form.get('grant_type') === 'refresh_token') {
        const subject = this.refreshTokens.get(form.get('refresh_token') ?? '');
        if (!subject || this.refreshRefused.has(subject)) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'at2', id_token: '', expires_in: 3600, token_type: 'Bearer' });
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}
