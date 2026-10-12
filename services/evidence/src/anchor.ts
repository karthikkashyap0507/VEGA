import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AnchorRow, EvidenceReader, EvidenceWriter } from '@vega/db/evidence';
import { messages, type KeyCustody } from './chain/keys.js';
import { MerkleTree } from './chain/merkle.js';
import type { SignedTreeHead } from './chain/pack.js';

/**
 * ANCHORING (module7.md §5.4). Periodically — hourly, and on demand — each tenant's log is
 * summarized as a signed tree head (size, RFC 6962 root, chain head) and published at
 * /.well-known/vega/anchors/<tenant>. Once a head is out in the world, rewriting history needs a
 * consistency proof that cannot exist; that is what proves *we* did not rewrite it, which a
 * signature alone cannot (whoever holds the key could re-sign a rewritten chain).
 *
 * With a TSA configured, each head is also timestamped (RFC 3161) by a third party: the token is
 * kept beside the head, and `openssl ts -verify` checks it with no help from us.
 */

export interface Timestamper {
  /** Which TSA (recorded as the head's external_ref). */
  readonly ref: string;
  /** An RFC 3161 TimeStampResp (DER, base64) over SHA-256(message). */
  stamp(message: Uint8Array): Promise<{ token: string }>;
}

export const toTreeHead = (a: AnchorRow): SignedTreeHead => ({
  tenantId: a.tenantId,
  treeSize: a.treeSize,
  rootHash: a.rootHash,
  chainHeadSeq: a.chainHeadSeq,
  chainHeadHash: a.chainHeadHash,
  anchoredAt: a.anchoredAt,
  method: a.method,
  externalRef: a.externalRef,
  keyId: a.keyId,
  signature: a.signature,
});

/** A per-tenant Merkle tree, rebuilt only when the log has grown (packs reuse it). */
class TreeCache {
  private readonly trees = new Map<string, MerkleTree>();
  async get(reader: EvidenceReader, tenantId: string, size?: number): Promise<MerkleTree> {
    const hit = this.trees.get(tenantId);
    if (hit && size !== undefined && hit.size >= size) return hit;
    const tree = new MerkleTree(await reader.leaves(tenantId));
    this.trees.set(tenantId, tree);
    if (size !== undefined && tree.size < size) throw new Error(`the log of ${tenantId} has ${tree.size} entries, fewer than ${size}`);
    return tree;
  }
}

export class Anchorer {
  private timer: NodeJS.Timeout | undefined;
  private readonly cache = new TreeCache();
  private running: Promise<void> | undefined;

  constructor(
    private readonly deps: {
      reader: EvidenceReader;
      writer: EvidenceWriter;
      custody: KeyCustody;
      timestamper?: Timestamper | undefined;
      log?: { info(o: object, m: string): void; error(o: object, m: string): void };
      now?: () => Date;
    },
  ) {}

  tree(tenantId: string, size?: number): Promise<MerkleTree> {
    return this.cache.get(this.deps.reader, tenantId, size);
  }

