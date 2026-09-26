import { randomBytes } from 'node:crypto';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
} from 'jose';

/**
 * Gateway → control-plane principal assertion.
 *
 * CONTRIBUTING.md: "Tenant context comes only from verified token claims. Never a header,
 * query, or body." The gateway is where a session cookie becomes a verified (tenant, user);
 * this assertion is how that fact crosses the plane boundary without becoming a header the
 * control plane has to take on trust.
 *
 * Asymmetric on purpose: the control plane holds only the public key, so it can verify an
 * assertion but never mint one. A compromised control service cannot impersonate a user to
 * anything else that trusts the gateway.
 *
 * Lifetime is 60 seconds — one request, plus clock skew. Nothing caches or reuses these.
 */

const ALG = 'ES256';
const TYP = 'principal+jwt';
export const PRINCIPAL_ASSERTION_TTL_SECONDS = 60;

export interface PrincipalClaims {
  tenantId: string;
  userId: string;
  sessionId?: string;
  /** W3C trace id, so control-plane logs correlate without re-deriving it. */
  traceId?: string;
  /**
   * A system principal acts for no user and no tenant. `signup`: provisioning a tenant
   * necessarily happens before either does. `webhook` (Module 4): an inbound agent trigger,
   * authenticated by the agent's own webhook secret, not by a session. The control plane admits
   * system principals to exactly the procedures that declare them, and nothing else.
   */
  system?: 'signup' | 'webhook';
}

/** Sentinel ids for system principals. Never valid uuids, so withTenant refuses them. */
export const SYSTEM_TENANT = 'system';

export class PrincipalAssertionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PrincipalAssertionError';
  }
}

export class PrincipalAssertionIssuer {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicJwk: JWK,
    private readonly keyId: string,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}

  static async ephemeral(issuer: string, audience: string): Promise<PrincipalAssertionIssuer> {
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    return new PrincipalAssertionIssuer(
      privateKey,
      await exportJWK(publicKey),
      `pa-${randomBytes(6).toString('hex')}`,
      issuer,
      audience,
    );
  }

  static async fromPem(pem: string, keyId: string, issuer: string, audience: string) {
    const privateKey = await importPKCS8(pem, ALG, { extractable: true });
    const { d: _d, ...publicJwk } = await exportJWK(privateKey);
    return new PrincipalAssertionIssuer(privateKey, publicJwk, keyId, issuer, audience);
  }

  get jwks(): JSONWebKeySet {
    return { keys: [{ ...this.publicJwk, kid: this.keyId, alg: ALG, use: 'sig' }] };
  }

  async mint(claims: PrincipalClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      tid: claims.tenantId,
      ...(claims.sessionId ? { sid: claims.sessionId } : {}),
      ...(claims.traceId ? { trc: claims.traceId } : {}),
      ...(claims.system ? { sys: claims.system } : {}),
    })
      .setProtectedHeader({ alg: ALG, kid: this.keyId, typ: TYP })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(claims.userId)
      .setIssuedAt(now)
      .setExpirationTime(now + PRINCIPAL_ASSERTION_TTL_SECONDS)
      .setJti(randomBytes(12).toString('base64url'))
      .sign(this.privateKey);
  }
}

export class PrincipalAssertionVerifier {
  private readonly keys: ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet>;

  constructor(
    jwks: JSONWebKeySet | URL,
    private readonly issuer: string,
    private readonly audience: string,
  ) {
    // A URL means "the gateway's published JWKS": the control plane then holds no key
    // material at all, and a rotated gateway key is picked up on the first unknown `kid`.
    this.keys = jwks instanceof URL ? createRemoteJWKSet(jwks, { cooldownDuration: 5_000 }) : createLocalJWKSet(jwks);
  }

  async verify(token: string): Promise<PrincipalClaims> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: [ALG],
        typ: TYP,
        clockTolerance: 5,
        maxTokenAge: PRINCIPAL_ASSERTION_TTL_SECONDS + 5,
      }));
    } catch (cause) {
      throw new PrincipalAssertionError('principal assertion failed verification', { cause });
    }
    if (typeof payload['tid'] !== 'string' || typeof payload.sub !== 'string') {
      throw new PrincipalAssertionError('principal assertion is missing tenant or subject');
    }
    return {
      tenantId: payload['tid'],
      userId: payload.sub,
      ...(typeof payload['sid'] === 'string' ? { sessionId: payload['sid'] } : {}),
      ...(typeof payload['trc'] === 'string' ? { traceId: payload['trc'] } : {}),
      ...(payload['sys'] === 'signup' ? { system: 'signup' as const } : payload['sys'] === 'webhook' ? { system: 'webhook' as const } : {}),
    };
  }
}
