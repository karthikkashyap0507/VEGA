import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for short-lived browser state (the OIDC login round-trip).
 *
 * The login state — PKCE verifier, nonce, state, return path — must survive the redirect to
 * the IdP and back without a server-side store, and the browser must be able neither to read
 * the verifier nor to alter the return path. AES-256-GCM under a key derived (HKDF) from
 * SESSION_SECRET gives both, and a per-purpose `info` string means a sealed login state can
 * never be replayed as anything else.
 */
const IV = 12;
const TAG = 16;

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'gateway-sealed-v1', purpose, 32));
  }

  seal(value: unknown, ttlSeconds: number): string {
    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.from(JSON.stringify({ v: value, exp: Date.now() + ttlSeconds * 1000 }), 'utf8');
    const ct = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
  }

  /** Returns undefined for anything tampered, truncated, foreign, or expired. Never throws. */
  open<T>(sealed: string | undefined): T | undefined {
    if (!sealed) return undefined;
    try {
      const raw = Buffer.from(sealed, 'base64url');
      if (raw.length <= IV + TAG) return undefined;
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV));
      decipher.setAuthTag(raw.subarray(IV, IV + TAG));
      const body = Buffer.concat([decipher.update(raw.subarray(IV + TAG)), decipher.final()]);
      const parsed = JSON.parse(body.toString('utf8')) as { v: T; exp: number };
      if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return undefined;
      return parsed.v;
    } catch {
      return undefined;
    }
  }
}