  /** Anchors the tenant's log as it stands now; returns the existing head if nothing changed. */
  async anchor(tenantId: string): Promise<SignedTreeHead | null> {
    const head = await this.deps.reader.head(tenantId);
    if (!head) return null;
    const [latest] = await this.deps.reader.anchors(tenantId, { limit: 1 });
    if (latest && latest.treeSize >= head.seq) return toTreeHead(latest);
    const tree = await this.tree(tenantId, head.seq);
    const size = head.seq;
    const leafHash = (await this.deps.reader.entryBySeq(tenantId, size))!.entryHash;
    const custody = this.deps.custody;
    const sth = {
      tenantId,
      treeSize: size,
      rootHash: tree.root(size),
      chainHeadSeq: size,
      chainHeadHash: leafHash,
      anchoredAt: (this.deps.now?.() ?? new Date()).toISOString(),
      method: this.deps.timestamper ? 'rfc3161' : 'published',
      externalRef: null as string | null,
      keyId: custody.keyId,
    };
    let token: string | null = null;
    if (this.deps.timestamper) {
      // The token is over exactly the message that gets signed, TSA reference included, so an
      // auditor checks both against the same bytes.
      sth.externalRef = this.deps.timestamper.ref;
      try {
        token = (await this.deps.timestamper.stamp(messages.treeHead(sth))).token;
      } catch (e) {
        // The head is still signed and published; the third-party timestamp is additive.
        this.deps.log?.error({ err: e, tenant_id: tenantId }, 'RFC 3161 timestamp failed; anchoring without it');
        sth.method = 'published';
        sth.externalRef = null;
      }
    }
    const signed: SignedTreeHead = { ...sth, signature: await custody.sign(messages.treeHead(sth)) };
    await this.deps.writer.insertAnchor({ ...signed, id: randomUUID(), externalRef: signed.externalRef ?? null, timestampToken: token });
    this.deps.log?.info({ tenant_id: tenantId, tree_size: size }, 'chain anchored');
    return signed;
  }

  async anchorAll(): Promise<number> {
    let n = 0;
    for (const t of await this.deps.reader.tenantsNeedingAnchor()) {
      try {
        if (await this.anchor(t)) n++;
      } catch (e) {
        this.deps.log?.error({ err: e, tenant_id: t, alert: true }, 'anchoring failed');
      }
    }
    return n;
  }

  /** Hourly by default (§5.4). One run at a time; a slow run is not stacked on. */
  start(intervalMs = 3_600_000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.running ??= this.anchorAll()
        .then(() => undefined)
        .finally(() => (this.running = undefined));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

// ------------------------------------------------------------------ RFC 3161 client

/** Minimal DER for a TimeStampReq (RFC 3161 §2.4.1) over a SHA-256 message imprint. */
export function timeStampRequest(message: Uint8Array, nonce: Buffer = randomBytes(8)): Buffer {
  const tlv = (tag: number, body: Buffer) => {
    const len = body.length < 0x80 ? Buffer.from([body.length]) : body.length < 0x100 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
    return Buffer.concat([Buffer.from([tag]), len, body]);
  };
  const SHA256_OID = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
  const algorithm = tlv(0x30, Buffer.concat([SHA256_OID, Buffer.from([0x05, 0x00])]));
  const imprint = tlv(0x30, Buffer.concat([algorithm, tlv(0x04, createHash('sha256').update(message).digest())]));
  const n = nonce[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), nonce]) : nonce;
  return tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([1])), imprint, tlv(0x02, n), Buffer.from([0x01, 0x01, 0xff])]));
}

/** PKIStatus of a TimeStampResp: 0 granted, 1 granted with mods; anything else is a refusal. */
export function timeStampStatus(resp: Buffer): number {
  // TimeStampResp ::= SEQUENCE { status PKIStatusInfo ::= SEQUENCE { status INTEGER, ... }, ... }
  let i = 0;
  const skipHeader = () => {
    i++;
    const l = resp[i++]!;
    if (l & 0x80) i += l & 0x7f;
  };
  skipHeader(); // outer SEQUENCE
  skipHeader(); // PKIStatusInfo SEQUENCE
  if (resp[i] !== 0x02) throw new Error('not a TimeStampResp');
  const len = resp[i + 1]!;
  return resp.subarray(i + 2, i + 2 + len).reduce((acc, b) => acc * 256 + b, 0);
}

/** A TSA over HTTP (`application/timestamp-query`). Configured by EVIDENCE_TSA_URL; off by default. */
export class HttpTimestamper implements Timestamper {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  get ref(): string {
    return this.url;
  }

  async stamp(message: Uint8Array): Promise<{ token: string }> {
    const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/timestamp-query' }, body: timeStampRequest(message) });
    if (!res.ok) throw new Error(`TSA answered HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const status = timeStampStatus(body);
    if (status > 1) throw new Error(`TSA refused the request (PKIStatus ${status})`);
    return { token: body.toString('base64') };
  }
}
