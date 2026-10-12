import { randomUUID } from 'node:crypto';
import type { EvidenceReader, EvidenceWriter, SealedEntry } from '@vega/db/evidence';
import { chainHash, GENESIS_HASH, jcs, sha256 } from './canonical.js';
import { facetsOf } from './facets.js';
import { ALG, messages, type KeyCustody, type PublicKey } from './keys.js';
import type { ContentStore, ContentInput } from '../content.js';

/**
 * THE CHAIN SERVICE (module7.md §5.2, §8.1). Every entry, whoever sends it:
 *
 *   content objects → the content-addressed store (digests; the chain never holds plaintext)
 *   → per-tenant lock → head → seq = head + 1, prev_hash = head's entry_hash (GENESIS at 1)
 *   → entry_hash = SHA-256( JCS({kind, ts, payload}) ‖ LF ‖ prev_hash ‖ LF ‖ tenant ‖ LF ‖ seq )
 *   → ML-DSA-65 signature from the custodian → INSERT → commit → only then the 201
 *
 * The caller's action runs only after that 201 (fail closed, §8.1): an entry is durable and
 * signed before anything it describes can happen.
 */

export interface AppendInput {
  tenantId: string;
  source: string;
  kind: string;
  payload: Record<string, unknown>;
  content?: ContentInput[] | undefined;
}

export interface AppendResult {
  id: string;
  seq: number;
  ts: string;
  entryHash: string;
  contentDigests: string[];
}

export class ChainService {
  constructor(
    private readonly deps: {
      writer: EvidenceWriter;
      reader?: EvidenceReader | undefined;
      custody: KeyCustody;
      content?: ContentStore | undefined;
      now?: () => Date;
    },
  ) {}

  get custody(): KeyCustody {
    return this.deps.custody;
  }

  /**
   * Publishes the custodian's public key (idempotent). Keys are kept forever (§5.3). A ROTATED key
   * begins now — which ends its predecessor's term; the first key ever has no predecessor.
   */
  async register(): Promise<void> {
    const c = this.deps.custody;
    const existing = this.deps.reader ? await this.deps.reader.keys() : [];
    const mine = existing.find((k) => k.keyId === c.keyId);
    if (mine) {
      if (mine.publicKey !== c.publicKey) throw new Error(`key id ${c.keyId} is already published with a different public key; a new key needs a new id`);
      return;
    }
    const notBefore = existing.length ? (this.deps.now?.() ?? new Date()) : new Date(0);
    await this.deps.writer.insertKey({ keyId: c.keyId, alg: ALG, publicKey: c.publicKey, notBefore, custody: c.kind ?? 'local' });
  }

  async append(input: AppendInput): Promise<AppendResult> {
    const contentDigests: string[] = [];
    if (input.content?.length) {
      if (!this.deps.content) throw new Error('this evidence service has no content store; content cannot be accepted');
      for (const c of input.content) contentDigests.push(await this.deps.content.put(input.tenantId, c));
    }
    const ts = (this.deps.now?.() ?? new Date()).toISOString();
    const custody = this.deps.custody;
    const sealed = await this.deps.writer.appendEntry(input.tenantId, async (head): Promise<SealedEntry> => {
      const seq = head.seq + 1;
      const prevHash = head.entryHash ?? GENESIS_HASH;
      const entryHash = chainHash(input.kind, ts, input.payload, prevHash, input.tenantId, seq);
      return {
        id: randomUUID(),
        seq,
        ts,
        kind: input.kind,
        source: input.source,
        payload: input.payload,
        payloadDigest: sha256(jcs(input.payload)),
        prevHash,
        entryHash,
        signature: await custody.sign(messages.entry(entryHash)),
        keyId: custody.keyId,
        facets: facetsOf(input.kind, input.payload),
      };
    });
    return { id: sealed.id, seq: sealed.seq, ts: sealed.ts, entryHash: sealed.entryHash, contentDigests };
  }

  /** Every key ever used, with each term ending where the next begins (§5.3). */
  async publicKeys(): Promise<PublicKey[]> {
    if (!this.deps.reader) return [{ keyId: this.deps.custody.keyId, alg: ALG, publicKey: this.deps.custody.publicKey, notBefore: '2026-01-01T00:00:00.000Z', notAfter: null }];
    const rows = await this.deps.reader.keys();
    return rows.map((k, i) => ({ keyId: k.keyId, alg: ALG, publicKey: k.publicKey, notBefore: k.notBefore, notAfter: rows[i + 1]?.notBefore ?? null }));
  }
}
