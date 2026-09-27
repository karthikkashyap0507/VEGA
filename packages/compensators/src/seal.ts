import { createHash } from 'node:crypto';
import { openSecret, sealSecret } from '@vega/shared';
import { canonical } from './divergence.js';

/**
 * Compensation tokens and held artifacts carry content — the event as it was, the email about to
 * go out. They are envelope-encrypted like connector credentials (docs/module6.md §10 "token
 * confidentiality"): a fresh data key per value, wrapped by the KEK. Stored as JSON (the columns
 * are jsonb) holding only ciphertext.
 */
export interface SealedJson {
  v: 1;
  kms: string;
  dek: string;
  iv: string;
  tag: string;
  ct: string;
}

export function sealJson(value: unknown, kek?: Buffer): SealedJson {
  const s = sealSecret(JSON.stringify(value), kek);
  return { v: 1, kms: s.kmsKeyId, dek: s.wrappedDek.toString('base64'), iv: s.iv.toString('base64'), tag: s.authTag.toString('base64'), ct: s.ciphertext.toString('base64') };
}

export function openJson<T>(sealed: unknown, kek?: Buffer): T {
  const s = sealed as SealedJson;
  if (!s || s.v !== 1) throw new Error('not a sealed value');
  const plain = openSecret({ kmsKeyId: s.kms, wrappedDek: Buffer.from(s.dek, 'base64'), iv: Buffer.from(s.iv, 'base64'), authTag: Buffer.from(s.tag, 'base64'), ciphertext: Buffer.from(s.ct, 'base64') }, kek);
  return JSON.parse(plain.toString('utf8')) as T;
}

/** Content digest (canonical JSON): what the audit chain commits to instead of the plaintext. */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
