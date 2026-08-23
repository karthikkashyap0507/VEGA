import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  codeChallengeFor,
  generateCodeVerifier,
  OidcClient,
  OidcError,
} from '../src/oidc.js';
import type { LoadedKey } from '../src/keyfile.js';

/**
 * These run against a fake issuer built from REAL RSA keys, not mocks of our own code.
 * Signatures are genuinely produced and genuinely verified, so a mistake in the assertion or
 * in id_token validation shows up here rather than as `invalid_client` against a live IdP.
 */

const ISSUER = 'https://idp.test';
const CLIENT_ID = 'client-123';
const KEY_ID = 'key-abc';
const REDIRECT = 'http://localhost:3001/v1/oauth/callback';

let clientKey: LoadedKey;
let idpPrivate: CryptoKey;
let idpJwks: JSONWebKeySet;
let clientPublicJwk: JsonWebKey;

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
  token_endpoint: `${ISSUER}/oauth/v2/token`,
  jwks_uri: `${ISSUER}/oauth/v2/keys`,
  end_session_endpoint: `${ISSUER}/oidc/v1/end_session`,
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['private_key_jwt'],
};

beforeAll(async () => {
  const client = await generateKeyPair('RS256', { extractable: true });
  clientKey = {
    keyId: KEY_ID,
    clientId: CLIENT_ID,
    privateKey: client.privateKey,
    type: 'application',
  };
  clientPublicJwk = await exportJWK(client.publicKey);

  const idp = await generateKeyPair('RS256', { extractable: true });
  idpPrivate = idp.privateKey;
  idpJwks = { keys: [{ ...(await exportJWK(idp.publicKey)), kid: 'idp-key', alg: 'RS256' }] };
});

/** Mints an id_token the way the IdP would. */
async function mintIdToken(overrides: Record<string, unknown> = {}, audience = CLIENT_ID) {
  const now = Math.floor(Date.now() / 1000);
  const base: Record<string, unknown> = {
    nonce: 'the-nonce',
    email: 'owner@acme.example',
    email_verified: true,
    name: 'Owner A',
    ...overrides,
  };
  return new SignJWT(base)
    .setProtectedHeader({ alg: 'RS256', kid: 'idp-key' })
    .setIssuer(ISSUER)
    .setSubject(String(overrides['sub'] ?? 'user-sub-1'))
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(idpPrivate);
}

interface FakeIdp {
  fetchImpl: typeof fetch;
  lastTokenForm: URLSearchParams | undefined;
}

