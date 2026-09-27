import { createHash } from 'node:crypto';

/**
 * The WRITER's RFC 8785 (JCS) implementation. Written separately from @vega/verifier's on
 * purpose (module7.md §11: "independent implementation cross-check"): if the two ever disagree,
 * packs stop verifying — so both are held to the same golden vectors in CI.
 */

function escape(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else if (c >= 0xd800 && c <= 0xdfff) {
      // A surrogate: literal only as a well-formed pair (RFC 8785 §3.2.2.2 / ES2019 well-formed stringify).
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += s[i]! + s[i + 1]!;
        i++;
      } else out += `\\u${c.toString(16)}`;
    } else out += s[i];
  }
  return `${out}"`;
}

/** UTF-16 code unit order (RFC 8785 §3.2.3). */
function byCodeUnits(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function jcs(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite number');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') return escape(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const v of value) parts.push(v === undefined ? 'null' : jcs(v));
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    keys.sort(byCodeUnits);
    return `{${keys.map((k) => `${escape(k)}:${jcs(obj[k])}`).join(',')}}`;
  }
  throw new TypeError(`JCS: cannot canonicalize ${typeof value}`);
}

export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`;
export const sha256 = (data: string | Uint8Array): string => `sha256:${createHash('sha256').update(data).digest('hex')}`;

/** docs/module7.md §5.2 — the same rule the verifier publishes. */
export function chainHash(kind: string, ts: string, payload: Record<string, unknown>, prevHash: string, tenantId: string, seq: number): string {
  return sha256(`${jcs({ kind, ts, payload })}\n${prevHash}\n${tenantId}\n${seq}`);
}
