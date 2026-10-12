import { digestBytes, entryHash, entryMessage, GENESIS, keyCovers, leafHash, payloadDigest, rootOf, treeHeadMessage, verifySignature, type PublicKeyRecord } from '@vega/verifier';
import type { EvidenceReader, EvidenceWriter } from '@vega/db/evidence';

/**
 * CONTINUOUS CHAIN VERIFICATION (module7.md §10, §11 — "P0 on failure"). Every tenant's chain is
 * re-checked from genesis with the PUBLISHED verifier's functions — not the writer's — so a bug
 * the writer shares with itself cannot hide: payload digests, entry hashes, the prev_hash links,
 * no gaps, and every published tree head against the root it claims.
 *
 * Signatures are the expensive part (ML-DSA-65); a scheduled run checks those of entries newer
 * than the last successful verification, an on-demand run (`full`) checks all of them.
 */

export interface ChainCheck {
  tenantId: string;
  ok: boolean;
  entries: number;
  headSeq: number | null;
  signaturesChecked: number;
  anchorsChecked: number;
  failures: Array<{ check: 'payload' | 'hash' | 'link' | 'gap' | 'signature' | 'anchor'; seq?: number; treeSize?: number; detail: string }>;
  checkedAt: string;
}

export class ChainVerifier {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: {
      reader: EvidenceReader;
      writer: EvidenceWriter;
      keys: () => Promise<PublicKeyRecord[]>;
      log?: { info(o: object, m: string): void; error(o: object, m: string): void };
      now?: () => Date;
    },
  ) {}

  async verify(tenantId: string, opts: { full?: boolean; record?: boolean } = {}): Promise<ChainCheck> {
    const keys = new Map((await this.deps.keys()).map((k) => [k.keyId, k]));
    const last = opts.full ? null : await this.deps.reader.lastVerification(tenantId);
    const signedFrom = last?.ok && last.headSeq ? last.headSeq + 1 : 1;
    const failures: ChainCheck['failures'] = [];
    const leaves: Uint8Array[] = [];
    let prev = GENESIS;
    let expected = 1;
    let sigs = 0;
    for await (const batch of this.deps.reader.scan({ tenantId })) {
      for (const e of batch) {
        if (e.seq !== expected) failures.push({ check: 'gap', seq: e.seq, detail: `expected seq ${expected}` });
        expected = e.seq + 1;
        if (payloadDigest(e.payload) !== e.payloadDigest) failures.push({ check: 'payload', seq: e.seq, detail: 'payload does not match payload_digest' });
        if (entryHash(e, e.prevHash, tenantId, e.seq) !== e.entryHash) failures.push({ check: 'hash', seq: e.seq, detail: 'entry does not hash to entry_hash' });
        if (e.prevHash !== prev) failures.push({ check: 'link', seq: e.seq, detail: 'prev_hash is not the previous entry_hash' });
        prev = e.entryHash;
        if (e.seq >= signedFrom) {
          sigs++;
          const k = keys.get(e.keyId);
          if (!k || !keyCovers(k, e.ts) || !verifySignature(e.signature, entryMessage(e.entryHash), k)) failures.push({ check: 'signature', seq: e.seq, detail: `signature invalid (key ${e.keyId})` });
        }
        leaves.push(leafHash(digestBytes(e.entryHash)));
        if (failures.length > 100) break;
      }
    }
    const anchors = await this.deps.reader.anchors(tenantId, { limit: opts.full ? 1000 : 24 });
    for (const a of anchors) {
      const k = keys.get(a.keyId);
      const { id: _id, timestampToken: _t, ...sth } = a;
      if (a.treeSize > leaves.length) failures.push({ check: 'anchor', treeSize: a.treeSize, detail: 'anchor is beyond the chain head' });
      else if (`sha256:${Buffer.from(rootOf(leaves.slice(0, a.treeSize))).toString('hex')}` !== a.rootHash) failures.push({ check: 'anchor', treeSize: a.treeSize, detail: 'the log no longer has the root this anchor published' });
      else if (!k || !verifySignature(a.signature, treeHeadMessage(sth as unknown as Record<string, unknown>), k)) failures.push({ check: 'anchor', treeSize: a.treeSize, detail: 'tree head signature invalid' });
    }
    const out: ChainCheck = {
      tenantId,
      ok: failures.length === 0,
      entries: leaves.length,
      headSeq: leaves.length ? expected - 1 : null,
      signaturesChecked: sigs,
      anchorsChecked: anchors.length,
      failures: failures.slice(0, 100),
      checkedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    };
    if (opts.record !== false) {
      await this.deps.writer.insertVerification({ tenantId, ok: out.ok, entries: out.entries, headSeq: out.headSeq, detail: { signaturesChecked: sigs, anchorsChecked: anchors.length, failures: out.failures, full: Boolean(opts.full) } });
    }
    if (!out.ok) this.deps.log?.error({ alert: true, severity: 'P0', tenant_id: tenantId, failures: out.failures.slice(0, 5) }, 'EVIDENCE CHAIN VERIFICATION FAILED');
    return out;
  }

  async verifyAll(): Promise<ChainCheck[]> {
    const out: ChainCheck[] = [];
    for (const t of await this.deps.reader.tenants()) out.push(await this.verify(t));
    return out;
  }

  start(intervalMs = 15 * 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.verifyAll().catch((e) => this.deps.log?.error({ err: e, alert: true }, 'chain verification job failed')), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