function fakeIdp(options: { tokenResponse?: () => Promise<unknown>; tokenStatus?: number } = {}): FakeIdp {
  const state: FakeIdp = { fetchImpl: undefined as never, lastTokenForm: undefined };

  state.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify(DISCOVERY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url === DISCOVERY.token_endpoint) {
      state.lastTokenForm = new URLSearchParams(String(init?.body ?? ''));
      const status = options.tokenStatus ?? 200;
      const payload = options.tokenResponse
        ? await options.tokenResponse()
        : {
            access_token: 'at',
            id_token: await mintIdToken(),
            refresh_token: 'rt',
            expires_in: 3600,
            token_type: 'Bearer',
          };
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return state;
}

function makeClient(idp: FakeIdp, issuer = ISSUER) {
  return new OidcClient(
    { issuer, redirectUri: REDIRECT, fetchImpl: idp.fetchImpl, jwks: idpJwks },
    clientKey,
  );
}

describe('PKCE', () => {
  it('produces a verifier in the RFC 7636 length range', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('derives the S256 challenge correctly', () => {
    // Against a hand-computed SHA-256, so a change in encoding is caught.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(codeChallengeFor(verifier)).toBe(expected);
  });

  it('generates a distinct verifier each time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCodeVerifier()));
    expect(seen.size).toBe(200);
  });
});

describe('authorization request', () => {
  it('carries PKCE, state and nonce', async () => {
    const client = makeClient(fakeIdp());
    const req = await client.createAuthorizationRequest();
    const url = new URL(req.url);

    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(codeChallengeFor(req.codeVerifier));
    expect(url.searchParams.get('state')).toBe(req.state);
    expect(url.searchParams.get('nonce')).toBe(req.nonce);
  });

  it('never puts the verifier on the wire', async () => {
    const client = makeClient(fakeIdp());
    const req = await client.createAuthorizationRequest();
    // The whole point of PKCE: the verifier stays with the client until redemption.
    expect(req.url).not.toContain(req.codeVerifier);
  });

  it('requests offline_access so refresh rotation is possible', async () => {
    const client = makeClient(fakeIdp());
    const req = await client.createAuthorizationRequest();
    expect(new URL(req.url).searchParams.get('scope')).toContain('offline_access');
  });
});

describe('discovery', () => {
  it('rejects a document whose issuer does not match', async () => {
    const client = makeClient(fakeIdp(), 'https://evil.test');
    // The fake responds on any host; only the issuer claim distinguishes them.
    await expect(client.discover()).rejects.toThrow(OidcError);
  });
});

describe('private_key_jwt client assertion', () => {
  it('sends a correctly shaped assertion, verifiable with the client public key', async () => {
    const idp = fakeIdp();
    const client = makeClient(idp);
    await client.exchangeCode('the-code', 'the-verifier');

    const form = idp.lastTokenForm!;
    expect(form.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );

    const assertion = form.get('client_assertion')!;
    const { importJWK, jwtVerify } = await import('jose');
    const pub = await importJWK({ ...clientPublicJwk, alg: 'RS256' }, 'RS256');

    const { payload, protectedHeader } = await jwtVerify(assertion, pub, {
      issuer: CLIENT_ID,
      // aud is the ISSUER, not the token endpoint. Getting this wrong yields a bare
      // `invalid_client` from Zitadel with no further detail.
      audience: ISSUER,
    });

    expect(protectedHeader.alg).toBe('RS256');
    expect(protectedHeader.kid).toBe(KEY_ID);
    expect(payload.sub).toBe(CLIENT_ID);
    expect(payload.jti).toBeTruthy();
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
  });

  it('uses a fresh jti per request', async () => {
    const idp = fakeIdp();
    const client = makeClient(idp);
    const { decodeJwt } = await import('jose');

    await client.exchangeCode('c1', 'v1');
    const first = decodeJwt(idp.lastTokenForm!.get('client_assertion')!).jti;
    await client.exchangeCode('c2', 'v2');
    const second = decodeJwt(idp.lastTokenForm!.get('client_assertion')!).jti;

    expect(first).not.toBe(second);
  });

  it('never sends a client_secret', async () => {
    const idp = fakeIdp();
    await makeClient(idp).exchangeCode('c', 'v');
    expect(idp.lastTokenForm!.get('client_secret')).toBeNull();
  });
});

describe('code exchange', () => {
  it('sends the verifier and redirect_uri', async () => {
    const idp = fakeIdp();
    await makeClient(idp).exchangeCode('the-code', 'the-verifier');
    const form = idp.lastTokenForm!;
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('code_verifier')).toBe('the-verifier');
    expect(form.get('redirect_uri')).toBe(REDIRECT);
  });

  it('surfaces the IdP error code rather than a generic failure', async () => {
    const idp = fakeIdp({
      tokenStatus: 400,
      tokenResponse: async () => ({
        error: 'invalid_client',
        error_description: 'assertion audience mismatch',
      }),
    });
    await expect(makeClient(idp).exchangeCode('c', 'v')).rejects.toThrow(/invalid_client/);
  });

  it('refreshes with the refresh_token grant', async () => {
    const idp = fakeIdp();
    await makeClient(idp).refresh('the-refresh-token');
    expect(idp.lastTokenForm!.get('grant_type')).toBe('refresh_token');
    expect(idp.lastTokenForm!.get('refresh_token')).toBe('the-refresh-token');
  });
});

describe('id_token verification', () => {
  it('accepts a well-formed token and returns the subject', async () => {
    const client = makeClient(fakeIdp());
    const identity = await client.verifyIdToken(await mintIdToken(), 'the-nonce');
    expect(identity.subject).toBe('user-sub-1');
    expect(identity.email).toBe('owner@acme.example');
    expect(identity.emailVerified).toBe(true);
  });

  it('rejects a mismatched nonce', async () => {
    // Without this check, a token minted for a different login attempt can be replayed
    // into this session, and nothing visibly breaks.
    const client = makeClient(fakeIdp());
    const token = await mintIdToken({ nonce: 'someone-elses-nonce' });
    await expect(client.verifyIdToken(token, 'the-nonce')).rejects.toThrow(/nonce/);
  });

  it('rejects a token issued for a different audience', async () => {
    const client = makeClient(fakeIdp());
    const token = await mintIdToken({}, 'a-different-client');
    await expect(client.verifyIdToken(token, 'the-nonce')).rejects.toThrow(OidcError);
  });

  it('rejects a token signed by an unknown key', async () => {
    const { generateKeyPair: gen } = await import('jose');
    const attacker = await gen('RS256', { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ nonce: 'the-nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'idp-key' })
      .setIssuer(ISSUER)
      .setSubject('attacker')
      .setAudience(CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(attacker.privateKey);

    await expect(makeClient(fakeIdp()).verifyIdToken(forged, 'the-nonce')).rejects.toThrow(
      OidcError,
    );
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const expired = await new SignJWT({ nonce: 'the-nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'idp-key' })
      .setIssuer(ISSUER)
      .setSubject('user-sub-1')
      .setAudience(CLIENT_ID)
      .setIssuedAt(past)
      .setExpirationTime(past + 60)
      .sign(idpPrivate);

    await expect(makeClient(fakeIdp()).verifyIdToken(expired, 'the-nonce')).rejects.toThrow(
      OidcError,
    );
  });

  it('rejects a token from a different issuer', async () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongIssuer = await new SignJWT({ nonce: 'the-nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'idp-key' })
      .setIssuer('https://evil.test')
      .setSubject('user-sub-1')
      .setAudience(CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(idpPrivate);

    await expect(makeClient(fakeIdp()).verifyIdToken(wrongIssuer, 'the-nonce')).rejects.toThrow(
      OidcError,
    );
  });
});
