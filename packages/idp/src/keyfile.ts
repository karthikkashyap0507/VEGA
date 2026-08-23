import { readFileSync } from 'node:fs';
// jose 6 dropped the KeyLike alias and exports its own CryptoKey type. Using it keeps
// this package free of the DOM lib, which a backend package has no business pulling in.
import { importPKCS8, type CryptoKey } from 'jose';
import { createPrivateKey } from 'node:crypto';

/**
 * Zitadel application key file (JSON, downloaded once from the console).
 *
 * The file carries `clientId` and `appId` alongside the key, so the client identity is read
 * from the key itself rather than from a separate env var. One artefact, one source of truth —
 * a mismatched `ZITADEL_CLIENT_ID` otherwise surfaces as an opaque `invalid_client` at the
 * token endpoint with nothing useful in the logs.
 */

export interface ZitadelKeyFile {
  type: 'application' | 'serviceaccount';
  keyId: string;
  key: string;
  appId?: string;
  clientId?: string;
  userId?: string;
}

export interface LoadedKey {
  keyId: string;
  clientId: string;
  privateKey: CryptoKey;
  type: ZitadelKeyFile['type'];
}

export class KeyFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeyFileError';
  }
}

export function parseKeyFile(raw: string): ZitadelKeyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new KeyFileError('key file is not valid JSON', { cause });
  }

  const k = parsed as Partial<ZitadelKeyFile>;
  if (!k.keyId) throw new KeyFileError('key file is missing "keyId"');
  if (!k.key) throw new KeyFileError('key file is missing "key"');
  if (!k.key.includes('PRIVATE KEY')) {
    throw new KeyFileError('key file "key" does not contain a PEM private key');
  }
  if (k.type !== 'application' && k.type !== 'serviceaccount') {
    throw new KeyFileError(`unexpected key file type: ${String(k.type)}`);
  }
  return k as ZitadelKeyFile;
}

/**
 * Zitadel emits PKCS#1 ("BEGIN RSA PRIVATE KEY"); jose imports PKCS#8. Node's KeyObject
 * converts between them, so both forms are accepted rather than making the caller care.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (pem.includes('BEGIN PRIVATE KEY')) {
    return importPKCS8(pem, 'RS256');
  }
  const pkcs8 = createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString();
  return importPKCS8(pkcs8, 'RS256');
}

export async function loadKeyFile(path: string): Promise<LoadedKey> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new KeyFileError(
      `cannot read key file at ${path}. Download it from the Zitadel console and save it ` +
        `under infra/docker/secrets/ (gitignored).`,
      { cause },
    );
  }

  const file = parseKeyFile(raw);
  const clientId = file.clientId ?? file.userId;
  if (!clientId) {
    throw new KeyFileError('key file has neither "clientId" nor "userId"');
  }

  return {
    keyId: file.keyId,
    clientId,
    privateKey: await importPrivateKey(file.key),
    type: file.type,
  };
}
