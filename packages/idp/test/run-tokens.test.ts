import { SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RUN_TOKEN_MAX_TTL_SECONDS,
  RunTokenError,
  RunTokenIssuer,
  RunTokenVerifier,
  requireScopes,
  type RunTokenClaims,
} from '../src/run-tokens.js';

const ISS = 'https://control.test/run-tokens';
const AUD = 'execution';

const claims: RunTokenClaims = {
  agentId: '0b8d3f5e-6f1f-4b7a-9f59-3c1c9e3e2a10',
  onBehalfOfUserId: '2f1b0e49-8f45-4d53-a0a5-5f9c6a7f9d11',
  tenantId: '7a2c1d33-2b6e-4a5f-8f2e-1c9d0b7a6e22',
  runId: 'run_abc',
  machineId: '392450646407643139',
  scopes: ['email.send', 'calendar.read', 'email.send'],
};

let issuer: RunTokenIssuer;
let verifier: RunTokenVerifier;

beforeAll(async () => {
  issuer = await RunTokenIssuer.ephemeral(ISS, AUD);
  verifier = new RunTokenVerifier({ issuer: ISS, audience: AUD, jwks: issuer.jwks });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('run tokens', () => {
  it('round-trips every claim the execution plane records', async () => {
    const token = await issuer.mint(claims);
    const v = await verifier.verify(token);
    expect(v).toMatchObject({
      agentId: claims.agentId,
      onBehalfOfUserId: claims.onBehalfOfUserId,
      tenantId: claims.tenantId,
      runId: claims.runId,
      machineId: claims.machineId,
      scopes: ['calendar.read', 'email.send'],
    });
    expect(v.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(RUN_TOKEN_MAX_TTL_SECONDS * 1000);
  });

  it('refuses to mint a token longer than 15 minutes', async () => {
    await expect(issuer.mint(claims, RUN_TOKEN_MAX_TTL_SECONDS + 1)).rejects.toMatchObject({
      code: 'ttl_exceeded',
    });
  });

  it('refuses to mint without both agent and on-behalf-of principal', async () => {
    await expect(issuer.mint({ ...claims, onBehalfOfUserId: '' })).rejects.toMatchObject({
      code: 'claims_missing',
    });
  });

  it('expires', async () => {
    const token = await issuer.mint(claims, 60);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'expired' });
  });

  it('rejects a token from a different issuer key', async () => {
    const other = await RunTokenIssuer.ephemeral(ISS, AUD);
    await expect(verifier.verify(await other.mint(claims))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects the wrong audience', async () => {
    const wrongAud = await RunTokenIssuer.ephemeral(ISS, 'evidence');
    const v = new RunTokenVerifier({ issuer: ISS, audience: AUD, jwks: wrongAud.jwks });
    await expect(v.verify(await wrongAud.mint(claims))).rejects.toBeInstanceOf(RunTokenError);
  });

  it('rejects a long-lived token even if correctly signed (defence in depth)', async () => {
    // Simulates a misconfigured issuer: sign directly with the same key, bypassing mint().
    const key = (issuer as unknown as { options: { privateKey: CryptoKey; keyId: string } }).options;
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ obo: 'u', tid: 't', run: 'r', mid: 'm', scope: '' })
      .setProtectedHeader({ alg: 'ES256', kid: key.keyId, typ: 'run+jwt' })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject('agt:x')
      .setIssuedAt(now)
      .setExpirationTime(now + 86_400)
      .setJti('j')
      .sign(key.privateKey);
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'ttl_exceeded' });
  });

  it('rejects a user access token presented as a run token (typ binding)', async () => {
    const key = (issuer as unknown as { options: { privateKey: CryptoKey; keyId: string } }).options;
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ obo: 'u', tid: 't', run: 'r', mid: 'm', scope: '' })
      .setProtectedHeader({ alg: 'ES256', kid: key.keyId })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject('agt:x')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti('j')
      .sign(key.privateKey);
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('scope checks are exact — no implied or wildcard scopes', async () => {
    const v = await verifier.verify(await issuer.mint(claims));
    expect(() => requireScopes(v, ['email.send'])).not.toThrow();
    expect(() => requireScopes(v, ['email.delete'])).toThrow(/lacks scope/);
    expect(() => requireScopes(v, ['email.*'])).toThrow(/lacks scope/);
  });
});
