import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalize, utf8 } from './canonical.js';

/**
 * The chain's hash rules (docs/module7.md §5.2), exactly as published:
 *
 *   body          = { kind, ts, payload }                      (ts: RFC 3339, milliseconds, Z)
 *   payload_digest = "sha256:" hex( SHA-256( JCS(payload) ) )
 *   entry_hash    = "sha256:" hex( SHA-256( JCS(body) ‖ LF ‖ prev_hash ‖ LF ‖ tenant_id ‖ LF ‖ seq ) )
 *
 * `seq` is decimal, starting at 1 per tenant; the first entry's prev_hash is GENESIS. LF (0x0A)
 * cannot occur inside any of the four parts, so the concatenation is unambiguous.
 */
export const GENESIS = `sha256:${'0'.repeat(64)}`;

export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function unhex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new TypeError('not lower-case hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const sha256Hex = (data: Uint8Array | string): string => hex(sha256(typeof data === 'string' ? utf8(data) : data));
export const digestOf = (data: Uint8Array | string): string => `sha256:${sha256Hex(data)}`;

/** "sha256:<64 hex>" → the 32 raw bytes (the Merkle leaf data). */
export function digestBytes(d: string): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(d)) throw new TypeError(`not a sha256 digest: ${d.slice(0, 80)}`);
  return unhex(d.slice(7));
}

export interface EntryBody {
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
}

export const payloadDigest = (payload: unknown): string => digestOf(canonicalize(payload));

export function entryHash(body: EntryBody, prevHash: string, tenantId: string, seq: number): string {
  return digestOf(`${canonicalize({ kind: body.kind, ts: body.ts, payload: body.payload })}\n${prevHash}\n${tenantId}\n${seq}`);
}
