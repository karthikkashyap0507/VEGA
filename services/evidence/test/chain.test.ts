import { describe, expect, it } from 'vitest';
import { canonicalize, digestBytes, entryHash, leafHash, rootOf, unhex, verifyConsistency, verifyInclusion } from '@vega/verifier';
import { chainHash, jcs, sha256 } from '../src/chain/canonical.js';
import { MerkleTree } from '../src/chain/merkle.js';
import { bits, DOCUMENTS, NUMBERS } from '../../../packages/verifier/test/vectors.js';

/**
 * The writer and the published verifier are two implementations of one specification. These
 * are the cross-checks module7.md §11 makes blocking: canonicalization (golden vectors, both
 * sides), the entry hash, and every Merkle proof the writer can produce.
 */

describe('the writer canonicalizes exactly like the verifier', () => {
  it.each(NUMBERS)('number %s → %s', (b, want) => expect(jcs(bits(b))).toBe(want));
  it.each(DOCUMENTS.map((d) => [d.name, d] as const))('%s', (_n, d) => expect(jcs(d.value)).toBe(d.jcs));
  it('random documents: the two implementations agree byte for byte', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const str = () => Array.from({ length: Math.floor(rnd() * 8) }, () => String.fromCharCode(Math.floor(rnd() * 0x2fff))).join('');
    const gen = (d: number): unknown => {
      const r = rnd();
      if (d > 3 || r < 0.3) return [null, true, false, rnd() * 1e6 - 5e5, Math.floor(rnd() * 1e9), str()][Math.floor(rnd() * 6)];
      if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 5) }, () => [str(), gen(d + 1)]));
    };
    for (let i = 0; i < 500; i++) {
      const v = gen(0);
      expect(jcs(v)).toBe(canonicalize(v));
    }
  });
  it('the entry hash is the published rule', () => {
    const payload = { a: 1, b: ['x'] };
    expect(chainHash('action.pre', '2026-09-27T10:00:00.000Z', payload, `sha256:${'0'.repeat(64)}`, 't1', 1)).toBe(entryHash({ kind: 'action.pre', ts: '2026-09-27T10:00:00.000Z', payload }, `sha256:${'0'.repeat(64)}`, 't1', 1));
  });
});

describe("the writer's Merkle proofs verify with the published verifier", () => {
  const hashes = Array.from({ length: 70 }, (_, i) => sha256(`entry ${i}`));
  const tree = new MerkleTree(hashes);
  it('roots agree for every size', () => {
    for (let n = 0; n <= hashes.length; n++) expect(tree.root(n)).toBe(`sha256:${Buffer.from(rootOf(hashes.slice(0, n).map((h) => leafHash(digestBytes(h))))).toString('hex')}`);
  });
  it('every inclusion proof, every size', () => {
    for (let n = 1; n <= hashes.length; n++) {
      const root = digestBytes(tree.root(n));
      for (let i = 0; i < n; i++) {
        expect(verifyInclusion(leafHash(digestBytes(hashes[i]!)), i, n, tree.inclusion(i, n).map(unhex), root), `leaf ${i} of ${n}`).toBe(true);
      }
    }
  });
  it('every consistency proof between sizes', () => {
    for (let n = 1; n <= 40; n++) {
      for (let m = 1; m <= n; m++) {
        expect(verifyConsistency(m, n, tree.consistency(m, n).map(unhex), digestBytes(tree.root(m)), digestBytes(tree.root(n))), `${m} → ${n}`).toBe(true);
      }
    }
  });
  it('a proof for the wrong leaf, index or root does not verify', () => {
    const root = digestBytes(tree.root(50));
    const p = tree.inclusion(17, 50).map(unhex);
    expect(verifyInclusion(leafHash(digestBytes(hashes[18]!)), 17, 50, p, root)).toBe(false);
    expect(verifyInclusion(leafHash(digestBytes(hashes[17]!)), 16, 50, p, root)).toBe(false);
    expect(verifyInclusion(leafHash(digestBytes(hashes[17]!)), 17, 50, p, digestBytes(tree.root(49)))).toBe(false);
    // A rewritten history is not consistent with the tree head it claims to extend.
    const forged = new MerkleTree([...hashes.slice(0, 10), sha256('forged'), ...hashes.slice(11, 50)]);
    expect(verifyConsistency(20, 50, forged.consistency(20, 50).map(unhex), digestBytes(tree.root(20)), digestBytes(forged.root(50)))).toBe(false);
  });
});
