import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RunTokenIssuer } from '@vega/idp';
import type { Logger } from '@vega/shared';

/**
 * The run-token signing key (module1.md §5.5: "runs receive a short-lived (≤15 min),
 * scope-limited token minted per run"). The control plane holds the private key and mints;
 * the execution plane holds only the public JWKS and verifies.
 *
 * Deployed: RUN_TOKEN_KEY_PATH is a PKCS#8 P-256 key mounted from the secret store, and the
 * JWKS reaches execution the same way. Development: a key is generated on first start into
 * infra/docker/secrets (gitignored), with the JWKS beside it for the local execution process.
 */

export const RUN_TOKEN_ISSUER = 'vega-control';
export const RUN_TOKEN_AUDIENCE = 'vega-execution';

export async function loadRunTokenIssuer(env: NodeJS.ProcessEnv, log: Logger, production: boolean): Promise<RunTokenIssuer | undefined> {
  const keyPath = env['RUN_TOKEN_KEY_PATH'] ?? './infra/docker/secrets/run-token-key.pem';
  const jwksPath = env['RUN_TOKEN_JWKS_PATH'] ?? './infra/docker/secrets/run-token-jwks.json';
  const issuerName = env['RUN_TOKEN_ISSUER'] ?? RUN_TOKEN_ISSUER;
  // Deployed: the key arrives in the environment from the secret store (never a file in the image).
  if (env['RUN_TOKEN_KEY_PEM']) {
    const pem = env['RUN_TOKEN_KEY_PEM'].replace(/\\n/g, '\n');
    return RunTokenIssuer.fromPem(pem, `run-${createHash('sha256').update(pem).digest('hex').slice(0, 12)}`, issuerName, RUN_TOKEN_AUDIENCE);
  }
  if (!existsSync(keyPath)) {
    if (production) throw new Error(`run token signing key not found at ${keyPath}`);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    log.warn({ keyPath }, 'DEV: generated a run-token signing key; deployed environments mount one from the secret store');
  }
  const pem = readFileSync(keyPath, 'utf8');
  const kid = `run-${createHash('sha256').update(pem).digest('hex').slice(0, 12)}`;
  const issuer = await RunTokenIssuer.fromPem(pem, kid, issuerName, RUN_TOKEN_AUDIENCE);
  const jwks = JSON.stringify(issuer.jwks, null, 2);
  if (!production && (!existsSync(jwksPath) || readFileSync(jwksPath, 'utf8') !== jwks)) {
    mkdirSync(dirname(jwksPath), { recursive: true });
    writeFileSync(jwksPath, jwks);
  }
  return issuer;
}
