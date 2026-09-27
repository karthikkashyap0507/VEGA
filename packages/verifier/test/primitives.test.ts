import { describe, expect, it } from 'vitest';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { b64, canonicalize, entryMessage, hex, leafHash, rootOf, verifyInclusion, verifySignature, type PublicKeyRecord } from '../src/index.js';
import { bits, DOCUMENTS, NUMBERS } from './vectors.js';

describe('RFC 8785 canonicalization (golden vectors)', () => {
  it.each(NUMBERS)('number %s → %s', (b, want) => expect(canonicalize(bits(b))).toBe(want));
  it.each(DOCUMENTS.map((d) => [d.name, d] as const))('%s', (_n, d) => expect(canonicalize(d.value)).toBe(d.jcs));
  it('refuses what JSON cannot say', () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
    expect(() => canonicalize(() => 1)).toThrow();
  });
});

describe('RFC 6962 Merkle tree (Certificate Transparency reference vectors)', () => {
  const leaves = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map((h) => Uint8Array.from(Buffer.from(h, 'hex')));
  const roots = [
    '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
    'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
    'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
    'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
    '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
    'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
    '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
  ];
  it.each(roots.map((r, i) => [i + 1, r] as const))('the root of %i leaves', (n, want) => expect(hex(rootOf(leaves.slice(0, n).map(leafHash)))).toBe(want));
  it('an empty tree is SHA-256 of nothing', () => expect(hex(rootOf([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'));
  it('refuses an index outside the tree', () => {
    const l = leaves.map(leafHash);
    expect(verifyInclusion(l[0]!, 8, 8, [], rootOf(l))).toBe(false);
    expect(verifyInclusion(l[0]!, -1, 8, [], rootOf(l))).toBe(false);
  });
});

describe('ML-DSA-65 signatures', () => {
  const k = ml_dsa65.keygen(new Uint8Array(32).fill(3));
  const key: PublicKeyRecord = { keyId: 'k1', alg: 'ML-DSA-65', publicKey: b64(k.publicKey), notBefore: '2026-01-01T00:00:00.000Z', notAfter: null };
  const sig = `ML-DSA-65:${b64(ml_dsa65.sign(entryMessage('sha256:aa'), k.secretKey))}`;
  it('verifies what the key signed, and nothing else', () => {
    expect(verifySignature(sig, entryMessage('sha256:aa'), key)).toBe(true);
    expect(verifySignature(sig, entryMessage('sha256:ab'), key)).toBe(false);
    expect(verifySignature(sig.replace('ML-DSA-65', 'ECDSA'), entryMessage('sha256:aa'), key)).toBe(false);
    expect(verifySignature('ML-DSA-65:!!', entryMessage('sha256:aa'), key)).toBe(false);
    const other = ml_dsa65.keygen(new Uint8Array(32).fill(4));
    expect(verifySignature(sig, entryMessage('sha256:aa'), { ...key, publicKey: b64(other.publicKey) })).toBe(false);
  });
});
