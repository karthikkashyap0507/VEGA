/**
 * RFC 8785 — JSON Canonicalization Scheme (JCS).
 *
 * The bytes every hash in the chain commits to. The rules, as the verifier applies them:
 *
 *   · objects: members sorted by key, comparing UTF-16 code units; no whitespace anywhere
 *   · strings: ECMAScript JSON.stringify escaping (\" \\ \b \f \n \r \t, other controls as
 *     \u00xx lower-case hex, everything else literal UTF-8)
 *   · numbers: ECMAScript Number.prototype.toString (so 1e21, 0.1, -0 → 0); NaN/Infinity refused
 *   · arrays keep their order; `true`, `false`, `null` literal
 *   · an object member whose value is `undefined` is absent (as in JSON.stringify); `undefined`
 *     anywhere else is refused
 *
 * The evidence service's writer has its own, separately written implementation; both are held
 * to the same golden vectors (test/canonical.test.ts), so drift between them fails the build.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite numbers cannot be canonicalized');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS: ${typeof value} cannot be canonicalized`);
  }
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
