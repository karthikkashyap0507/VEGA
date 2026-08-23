import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { KeyFileError, loadKeyFile, parseKeyFile } from '../src/keyfile.js';

const dir = mkdtempSync(join(tmpdir(), 'vega-idp-'));

/** Zitadel emits PKCS#1 ("BEGIN RSA PRIVATE KEY"); jose wants PKCS#8. */
function makeKeyFile(name: string, format: 'pkcs1' | 'pkcs8', extra: object = {}) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: format === 'pkcs1' ? 'pkcs1' : 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      type: 'application',
      keyId: 'key-1',
      key: privateKey,
      appId: 'app-1',
      clientId: 'client-1',
      ...extra,
    }),
  );
  return path;
}

describe('key file parsing', () => {
  it('rejects malformed JSON', () => {
    expect(() => parseKeyFile('{not json')).toThrow(KeyFileError);
  });

  it('rejects a file with no key material', () => {
    expect(() => parseKeyFile(JSON.stringify({ type: 'application', keyId: 'k' }))).toThrow(
      /missing "key"/,
    );
  });

  it('rejects a value that is not a PEM private key', () => {
    expect(() =>
      parseKeyFile(JSON.stringify({ type: 'application', keyId: 'k', key: 'hunter2' })),
    ).toThrow(/PEM private key/);
  });

  it('rejects an unknown type', () => {
    expect(() =>
      parseKeyFile(JSON.stringify({ type: 'wat', keyId: 'k', key: 'PRIVATE KEY' })),
    ).toThrow(/unexpected key file type/);
  });

  it('gives an actionable error when the file is missing', async () => {
    await expect(loadKeyFile(join(dir, 'nope.json'))).rejects.toThrow(/infra\/docker\/secrets/);
  });
});

describe('key loading', () => {
  it.each(['pkcs1', 'pkcs8'] as const)('loads a %s key and signs with it', async (format) => {
    const path = makeKeyFile(`${format}.json`, format);
    const loaded = await loadKeyFile(path);

    expect(loaded.keyId).toBe('key-1');
    expect(loaded.clientId).toBe('client-1');

    // Prove the imported key actually signs — a format mishandled here would otherwise
    // surface as an opaque invalid_client against the live IdP.
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: loaded.keyId })
      .setIssuer(loaded.clientId)
      .setExpirationTime('1m')
      .sign(loaded.privateKey);
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('takes the client identity from the key file, not from configuration', async () => {
    // One artefact, one source of truth. A separately configured client id that drifts
    // produces invalid_client with nothing useful in the logs.
    const loaded = await loadKeyFile(makeKeyFile('ids.json', 'pkcs1', { clientId: 'from-file' }));
    expect(loaded.clientId).toBe('from-file');
  });

  it('falls back to userId for service-account keys', async () => {
    const path = join(dir, 'sa.json');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeFileSync(
      path,
      JSON.stringify({ type: 'serviceaccount', keyId: 'k', key: privateKey, userId: 'svc-1' }),
    );
    const loaded = await loadKeyFile(path);
    expect(loaded.clientId).toBe('svc-1');
    expect(loaded.type).toBe('serviceaccount');
  });
});
