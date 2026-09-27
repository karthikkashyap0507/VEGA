import { sha256 } from '@noble/hashes/sha2.js';

/**
 * RFC 6962 / RFC 9162 Merkle tree hashing and proof verification — the same tree Trillian and
 * Certificate Transparency use, so a proof here verifies with any CT-compatible tool.
 *
 *   leaf hash  = SHA-256(0x00 ‖ leaf data)        leaf data = the entry_hash's 32 raw bytes
 *   node hash  = SHA-256(0x01 ‖ left ‖ right)
 *
 * Leaf index i holds the tenant's entry with seq i + 1.
 */

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const leafHash = (data: Uint8Array): Uint8Array => sha256(cat(Uint8Array.of(0), data));
export const nodeHash = (l: Uint8Array, r: Uint8Array): Uint8Array => sha256(cat(Uint8Array.of(1), l, r));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The Merkle Tree Hash of a list of leaf hashes (RFC 6962 §2.1). Empty tree: SHA-256(""). */
export function rootOf(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array());
  if (leaves.length === 1) return leaves[0]!;
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return nodeHash(rootOf(leaves.slice(0, k)), rootOf(leaves.slice(k)));
}

/** RFC 9162 §2.1.3.2: does `proof` show leaf `index` (of a tree of `size`) under `root`? */
export function verifyInclusion(leaf: Uint8Array, index: number, size: number, proof: Uint8Array[], root: Uint8Array): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && eq(r, root);
}

/** RFC 9162 §2.1.4.2: is the tree of `size2` (`root2`) an append-only extension of `size1` (`root1`)? */
export function verifyConsistency(size1: number, size2: number, proof: Uint8Array[], root1: Uint8Array, root2: Uint8Array): boolean {
  if (!Number.isSafeInteger(size1) || !Number.isSafeInteger(size2) || size1 < 0 || size2 < size1) return false;
  if (size1 === size2) return proof.length === 0 && eq(root1, root2);
  if (size1 === 0) return proof.length === 0; // everything extends the empty tree
  let path = proof;
  if ((size1 & (size1 - 1)) === 0) path = [root1, ...proof]; // size1 is a power of two
  if (path.length === 0) return false;
  let fn = size1 - 1;
  let sn = size2 - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && eq(fr, root1) && eq(sr, root2);
}
