import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope encryption for the secret vault (`secret_refs`).
 *
 * Built in Module 1 even though Module 2 is the first consumer, so that connector OAuth
 * tokens are not the thing that forces someone to write crypto under deadline.
 *
 * Shape:
 *   · a fresh 256-bit DEK per secret, used once with AES-256-GCM
 *   · the DEK is wrapped by a KEK and stored beside the ciphertext
 *   · the KEK never encrypts user data directly
 *
 * That indirection is what makes the KMS swap in §22.2 of TECHSTACK a one-function change:
 * `wrapDek`/`unwrapDek` become KMS Encrypt/Decrypt calls and nothing else moves. Local mode
 * exists for development only — a local KEK must never reach a deployed environment.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

export interface EnvelopeSecret {
  /** DEK encrypted under the KEK. */
  wrappedDek: Buffer;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /** Identifies the KEK, so rotation can find what needs rewrapping. */
  kmsKeyId: string;
}

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
  }
}

/** Reads the development KEK. Deployed environments use KMS instead — see §22.2. */
export function loadLocalKek(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env['LOCAL_KEK_BASE64'];
  if (!raw) {
    throw new CryptoError('LOCAL_KEK_BASE64 is not set (generate: openssl rand -base64 32)');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `LOCAL_KEK_BASE64 must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

function aesEncrypt(key: Buffer, plaintext: Buffer): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function aesDecrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, authTag: Buffer): Buffer {
  if (authTag.length !== TAG_BYTES) {
    throw new CryptoError(`invalid auth tag length: ${authTag.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    // GCM authentication failed: the ciphertext, IV, tag, or key has been altered.
    throw new CryptoError('decryption failed — ciphertext or key is not authentic', { cause });
  }
}

/**
 * Wraps a DEK under the KEK. In KMS mode this becomes a KMS Encrypt call.
 * The IV and tag are prefixed onto the wrapped blob so a single column stores it.
 */
function wrapDek(kek: Buffer, dek: Buffer): Buffer {
  const { ciphertext, iv, authTag } = aesEncrypt(kek, dek);
  return Buffer.concat([iv, authTag, ciphertext]);
}

function unwrapDek(kek: Buffer, wrapped: Buffer): Buffer {
  if (wrapped.length < IV_BYTES + TAG_BYTES) {
    throw new CryptoError('wrapped DEK is truncated');
  }
  const iv = wrapped.subarray(0, IV_BYTES);
  const authTag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = wrapped.subarray(IV_BYTES + TAG_BYTES);
  return aesDecrypt(kek, ciphertext, iv, authTag);
}

/** Encrypts a secret. The plaintext is never persisted, logged, or returned. */
export function sealSecret(
  plaintext: string | Buffer,
  kek: Buffer = loadLocalKek(),
  kmsKeyId = 'local',
): EnvelopeSecret {
  const dek = randomBytes(KEY_BYTES);
  try {
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const { ciphertext, iv, authTag } = aesEncrypt(dek, data);
    return { wrappedDek: wrapDek(kek, dek), ciphertext, iv, authTag, kmsKeyId };
  } finally {
    // Best-effort scrub. Node may have copied it, but leaving a live key in a reachable
    // buffer for the rest of the process lifetime is worse.
    dek.fill(0);
  }
}

export function openSecret(secret: EnvelopeSecret, kek: Buffer = loadLocalKek()): Buffer {
  const dek = unwrapDek(kek, secret.wrappedDek);
  try {
    return aesDecrypt(dek, secret.ciphertext, secret.iv, secret.authTag);
  } finally {
    dek.fill(0);
  }
}

export function openSecretAsString(secret: EnvelopeSecret, kek?: Buffer): string {
  return openSecret(secret, kek).toString('utf8');
}

/** Constant-time comparison, for anything that could otherwise leak by timing. */
export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
