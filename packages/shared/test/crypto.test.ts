import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  openSecret,
  openSecretAsString,
  safeEqual,
  sealSecret,
} from '../src/crypto.js';

const KEK = randomBytes(32);

describe('envelope encryption', () => {
  it('round-trips a secret', () => {
    const sealed = sealSecret('ya29.a0AfB_byC-oauth-token', KEK);
    expect(openSecretAsString(sealed, KEK)).toBe('ya29.a0AfB_byC-oauth-token');
  });

  it('never stores the plaintext in the sealed structure', () => {
    const plaintext = 'CANARY-refresh-token-9f2a';
    const sealed = sealSecret(plaintext, KEK);
    const blob = Buffer.concat([
      sealed.ciphertext,
      sealed.wrappedDek,
      sealed.iv,
      sealed.authTag,
    ]).toString('binary');
    expect(blob).not.toContain(plaintext);
  });

  it('uses a fresh DEK and IV per secret', () => {
    const a = sealSecret('same-plaintext', KEK);
    const b = sealSecret('same-plaintext', KEK);
    // Identical input must not produce identical ciphertext, or equal secrets are linkable.
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it('rejects a wrong KEK', () => {
    const sealed = sealSecret('secret', KEK);
    expect(() => openSecret(sealed, randomBytes(32))).toThrow(CryptoError);
  });

  it('detects tampering with the ciphertext', () => {
    const sealed = sealSecret('secret-value-here', KEK);
    sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 0xff;
    // GCM is authenticated: a flipped bit must fail, not decrypt to garbage.
    expect(() => openSecret(sealed, KEK)).toThrow(/not authentic/);
  });

  it('detects tampering with the auth tag', () => {
    const sealed = sealSecret('secret-value-here', KEK);
    sealed.authTag[0] = sealed.authTag[0]! ^ 0xff;
    expect(() => openSecret(sealed, KEK)).toThrow(CryptoError);
  });

  it('detects tampering with the wrapped DEK', () => {
    const sealed = sealSecret('secret-value-here', KEK);
    sealed.wrappedDek[sealed.wrappedDek.length - 1] ^= 0xff;
    expect(() => openSecret(sealed, KEK)).toThrow(CryptoError);
  });

  it('rejects a truncated wrapped DEK', () => {
    const sealed = sealSecret('secret', KEK);
    sealed.wrappedDek = sealed.wrappedDek.subarray(0, 4);
    expect(() => openSecret(sealed, KEK)).toThrow(/truncated/);
  });

  it('handles binary payloads', () => {
    const payload = randomBytes(4096);
    const sealed = sealSecret(payload, KEK);
    expect(openSecret(sealed, KEK).equals(payload)).toBe(true);
  });

  it('records which key wrapped the DEK, so rotation can find it', () => {
    expect(sealSecret('x', KEK, 'kms:eu-west-1:key-7').kmsKeyId).toBe('kms:eu-west-1:key-7');
  });
});

describe('safeEqual', () => {
  it('compares equal values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });
  it('rejects different values and lengths without throwing', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
