import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { canonicalize, utf8 } from './canonical.js';

/**
 * Signatures are ML-DSA-65 (FIPS 204), written "ML-DSA-65:<base64>". Every signed message is
 * domain-separated, so a signature over one kind of object can never be replayed as another:
 *
 *   entry     "vega-entry-v1"    LF entry_hash
 *   tree head "vega-sth-v1"      LF JCS(tree head without `signature`)
 *   manifest  "vega-manifest-v1" LF JCS(manifest without `signature`)
 */
export const ALG = 'ML-DSA-65';

export interface PublicKeyRecord {
  keyId: string;
  alg: typeof ALG;
  /** base64 */
  publicKey: string;
  notBefore: string;
  /** null while the key is current; historical keys stay published forever. */
  notAfter: string | null;
}

export const entryMessage = (entryHash: string) => utf8(`vega-entry-v1\n${entryHash}`);
export const treeHeadMessage = (sth: Record<string, unknown>) => utf8(`vega-sth-v1\n${canonicalize({ ...sth, signature: undefined })}`);
export const manifestMessage = (m: Record<string, unknown>) => utf8(`vega-manifest-v1\n${canonicalize({ ...m, signature: undefined })}`);

export const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function verifySignature(signature: string, message: Uint8Array, key: PublicKeyRecord): boolean {
  if (key.alg !== ALG || !signature.startsWith(`${ALG}:`)) return false;
  try {
    return ml_dsa65.verify(unb64(signature.slice(ALG.length + 1)), message, unb64(key.publicKey));
  } catch {
    return false;
  }
}

/** Was the key in force at `ts`? (A rotated key still verifies what it signed while current.) */
export const keyCovers = (key: PublicKeyRecord, ts: string) => ts >= key.notBefore && (key.notAfter === null || ts < key.notAfter);
