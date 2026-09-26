import { randomBytes } from 'node:crypto';
import {
  createLocalJWKSet,
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
 * Per-run agent credentials (module1.md §5.5, §10).
 *
 *   "Agents are machine users. Each agent gets a Zitadel machine identity; runs receive a
 *    short-lived (≤15 min), scope-limited token minted per run. There is no long-lived agent
 *    credential anywhere in the system."
 *
 * The agent's standing identity is its Zitadel machine user. What a RUN carries is this token:
 * minted by the control plane when the run starts, bound to one run, one agent, one principal
 * and an explicit scope list, and verified offline by the execution plane against a JWKS.
 * Nothing about it can be refreshed — a run that outlives its token asks for a new one, and
 * that request is a policy decision point.
 *
 * Claims (all required):
 *   sub   agt:<agent uuid>             the acting principal
 *   obo   <user uuid>                  on_behalf_of — recorded on every downstream action
 *   tid   <tenant uuid>                tenant, so the execution plane never infers it
 *   run   <run id>                     binds the token to exactly one run
 *   mid   <zitadel machine user id>    the standing identity this credential derives from
 *   scope space-separated              least privilege; checked per tool call from M2 on
 */

export const RUN_TOKEN_MAX_TTL_SECONDS = 15 * 60;
const ALG = 'ES256';

export interface RunTokenClaims {
  agentId: string;
  onBehalfOfUserId: string;
  tenantId: string;
  runId: string;
  machineId: string;
  scopes: string[];
}

export interface VerifiedRunToken extends RunTokenClaims {
  jti: string;
  expiresAt: Date;
}

export class RunTokenError extends Error {
  constructor(
    message: string,
    readonly code: 'ttl_exceeded' | 'invalid' | 'expired' | 'scope_missing' | 'claims_missing',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RunTokenError';
  }
}

export interface RunTokenIssuerOptions {
  issuer: string;
  audience: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
  keyId: string;
}

export class RunTokenIssuer {
  constructor(private readonly options: RunTokenIssuerOptions) {}

  /** Generates an ephemeral signing key. Development and tests; deployed envs load from KMS. */
  static async ephemeral(issuer: string, audience: string): Promise<RunTokenIssuer> {
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    const keyId = `run-${randomBytes(6).toString('hex')}`;
    return new RunTokenIssuer({
      issuer,
      audience,
      privateKey,
      publicJwk: await exportJWK(publicKey),
      keyId,
    });
  }

  /** Loads a PKCS#8 EC P-256 key (PEM). The public half is derived, never configured separately. */
  static async fromPem(
    pem: string,
    keyId: string,
    issuer: string,
    audience: string,
  ): Promise<RunTokenIssuer> {
    const privateKey = await importPKCS8(pem, ALG, { extractable: true });
    const jwk = await exportJWK(privateKey);
    const { d: _d, ...publicJwk } = jwk;
    return new RunTokenIssuer({ issuer, audience, privateKey, publicJwk, keyId });
  }

  get jwks(): JSONWebKeySet {
    return {
      keys: [{ ...this.options.publicJwk, kid: this.options.keyId, alg: ALG, use: 'sig' }],
    };
  }

  async mint(claims: RunTokenClaims, ttlSeconds = RUN_TOKEN_MAX_TTL_SECONDS): Promise<string> {
    if (ttlSeconds > RUN_TOKEN_MAX_TTL_SECONDS || ttlSeconds <= 0) {
      throw new RunTokenError(
        `run token ttl ${ttlSeconds}s exceeds the ${RUN_TOKEN_MAX_TTL_SECONDS}s ceiling`,
        'ttl_exceeded',
      );
    }
    for (const [name, value] of Object.entries({
      agentId: claims.agentId,
      onBehalfOfUserId: claims.onBehalfOfUserId,
      tenantId: claims.tenantId,
      runId: claims.runId,
      machineId: claims.machineId,
    })) {
      if (!value) throw new RunTokenError(`run token claim "${name}" is empty`, 'claims_missing');
    }

    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      obo: claims.onBehalfOfUserId,
      tid: claims.tenantId,
      run: claims.runId,
      mid: claims.machineId,
      scope: [...new Set(claims.scopes)].sort().join(' '),
    })
      .setProtectedHeader({ alg: ALG, kid: this.options.keyId, typ: 'run+jwt' })
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setSubject(`agt:${claims.agentId}`)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + ttlSeconds)
      .setJti(randomBytes(16).toString('base64url'))
      .sign(this.options.privateKey);
  }
}

export interface RunTokenVerifierOptions {
  issuer: string;
  audience: string;
  jwks: JSONWebKeySet;
}

export class RunTokenVerifier {
  private readonly keys: ReturnType<typeof createLocalJWKSet>;

  constructor(private readonly options: RunTokenVerifierOptions) {
    this.keys = createLocalJWKSet(options.jwks);
  }

  async verify(token: string): Promise<VerifiedRunToken> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: [ALG],
        typ: 'run+jwt',
        clockTolerance: 5,
      }));
    } catch (cause) {
      const expired = (cause as { code?: string }).code === 'ERR_JWT_EXPIRED';
      throw new RunTokenError(
        expired ? 'run token expired' : 'run token failed verification',
        expired ? 'expired' : 'invalid',
        { cause },
      );
    }

    // Defence in depth: a token minted with a longer lifetime by a compromised or
    // misconfigured issuer is refused here too.
    if (
      typeof payload.exp !== 'number' ||
      typeof payload.iat !== 'number' ||
      payload.exp - payload.iat > RUN_TOKEN_MAX_TTL_SECONDS
    ) {
      throw new RunTokenError('run token lifetime exceeds the ceiling', 'ttl_exceeded');
    }

    const sub = payload.sub ?? '';
    const required = ['obo', 'tid', 'run', 'mid', 'scope'] as const;
    for (const name of required) {
      if (typeof payload[name] !== 'string') {
        throw new RunTokenError(`run token is missing claim "${name}"`, 'claims_missing');
      }
    }
    if (!sub.startsWith('agt:') || typeof payload.jti !== 'string') {
      throw new RunTokenError('run token subject is not an agent', 'invalid');
    }

    const scope = String(payload['scope']);
    return {
      agentId: sub.slice(4),
      onBehalfOfUserId: String(payload['obo']),
      tenantId: String(payload['tid']),
      runId: String(payload['run']),
      machineId: String(payload['mid']),
      scopes: scope ? scope.split(' ') : [],
      jti: payload.jti,
      expiresAt: new Date(payload.exp * 1000),
    };
  }
}

/** Throws unless every required scope is present. Wildcards are deliberately unsupported. */
export function requireScopes(token: Pick<VerifiedRunToken, 'scopes'>, required: string[]): void {
  const held = new Set(token.scopes);
  const missing = required.filter((s) => !held.has(s));
  if (missing.length > 0) {
    throw new RunTokenError(`run token lacks scope(s): ${missing.join(', ')}`, 'scope_missing');
  }
}
