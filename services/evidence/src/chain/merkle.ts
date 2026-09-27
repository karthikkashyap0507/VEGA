import { createHash } from 'node:crypto';

/**
 * The WRITER's RFC 6962 Merkle tree over a tenant's entry hashes: roots, inclusion proofs and
 * consistency proofs. Independent of the verifier's code; the tests verify every proof this
 * produces with the verifier, for every leaf and size pair up to a few hundred.
 *
 * The tree is built level by level: pairs hash together, a lone last node is carried up
 * unchanged — which is exactly RFC 6962's split at the largest power of two.
 */
const H = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const LEAF = Buffer.from([0]);
const NODE = Buffer.from([1]);

export const leaf = (entryHash: string): Buffer => H(LEAF, Buffer.from(entryHash.replace(/^sha256:/, ''), 'hex'));

export class MerkleTree {
  /** levels[0] = leaf hashes; levels[k][i] = the hash of the complete subtree of 2^k leaves at i·2^k. */
  private readonly levels: Buffer[][];

  constructor(entryHashes: readonly string[]) {
    this.levels = [entryHashes.map(leaf)];
    while (this.levels.at(-1)!.length > 1) {
      const below = this.levels.at(-1)!;
      const up: Buffer[] = [];
      for (let i = 0; i < below.length; i += 2) up.push(i + 1 < below.length ? H(NODE, below[i]!, below[i + 1]!) : below[i]!);
      this.levels.push(up);
    }
  }

  get size(): number {
    return this.levels[0]!.length;
  }

  /** MTH(D[start:end]) — from the precomputed levels when the range is one complete subtree. */
  private mth(start: number, end: number): Buffer {
    const n = end - start;
    if (n === 0) return createHash('sha256').digest();
    if ((n & (n - 1)) === 0 && start % n === 0) return this.levels[Math.log2(n)]![start / n]!;
    if (n === 1) return this.levels[0]![start]!;
    let k = 1;
    while (k * 2 < n) k *= 2;
    return H(NODE, this.mth(start, start + k), this.mth(start + k, end));
  }

  /** The root of the first `size` leaves (default: all). */
  root(size = this.size): string {
    return `sha256:${this.mth(0, size).toString('hex')}`;
  }

  /** RFC 6962 §2.1.1 PATH(m, D[0:size]). */
  inclusion(index: number, size = this.size): string[] {
    if (index < 0 || index >= size || size > this.size) throw new RangeError('inclusion: index out of range');
    const path = (m: number, start: number, end: number): Buffer[] => {
      const n = end - start;
      if (n <= 1) return [];
      let k = 1;
      while (k * 2 < n) k *= 2;
      return m < k ? [...path(m, start, start + k), this.mth(start + k, end)] : [...path(m - k, start + k, end), this.mth(start, start + k)];
    };
    return path(index, 0, size).map((b) => b.toString('hex'));
  }

  /** RFC 6962 §2.1.2 PROOF(m, D[0:n]). */
  consistency(m: number, n = this.size): string[] {
    if (m < 0 || m > n || n > this.size) throw new RangeError('consistency: sizes out of range');
    if (m === 0 || m === n) return [];
    const sub = (mm: number, start: number, end: number, whole: boolean): Buffer[] => {
      const nn = end - start;
      if (mm === nn) return whole ? [] : [this.mth(start, end)];
      let k = 1;
      while (k * 2 < nn) k *= 2;
      return mm <= k ? [...sub(mm, start, start + k, whole), this.mth(start + k, end)] : [...sub(mm - k, start + k, end, false), this.mth(start, start + k)];
    };
    return sub(m, 0, n, true).map((b) => b.toString('hex'));
  }
}
