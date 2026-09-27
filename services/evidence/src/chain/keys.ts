import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { jcs } from './canonical.js';

/**
 * KEY CUSTODY (module7.md §5.3). The signing key never leaves its custodian; callers get a
 * `sign()` and a public key record. Deployed, the custodian is a KMS/HSM adapter (the
 * deliberate non-OSS exception, TECHSTACK §22.2) whose IAM the execution plane is not granted.
 * Locally, `LocalKeyCustody` holds an ML-DSA-65 key derived from a 32-byte seed kept in a
 * secret the execution plane never mounts.
 */
export const ALG = 'ML-DSA-65' as const;

export interface PublicKey {
  keyId: string;
  alg: typeof ALG;
  publicKey: string;
  notBefore: string;
  notAfter: string | null;
}

export interface KeyCustody {
  readonly keyId: string;
  readonly publicKey: string;
  sign(message: Uint8Array): Promise<string>;
}

const enc = new TextEncoder();
export const messages = {
  entry: (entryHash: string) => enc.encode(`vega-entry-v1\n${entryHash}`),
  treeHead: (sth: Record<string, unknown>) => enc.encode(`vega-sth-v1\n${jcs({ ...sth, signature: undefined })}`),
  manifest: (m: Record<string, unknown>) => enc.encode(`vega-manifest-v1\n${jcs({ ...m, signature: undefined })}`),
};

export class LocalKeyCustody implements KeyCustody {
  private readonly secretKey: Uint8Array;
  readonly publicKey: string;

  constructor(
    readonly keyId: string,
    seedHex: string,
  ) {
    if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error('the evidence signing seed must be 32 bytes of hex');
    const k = ml_dsa65.keygen(Uint8Array.from(Buffer.from(seedHex, 'hex')));
    this.secretKey = k.secretKey;
    this.publicKey = Buffer.from(k.publicKey).toString('base64');
  }

  async sign(message: Uint8Array): Promise<string> {
    return `${ALG}:${Buffer.from(ml_dsa65.sign(message, this.secretKey)).toString('base64')}`;
  }
}
